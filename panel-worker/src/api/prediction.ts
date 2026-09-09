// Port wrapper prediksi V6Core.gs (getPredictionStatusData / generatePredictionCopyBundle /
// generateClosingPredictionCopy / sendPredictionAuto / sendClosingPredictionAuto) + router auto-post.
import { requireSession } from "./auth";
import { getUserProfile } from "../lib/db";
import { getSiteAccount } from "../lib/site";
import { logActivity } from "../lib/activity";
import {
	JADWAL_PREDIKSI_CONFIG,
	CLOSING_PREDICTION_SLOTS,
	CLOSING_PREDICTION_NAME,
	predictionScheduleId,
	closingScheduleId,
	normalizeClosingSlot,
	getActiveClosingSlot,
	predictionTodayKey,
	getOrCreateDailyPredictionContents,
	getPredictionStatusDataInternal,
	generatePredictionCopyBundleInternal,
	generateClosingPredictionCopyInternal,
	buildClosingPredictionMessage,
	validatePredictionContext,
	sendPredictionJob,
} from "../lib/prediction";
import { listActiveSessions } from "../lib/session";

const now7 = () => new Date(Date.now() + 7 * 60 * 60 * 1000);

export async function getPredictionStatusData(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	return getPredictionStatusDataInternal(env, s.profile);
}

export async function generatePredictionCopyBundle(env: Env, index: number, token: string) {
	const s = await requireSession(env, token);
	return generatePredictionCopyBundleInternal(env, Number(index), s.profile);
}

export async function generateClosingPredictionCopy(env: Env, token: string, slot: string) {
	const s = await requireSession(env, token);
	return generateClosingPredictionCopyInternal(s.profile, String(slot || ""));
}

export async function sendPredictionAuto(env: Env, index: number, token: string, onlyWebsites?: string[]) {
	const s = await requireSession(env, token);
	const scheduleIndex = Number(index);
	const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
	if (!config) {
		return { success: false, blocked: true, message: "Jadwal prediksi tidak ditemukan.", websiteResults: [], kind: "schedule" };
	}
	const ctx = validatePredictionContext(s.profile, onlyWebsites ?? null);
	if (ctx.error) return { success: false, blocked: true, message: ctx.error, websiteResults: [], kind: "schedule" };

	const contents = await getOrCreateDailyPredictionContents(env, scheduleIndex, ctx.websites!);
	return sendPredictionJob({
		env,
		username: s.username,
		websites: ctx.websites!,
		scheduleId: predictionScheduleId(scheduleIndex),
		predictionName: config.nama,
		predictionIndex: scheduleIndex,
		kind: "schedule",
		logAction: "KIRIM PREDIKSI AUTO",
		messageForWebsite: (w) => String(contents[w.toUpperCase()] || ""),
	});
}

export async function sendClosingPredictionAuto(env: Env, token: string, onlyWebsites: string[] | undefined, slot: string) {
	const s = await requireSession(env, token);
	const activeSlot = normalizeClosingSlot(String(slot || ""));
	const ctx = validatePredictionContext(s.profile, onlyWebsites ?? null);
	if (ctx.error) return { success: false, blocked: true, message: ctx.error, websiteResults: [], kind: "closing" };
	return sendPredictionJob({
		env,
		username: s.username,
		websites: ctx.websites!,
		scheduleId: closingScheduleId(activeSlot),
		predictionName: CLOSING_PREDICTION_NAME + " · " + activeSlot,
		predictionIndex: -1,
		kind: "closing",
		activeSlot,
		logAction: "KIRIM PENUTUP PREDIKSI AUTO",
		messageForWebsite: (w) => buildClosingPredictionMessage(w, now7(), activeSlot),
	});
}

// ---------------------------------------------------------------------------
// Auto-post router (dipakai Cron Trigger + tombol admin "JALANKAN SEKARANG")
// ---------------------------------------------------------------------------
const CATCHUP_MINUTES = 25; // susulan maksimal 25 menit dari jam sesi
const GUARD_TTL = 21600; // 6 jam

async function isAutoPostEnabled(env: Env): Promise<boolean> {
	const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'autopost_enabled'`).first<{ value: string }>();
	return String(r?.value ?? "TRUE").toUpperCase().trim() !== "FALSE";
}

async function activeSessionUsernames(env: Env): Promise<string[]> {
	// Dari D1, bukan SESS.list — dipanggil tiap tick cron auto-post; kuota KV
	// list Free cuma 1000/hari (dulu jebol tiap sore -> daftar sesi kosong).
	return (await listActiveSessions(env)).map((g) => g.username);
}

async function autoPostWebsites(env: Env, usernames: string[]): Promise<string[]> {
	const set: Record<string, boolean> = {};
	for (const u of usernames) {
		const p = await getUserProfile(env, u);
		if (!p || !p.permissions.telegram) continue;
		for (const w of p.websites || []) {
			const site = String(w || "").trim().toUpperCase();
			if (site) set[site] = true;
		}
	}
	// PENTING: hanya sertakan website yang PUNYA Telegram Prediksi (tg_pred_*).
	// Website tanpa config (mis. HELEN) kalau ikut -> selalu GAGAL -> guard slot
	// tidak pernah terkunci -> router retry tiap menit sepanjang window (boros).
	const eligible: string[] = [];
	for (const site of Object.keys(set)) {
		const acc = await getSiteAccount(env, site);
		if (acc && acc.telegramPred.token && acc.telegramPred.chatId) eligible.push(site);
	}
	return eligible;
}

function slotDue(nowMinutes: number, slotMinutes: number, windowMinutes?: number): boolean {
	const diff = nowMinutes - slotMinutes;
	const maxAfter = windowMinutes != null && windowMinutes > 0 ? windowMinutes : CATCHUP_MINUTES;
	return diff >= -1 && diff <= maxAfter && nowMinutes <= 1435;
}

export async function runAutoPostRouter(env: Env, opts: { force?: boolean; windowMinutes?: number } = {}) {
	const summary = { ran: false, slots: 0, sent: 0, already: 0, failed: 0, message: "" };
	if (!(await isAutoPostEnabled(env))) {
		summary.message = "Auto Posting dimatikan (Settings: autopost_enabled = FALSE).";
		return summary;
	}
	const usernames = await activeSessionUsernames(env);
	if (!usernames.length) {
		summary.message = "Tidak ada user yang sedang login, jadi tidak ada yang diposting.";
		return summary;
	}
	const websites = await autoPostWebsites(env, usernames);
	if (!websites.length) {
		summary.message = "Tidak ada user login yang punya izin Telegram + website.";
		return summary;
	}

	const d = now7();
	const nowMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
	const dateKey = predictionTodayKey();

	// KUNCI ANTI-TUMPANG-TINDIH: cron eksternal memanggil endpoint ini tiap menit.
	// Kalau satu run belum selesai (Telegram lambat) dan run berikutnya sudah masuk,
	// dua-duanya bisa memproses slot yang sama SEBELUM guard slot terkunci -> pesan
	// penutup / prediksi terkirim DOBEL. Lock ini (KV, TTL 3 menit) mencegah itu.
	const RUN_LOCK = "autopost:router:running";
	if (!opts.force) {
		try {
			if (await env.SESS.get(RUN_LOCK)) {
				summary.message = "Router auto-post lain masih berjalan — tick ini dilewati.";
				return summary;
			}
			await env.SESS.put(RUN_LOCK, String(Date.now()), { expirationTtl: 180 });
		} catch {
			/* KV error -> lanjut tanpa lock (lebih baik jalan daripada macet) */
		}
	}

	const runSlot = async (guardKey: string, job: () => Promise<{ counters?: { success?: number; already?: number; failed?: number }; pendingWebsites?: string[] }>) => {
		if (!opts.force) {
			const g = await env.SESS.get(guardKey);
			if (g) return;
		}
		let res;
		try {
			res = await job();
		} catch {
			return;
		}
		summary.ran = true;
		summary.slots++;
		summary.sent += Number(res?.counters?.success || 0);
		summary.already += Number(res?.counters?.already || 0);
		summary.failed += Number(res?.counters?.failed || 0);
		const hadFailure = !res || !res.counters || (res.pendingWebsites || []).length > 0;
		if (!hadFailure) {
			await env.SESS.put(guardKey, "1", { expirationTtl: GUARD_TTL });
			return;
		}
		// Masih ada yang gagal: coba lagi tick berikutnya, TAPI batasi 3x supaya tidak
		// spam kirim/log tiap menit sepanjang window catch-up.
		const attKey = guardKey + ":att";
		const att = Number((await env.SESS.get(attKey)) || 0) + 1;
		if (att >= 3) {
			await env.SESS.put(guardKey, "1", { expirationTtl: GUARD_TTL });
			await env.SESS.delete(attKey);
		} else {
			await env.SESS.put(attKey, String(att), { expirationTtl: GUARD_TTL });
		}
	};

	for (let index = 0; index < JADWAL_PREDIKSI_CONFIG.length; index++) {
		const [hh, mm] = JADWAL_PREDIKSI_CONFIG[index].jam.split(":").map(Number);
		if (!slotDue(nowMinutes, hh * 60 + mm, opts.windowMinutes)) continue;
		const scheduleId = predictionScheduleId(index);
		await runSlot(`autopost:${dateKey}:${scheduleId}`, async () => {
			const config = JADWAL_PREDIKSI_CONFIG[index];
			const contents = await getOrCreateDailyPredictionContents(env, index, websites);
			return sendPredictionJob({
				env,
				username: "AUTO",
				websites,
				dateKey,
				scheduleId,
				predictionName: config.nama,
				predictionIndex: index,
				kind: "schedule",
				logAction: "KIRIM PREDIKSI AUTO",
				messageForWebsite: (w) => String(contents[w.toUpperCase()] || ""),
			});
		});
	}

	for (const slot of CLOSING_PREDICTION_SLOTS) {
		const [hh, mm] = slot.split(":").map(Number);
		if (!slotDue(nowMinutes, hh * 60 + mm, opts.windowMinutes)) continue;
		await runSlot(`autopost:${dateKey}:${closingScheduleId(slot)}`, () =>
			sendPredictionJob({
				env,
				username: "AUTO",
				websites,
				dateKey,
				scheduleId: closingScheduleId(slot),
				predictionName: CLOSING_PREDICTION_NAME + " · " + slot,
				predictionIndex: -1,
				kind: "closing",
				activeSlot: slot,
				logAction: "KIRIM PENUTUP PREDIKSI AUTO",
				messageForWebsite: (w) => buildClosingPredictionMessage(w, now7(), slot),
			}),
		);
	}

	if (!opts.force) {
		try {
			await env.SESS.delete(RUN_LOCK);
		} catch {
			/* biarkan TTL 3 menit yang membersihkan */
		}
	}

	summary.message = summary.ran
		? `${summary.slots} sesi diproses — terkirim ${summary.sent}, sudah ada ${summary.already}, gagal ${summary.failed}`
		: "Belum ada sesi jam yang jatuh tempo untuk disusulkan saat ini.";
	return summary;
}

// --- tombol admin ---------------------------------------------------------
export async function adminRunAutoPostNow(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	const result = await runAutoPostRouter(env, { force: true });
	await logActivity(
		env,
		s.username,
		"AUTO POST MANUAL",
		result.message || "Router auto posting dijalankan manual.",
		result.failed ? "SEBAGIAN" : "BERHASIL",
		"",
	);
	return { success: true, message: result.message || "Router dijalankan. Cek menu Aktivitas / Telegram." };
}

export async function setupAutoPostTriggers(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	await env.DB.prepare(
		`INSERT INTO settings (key, value) VALUES ('autopost_enabled','TRUE')
		 ON CONFLICT(key) DO UPDATE SET value = 'TRUE'`,
	).run();
	await logActivity(env, s.username, "AUTO POSTING", "Auto posting prediksi diaktifkan", "BERHASIL", "");
	return {
		success: true,
		installed: true,
		enabled: true,
		message:
			"Auto Posting Prediksi AKTIF. Penjadwalan dijalankan oleh cron eksternal yang memanggil " +
			"/__cron?job=autopost tiap menit (lihat tombol URL CRON). Butuh minimal 1 operator login saat jam sesi.",
	};
}

export async function adminGetAutoPostWebhook(env: Env, token: string, origin?: string) {
	await requireSession(env, token, { admin: true });
	const slots = Array.from(
		new Set(JADWAL_PREDIKSI_CONFIG.map((x) => x.jam).concat(CLOSING_PREDICTION_SLOTS)),
	).sort();
	const base = String(origin || "").replace(/\/+$/, "");
	const key = env.CRON_KEY || "";
	return {
		success: true,
		url: base && key ? `${base}/__cron?key=${key}&job=autopost` : "",
		urlInvest: base && key ? `${base}/__cron?key=${key}&job=invest` : "",
		slots,
		timezone: "GMT+7 (WIB)",
		everyMinute: true,
		message:
			"Pasang di cron-job.org / GitHub Actions: panggil URL di atas dengan method GET tiap 1 menit. " +
			"Router cek sendiri slot mana yang jatuh tempo (toleransi susulan 90 menit).",
	};
}

export const PREDICTION_SLOTS_INFO = { JADWAL_PREDIKSI_CONFIG, CLOSING_PREDICTION_SLOTS, getActiveClosingSlot };
