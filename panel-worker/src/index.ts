// KD-Group Panel — Cloudflare Worker (port dari Apps Script).
// Semua panggilan frontend lama google.script.run.<fn>(...) dipetakan ke
// POST /api  body: { "action": "<fn>", ...args }
import { CORS_HEADERS, json } from "./lib/respond";
import { loadSession, migrateKvSessionsOnce, pruneExpiredSessions } from "./lib/session";
import { getTurso } from "./lib/turso";
import { checkLogin, logout, resumeSession } from "./api/auth";
import { getBootstrapData, getDashboard } from "./api/dashboard";
import { logClientActivity } from "./api/activity";
import { retryFailedSystem, sendToPanelZOnly, smartAutoSendFast } from "./api/send";
import {
	adminDeleteUser,
	adminListActiveSessions,
	adminListUsers,
	adminPruneActivityLog,
	adminResetUserLock,
	adminSaveUser,
	adminSetAutoPost,
	adminSetLogRetention,
	pruneActivityLogCron,
} from "./api/admin";
import { adminDeleteSite, adminListSites, adminSaveSite } from "./api/sites";
import { setMaintenance } from "./api/settings";
import { getCurrentUserProfile, getLivePanelData } from "./api/live";
import {
	adminGetAutoPostWebhook,
	adminRunAutoPostNow,
	generateClosingPredictionCopy,
	generatePredictionCopyBundle,
	getPredictionStatusData,
	runAutoPostRouter,
	sendClosingPredictionAuto,
	sendPredictionAuto,
	setupAutoPostTriggers,
} from "./api/prediction";
import {
	investContinueScan,
	investGetConfig,
	investGetStatus,
	investGetWarnings,
	investResetScan,
	investSaveConfig,
	investStartScan,
	investTestSession,
} from "./api/invest";
import { investPump, investPumpUser } from "./lib/invest-scan";
import { investGetState } from "./lib/invest";
import { pgaPendingStatus, pgaPendingSync } from "./api/pga-pending";
import { wdListedCheck, wdListedGetList, wdListedRemove, wdListedSync } from "./api/wd-listed";
import {
	lapAdminStatus,
	lapGetConfig,
	lapJobResult,
	lapJobStart,
	lapMotionImport,
	lapMozartImport,
	lapRunAdmin,
	lapRunMozart,
	lapSaveConfig,
} from "./api/lap";
import {
	botFbRunNow,
	botFbTemplateGenerate,
	botNewsAddSource,
	dispatchNewsTurbo,
	botNewsDeleteSource,
	botNewsGithubRunStatus,
	botNewsRunNow,
	botNewsRunSiteNow,
	botNewsRunViaGithub,
	botNewsSaveConfig,
	botNewsSkip,
	botNewsStatus,
	botNewsToggleSource,
} from "./api/bot";
import { botNewsRun, disableGnewsSources, fbDirectRun, newsPruneQueueDaily, newsPullSources, publicNewsBanner, publicNewsDetail, publicNewsList, publicNewsPopular, publicNewsRandom, publicNewsSitemapXml, seedCategorySources } from "./lib/bot-news";
import {
	livechatBotPull,
	livechatBotReport,
	livechatBotSync,
	livechatDeleteTemplate,
	livechatListSessions,
	livechatListTemplates,
	livechatRecentLogs,
	livechatSaveTemplate,
	livechatSetBotEnabled,
} from "./api/livechat";

type Handler = (env: Env, body: Record<string, unknown>) => Promise<unknown>;
const s = (v: unknown) => String(v ?? "");

// Pangkas Activity Log sekali per hari WIB (dikunci lewat KV).
// Pangkas Activity Log sekali per hari WIB (dikunci lewat KV).
async function dailyPrune(env: Env): Promise<number | "skip"> {
	await migrateKvSessionsOnce(env);
	const dayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
	const guard = "retention:" + dayKey;
	try {
		if (await env.SESS.get(guard)) return "skip";
		await env.SESS.put(guard, "1", { expirationTtl: 172800 });
	} catch {
		/* lanjut */
	}
	await pruneExpiredSessions(env).catch(() => {});
	return pruneActivityLogCron(env).catch(() => 0);
}

const ROUTES: Record<string, Handler> = {
	// auth
	checkLogin: (env, b) => checkLogin(env, s(b.username), s(b.password)),
	resumeSession: (env, b) => resumeSession(env, s(b.token)),
	logout: (env, b) => logout(env, s(b.token)),
	logoutSession: (env, b) => logout(env, s(b.token)),

	// dashboard / activity
	getBootstrapData: (env, b) => getBootstrapData(env, s(b.token)),
	getDashboardData: (env, b) => getDashboard(env, s(b.token), b.options ?? b.request),
	logClientActivity: (env, b) =>
		logClientActivity(env, s(b.token), s(b.action_name ?? b.act), s(b.detail), s(b.status), s(b.content)),

	// kirim result
	smartAutoSendFast: (env, b) => smartAutoSendFast(env, s(b.token), s(b.rawText)),
	retryFailedSystem: (env, b) =>
		retryFailedSystem(env, s(b.token), s(b.rawText), s(b.systemName), b.website ? s(b.website) : undefined),
	sendToPanelZOnly: (env, b) => sendToPanelZOnly(env, s(b.token), s(b.market), s(b.angka)),

	// live / profil
	getLivePanelData: (env, b) =>
		getLivePanelData(env, s(b.token), (b.opts ?? {}) as { activity?: unknown; sessions?: boolean }),
	getCurrentUserProfile: (env, b) => getCurrentUserProfile(env, s(b.token)),

	// admin
	adminListUsers: (env, b) => adminListUsers(env, s(b.token)),
	adminSaveUser: (env, b) => adminSaveUser(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	adminDeleteUser: (env, b) => adminDeleteUser(env, s(b.token), s(b.targetUsername)),
	adminResetUserLock: (env, b) => adminResetUserLock(env, s(b.token), s(b.targetUsername)),
	adminListActiveSessions: (env, b) => adminListActiveSessions(env, s(b.token)),
	setMaintenance: (env, b) => setMaintenance(env, s(b.token), !!b.enabled, s(b.message)),

	// kelola website (site_accounts)
	adminListSites: (env, b) => adminListSites(env, s(b.token)),
	adminSaveSite: (env, b) => adminSaveSite(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	adminDeleteSite: (env, b) => adminDeleteSite(env, s(b.token), s(b.website)),

	// prediksi
	getPredictionStatusData: (env, b) => getPredictionStatusData(env, s(b.token)),
	generatePredictionCopyBundle: (env, b) => generatePredictionCopyBundle(env, Number(b.index), s(b.token)),
	generateClosingPredictionCopy: (env, b) => generateClosingPredictionCopy(env, s(b.token), s(b.slot)),
	sendPredictionAuto: (env, b) =>
		sendPredictionAuto(env, Number(b.index), s(b.token), Array.isArray(b.websites) ? (b.websites as string[]) : undefined),
	sendClosingPredictionAuto: (env, b) =>
		sendClosingPredictionAuto(
			env,
			s(b.token),
			Array.isArray(b.websites) ? (b.websites as string[]) : undefined,
			s(b.slot),
		),
	adminRunAutoPostNow: (env, b) => adminRunAutoPostNow(env, s(b.token)),
	setupAutoPostTriggers: (env, b) => setupAutoPostTriggers(env, s(b.token)),
	adminGetAutoPostWebhook: (env, b) => adminGetAutoPostWebhook(env, s(b.token), s(b.__origin)),
	adminSetAutoPost: (env, b) => adminSetAutoPost(env, s(b.token), !!b.enabled),

	// retensi activity log (nama lama frontend: "backup")
	adminRunActivityBackup: (env, b) => adminPruneActivityLog(env, s(b.token)),
	setupActivityBackupTrigger: (env, b) => adminSetLogRetention(env, s(b.token)),

	// invest
	investGetConfig: (env, b) => investGetConfig(env, s(b.token)),
	investSaveConfig: (env, b) => investSaveConfig(env, s(b.token), (b.payload ?? {}) as Record<string, unknown>),
	investTestSession: (env, b) => investTestSession(env, s(b.token)),
	investStartScan: (env, b) => investStartScan(env, s(b.token)),
	investContinueScan: (env, b) => investContinueScan(env, s(b.token)),
	investResetScan: (env, b) => investResetScan(env, s(b.token)),
	investGetStatus: (env, b) => investGetStatus(env, s(b.token)),
	investGetWarnings: (env, b) => investGetWarnings(env, s(b.token)),

	// pga pending -- lihat src/lib/pga-pending.ts
	pgaPendingSync: (env, b) => pgaPendingSync(env, s(b.token), b.rows),
	pgaPendingStatus: (env, b) => pgaPendingStatus(env, s(b.token)),

	// wd listed -- lihat src/lib/wd-listed.ts
	wdListedSync: (env, b) => wdListedSync(env, s(b.token), b.rows),
	wdListedGetList: (env, b) => wdListedGetList(env, s(b.token)),
	wdListedCheck: (env, b) => wdListedCheck(env, s(b.token), Number(b.id)),
	wdListedRemove: (env, b) => wdListedRemove(env, s(b.token), Number(b.id)),

	// laporan harian
	lapGetConfig: (env, b) => lapGetConfig(env, s(b.token)),
	lapSaveConfig: (env, b) => lapSaveConfig(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	// depoPaidRows/depoCreateRows/wdRows SENGAJA tidak di-default-kan ke [] --
	// skrip Console sekarang bisa kirim salah satu SET saja per panggilan (lihat
	// lapMotionConsoleScriptDeposit/Withdraw), dan `undefined` (field tidak
	// dikirim sama sekali) harus tetap `undefined` sampai ke lapMotionImport
	// supaya bisa dibedakan dari "dikirim tapi memang kosong" (`[]`).
	lapMotionImport: (env, b) => lapMotionImport(env, s(b.token), s(b.startDate), s(b.endDate), b.depoPaidRows, b.depoCreateRows, b.wdRows),
	lapRunMozart: (env, b) =>
		lapRunMozart(env, s(b.token), s(b.startDate), s(b.endDate), (b.opts ?? {}) as { depo?: boolean; wd?: boolean; panelId?: number }),
	lapRunAdmin: (env, b) => lapRunAdmin(env, s(b.token), s(b.startDate), s(b.endDate)),
	lapMozartImport: (env, b) =>
		lapMozartImport(
			env,
			s(b.token),
			s(b.startDate),
			s(b.endDate),
			(b.depositRows ?? []) as unknown[],
			(b.withdrawRows ?? []) as unknown[],
			b.accountsRaw ?? [],
			b.panelsRaw ?? [],
		),
	lapAdminStatus: (env, b) => lapAdminStatus(env, s(b.token), s(b.jobId)),

	// role BOT — modul NEWS
	botNewsStatus: (env, b) => botNewsStatus(env, s(b.token)),
	botNewsSaveConfig: (env, b) => botNewsSaveConfig(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsAddSource: (env, b) => botNewsAddSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsToggleSource: (env, b) => botNewsToggleSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsDeleteSource: (env, b) => botNewsDeleteSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsRunNow: (env, b) => botNewsRunNow(env, s(b.token), b.count != null ? Number(b.count) : undefined),
	botNewsRunSiteNow: (env, b) => botNewsRunSiteNow(env, s(b.token), b.count != null ? Number(b.count) : undefined),
	botNewsRunViaGithub: (env, b) => botNewsRunViaGithub(env, s(b.token), b.count != null ? Number(b.count) : undefined, b.target != null ? s(b.target) : undefined),
	botNewsGithubRunStatus: (env, b) => botNewsGithubRunStatus(env, s(b.token)),
	botFbRunNow: (env, b) => botFbRunNow(env, s(b.token)),
	botFbTemplateGenerate: (env, b) => botFbTemplateGenerate(env, s(b.token)),
	botNewsSkip: (env, b) => botNewsSkip(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),

	// Live Chat Auto-Reply — sisi panel (sesi login ADMIN/OPERATOR)
	livechatListSessions: (env, b) => livechatListSessions(env, s(b.token)),
	livechatSetBotEnabled: (env, b) => livechatSetBotEnabled(env, s(b.token), s(b.sessionKey), !!b.enabled),
	livechatListTemplates: (env, b) => livechatListTemplates(env, s(b.token)),
	livechatSaveTemplate: (env, b) => livechatSaveTemplate(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	livechatDeleteTemplate: (env, b) => livechatDeleteTemplate(env, s(b.token), Number(b.id)),
	livechatRecentLogs: (env, b) => livechatRecentLogs(env, s(b.token)),
	// Live Chat Auto-Reply — sisi userscript daylivechat.com (auth via LIVECHAT_BOT_KEY)
	livechatBotSync: (env, b) => livechatBotSync(env, s(b.key), b.rows),
	livechatBotPull: (env, b) => livechatBotPull(env, s(b.key)),
	livechatBotReport: (env, b) =>
		livechatBotReport(env, s(b.key), s(b.sessionKey), s(b.customerMessage), b.matchedTemplateId != null ? Number(b.matchedTemplateId) : null, s(b.replyText)),

	// dipanggil GitHub Actions (auth via job key, bukan sesi)
	lapJobStart: (env, b) => lapJobStart(env, s(b.jobId), s(b.key)),
	lapJobResult: (env, b) =>
		lapJobResult(
			env,
			s(b.jobId),
			s(b.key),
			!!b.ok,
			(b.data ?? {}) as Record<string, unknown[]>,
			(b.errors ?? {}) as Record<string, string>,
		),
};

// Aksi Invest yang memicu pump di latar belakang (ctx.waitUntil) — supaya scan
// langsung bergerak begitu user klik MULAI/LANJUTKAN dan terus maju selama user
// membuka halaman (polling investGetStatus), tanpa menunggu cron eksternal.
const INVEST_PUMP_ACTIONS = new Set(["investStartScan", "investContinueScan", "investGetStatus"]);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS" && url.pathname === "/api") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method === "POST" && url.pathname === "/api") {
			let body: Record<string, unknown> = {};
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return json({ success: false, message: "Body JSON tidak valid." }, 400);
			}
			body.__origin = url.origin;
			const action = s(body.action);
			const handler = ROUTES[action];
			if (!handler) return json({ success: false, message: "Aksi tidak dikenal: " + action }, 404);
			try {
				const out = await handler(env, body);
				if (INVEST_PUMP_ACTIONS.has(action)) {
					// Pump scan user INI di latar belakang (lock per-user) -> scan-nya
					// jalan sendiri, tidak antre di belakang user lain.
					ctx.waitUntil(
						(async () => {
							const rec = await loadSession(env, s(body.token));
							if (rec?.username) await investPumpUser(env, rec.username);
						})().catch((e) => console.error("invest pump (waitUntil) error", e)),
					);
				}
				return json(out);
			} catch (e) {
				// Dicatat ke wrangler tail supaya error non-fatal (mis. validasi
				// gagal) tetap kelihatan pesan aslinya tanpa perlu reproduce manual --
				// dulu tidak ada log sama sekali di sini, jadi 500 apapun (termasuk
				// yang cuma "Sesi tidak valid") tidak bisa dibedakan dari tail biasa.
				console.error("API error [" + action + "]", e instanceof Error ? e.message : e);
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		if (url.pathname === "/health") {
			return new Response("panel-worker OK", { headers: { "content-type": "text/plain" } });
		}

		// Proxy gambar (dipakai tombol "Copy Gambar" di BOT · Template FB): banyak
		// gambar berita punya hotlink-protection / CORS ketat sehingga tidak bisa
		// di-fetch langsung dari browser untuk disalin ke clipboard. Worker ambil
		// dulu di sisi server (bebas CORS), lalu diteruskan sebagai same-origin.
		if (url.pathname === "/img") {
			const target = url.searchParams.get("url") || "";
			if (!/^https?:\/\//i.test(target)) return json({ success: false, message: "url tidak valid" }, 400);
			// Banyak situs berita menolak User-Agent "bot" walau cuma diakses server-side
			// (bukan soal CORS -- itu aturan browser, tidak berlaku fetch server-to-server
			// ini) -- pura-pura jadi browser biasa + kirim Referer dari domain gambar itu
			// sendiri (anti-hotlink umumnya cuma cek Referer kosong/beda domain).
			let targetOrigin = "";
			try {
				targetOrigin = new URL(target).origin;
			} catch {
				return json({ success: false, message: "url tidak valid" }, 400);
			}
			try {
				const r = await fetch(target, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
						Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
						Referer: targetOrigin + "/",
					},
				});
				const ct = r.headers.get("content-type") || "";
				if (!r.ok || !r.body || !ct.startsWith("image/")) {
					// Fetch server-side gagal (kena blokir situs asal) -> lempar browser
					// pengguna buka LANGSUNG ke gambar aslinya (koneksi asli user kadang
					// tidak kena blokir yang sama seperti IP Cloudflare Worker).
					return Response.redirect(target, 302);
				}
				return new Response(r.body, { headers: { "content-type": ct, "cache-control": "public, max-age=3600", ...CORS_HEADERS } });
			} catch {
				return Response.redirect(target, 302);
			}
		}

		// Endpoint PUBLIK (tanpa sesi) untuk situs "Berita Terkini" di LapakStore88 --
		// cuma baca (read-only), cuma artikel status='posted' yang pernah dikembalikan
		// (lihat publicNewsList/publicNewsDetail di lib/bot-news.ts). CORS dibuka lebar
		// karena memang dikonsumsi dari origin lain (lokalstore88.online, GitHub Pages).
		if (url.pathname === "/public/news") {
			try {
				const category = url.searchParams.get("category") || "";
				if (url.searchParams.get("banner")) {
					return json(await publicNewsBanner(env), 200);
				}
				if (url.searchParams.get("random")) {
					const limit = parseInt(url.searchParams.get("limit") || "6", 10);
					return json(await publicNewsRandom(env, category, limit), 200);
				}
				if (url.searchParams.get("popular")) {
					const limit = parseInt(url.searchParams.get("limit") || "5", 10);
					return json(await publicNewsPopular(env, category, limit), 200);
				}
				const idParam = url.searchParams.get("id");
				if (idParam) {
					const out = await publicNewsDetail(env, Number(idParam));
					return json(out, out.success ? 200 : 404);
				}
				const page = parseInt(url.searchParams.get("page") || "1", 10);
				const pageSize = parseInt(url.searchParams.get("pageSize") || "20", 10);
				const out = await publicNewsList(env, category, page, pageSize);
				return json(out, 200);
			} catch (e) {
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Sitemap XML artikel "Berita Terkini" -- lihat catatan di publicNewsSitemapXml
		// soal kenapa ini TIDAK otomatis kepakai Search Console utk lokalstore88.online
		// tanpa frontend-nya ikut proxy/serve balik file ini di domain sendiri.
		if (url.pathname === "/public/news-sitemap.xml") {
			try {
				const xml = await publicNewsSitemapXml(env);
				return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=1800", ...CORS_HEADERS } });
			} catch (e) {
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Endpoint cron eksternal (fallback kalau Cron Trigger Cloudflare tidak jalan).
		// Panggil tiap menit dari cron-job.org / GitHub Actions / UptimeRobot:
		//   https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=all
		if (url.pathname === "/__cron") {
			if (!env.CRON_KEY || url.searchParams.get("key") !== env.CRON_KEY) {
				return json({ ok: false, message: "unauthorized" }, 401);
			}
			const job = url.searchParams.get("job") || "all";

			// Cek koneksi Turso: /__cron?key=...&job=tursoping
			if (job === "tursoping") {
				try {
					const t0 = Date.now();
					const r = await getTurso(env).prepare(`SELECT COUNT(*) AS n FROM invest_config`).first<{ n: number }>();
					const r2 = await getTurso(env).prepare(`SELECT COUNT(*) AS n FROM lap_result`).first<{ n: number }>();
					return json({ ok: true, ms: Date.now() - t0, invest_config: r?.n ?? null, lap_result: r2?.n ?? null });
				} catch (e) {
					return json({ ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, 500);
				}
			}

			// Diagnosa sementara: /__cron?key=...&job=debug&user=<username>&path=<path>
			//   atau inline: &base=<url>&cookie=<PHPSESSID=...>
			if (job === "debug") {
				let baseUrl = url.searchParams.get("base") || "";
				let cookie = url.searchParams.get("cookie") || "";
				if (!baseUrl || !cookie) {
					const dbgUser = url.searchParams.get("user") || "Admin";
					const cfgRow = await getTurso(env).prepare(
						`SELECT base_url, phpsessid, koderedis, cookie_extra FROM invest_config WHERE username = ?`,
					)
						.bind(dbgUser)
						.first<Record<string, string>>();
					if (!cfgRow) return json({ ok: false, message: "no invest_config for " + dbgUser });
					baseUrl = String(cfgRow.base_url || "");
					cookie = cfgRow.cookie_extra
						? cfgRow.cookie_extra
						: "PHPSESSID=" + cfgRow.phpsessid + (cfgRow.koderedis ? "; koderedis=" + cfgRow.koderedis : "");
				}
				baseUrl = baseUrl.split("#")[0].split("?")[0];
				if (!baseUrl.endsWith("/")) baseUrl += "/";
				const paths = (url.searchParams.get("path") || "admin_invoice13.php?psr=p33190").split("|");
				const results: unknown[] = [];
				for (const p of paths) {
					try {
						const r = await fetch(baseUrl + p, {
							headers: {
								Cookie: cookie,
								"User-Agent":
									"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
							},
							redirect: "manual",
						});
						const body = await r.text();
						const trCount = (body.match(/<tr[\s>]/gi) || []).length;
						const pageNums = (body.match(/[?&]page=(\d+)/g) || []).map((x) => parseInt(x.split("=")[1], 10));
						const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
						results.push({
							url: baseUrl + p,
							status: r.status,
							location: r.headers.get("location"),
							len: body.length,
							trCount,
							maxPage,
							loginPage: /entered_login|vb_login_md5password|silakan login|please login/i.test(body),
							hasPeriode: /name=["']?periode["']?[^>]*value=["'](\d+)["']/i.test(body),
							snippet: (() => {
								const find = url.searchParams.get("find");
								if (find) {
									const i = body.toLowerCase().indexOf(find.toLowerCase());
									return i < 0 ? "[not found: " + find + "]" : body.slice(Math.max(0, i - 200), i + 1400);
								}
								return url.searchParams.get("full") ? body.slice(0, 4000) : body.slice(0, 300);
							})(),
						});
					} catch (e) {
						results.push({ url: baseUrl + p, error: e instanceof Error ? e.message : String(e) });
					}
				}
				return json({ ok: true, baseUrl, cookiePreview: cookie.slice(0, 20) + "…", results });
			}

			// PERNAH DICOBA: balas cron SEGERA lalu lanjutkan botNewsRun via
			// ctx.waitUntil supaya cron eksternal tidak pernah menunggu lama.
			// TERBUKTI SALAH lewat pengetesan langsung (wrangler tail): Cloudflare
			// membatalkan task waitUntil yang belum selesai dalam waktu tertentu
			// sesudah respons dikirim ("waitUntil() tasks did not complete within
			// the allowed time... have been cancelled") -- karena proses kita
			// (~32 detik saat 4 artikel lancar) melebihi batas itu, artikelnya
			// JUSTRU TIDAK PERNAH selesai diproses sama sekali (lebih parah dari
			// sekadar "cron-nya lapor timeout" seperti semula). Makanya di sini
			// TETAP sinkron (di-await penuh) -- lihat perbaikan nyata di
			// SAFE_COMBINED_BUDGET (botNewsRun) yang MEMPERKECIL beban per
			// panggilan supaya selesai jauh di bawah 30 detik, bukan menyembunyikan
			// waktu prosesnya dari cron.
			const out: Record<string, unknown> = { ok: true, job, ts: Date.now() };
			try {
				if (job === "autopost" || job === "all") {
					out.autopost = await runAutoPostRouter(env);
					out.pruned = await dailyPrune(env);
				}
				if (job === "invest" || job === "all") {
					await investPump(env);
					out.invest = "pumped";
				}
				// Job KHUSUS 1 user -- dipanggil BERULANG-ULANG dari GitHub Actions
				// (invest-turbo.yml, dipicu tombol MULAI/LANJUTKAN SCAN di panel) selama
				// scan user itu masih 'running'. Beda dari job=invest di atas (yang mompa
				// SEMUA user sekaligus dgn jatah waktu terbagi) -- di sini 1 user dapat
				// jatah PENUH (mendekati budget asli investPumpUser) tiap panggilan, jadi
				// throughput-nya jauh lebih cepat drpd nunggu cron */1 menit bawaan
				// Cloudflare gantian. TETAP lewat investPumpUser (bukan investScanUser
				// langsung) supaya lock per-user (env.SESS) yang sama dipakai -- jadi
				// tidak race sama sekali dgn cron Cloudflare/live-polling yang mungkin
				// masih jalan bersamaan buat user yang sama.
				if (job === "investuser") {
					const qUser = (url.searchParams.get("user") || "").trim();
					if (!qUser) {
						out.ok = false;
						out.error = "Query 'user' wajib diisi buat job=investuser.";
					} else {
						await investPumpUser(env, qUser);
						out.invest = await investGetState(env, qUser);
					}
				}
				if (job === "news" || job === "all") {
					// mode/count OPSIONAL (dari query string) -- dipakai kalau cron
					// EKSTERNAL manggil job=news khusus mode=blogger atau mode=site
					// SENDIRI-SENDIRI (2 invocation terpisah, masing² dapat jatah 50
					// subrequest sendiri -> throughput lebih besar drpd job=all/Cron
					// Trigger bawaan yang gabung keduanya dalam SAFE_COMBINED_BUDGET).
					// Tidak dikirim = perilaku lama (mode="both", persis Cron Trigger).
					const qMode = url.searchParams.get("mode");
					const qCount = url.searchParams.get("count");
					const runOpts: Parameters<typeof botNewsRun>[1] = {};
					if (qMode === "blogger" || qMode === "site" || qMode === "both") runOpts.mode = qMode;
					if (qCount) runOpts.count = Number(qCount);
					out.news = await botNewsRun(env, runOpts);
				}
				// Job KHUSUS tarik RSS -- SENGAJA TIDAK ikut "all"/"news" lagi (lihat
				// komentar di botNewsRun): gabung pull+proses dalam 1 invocation kena
				// "Too many subrequests" berulang kali. Dipanggil cron eksternal
				// TERPISAH (mis. tiap 10-15 menit), aman sendiri (~10 subrequest).
				if (job === "pullnews") {
					out.pull = await newsPullSources(env);
				}
				// Manual/diagnosa: paksa jalankan pembersihan antrean sekarang juga
				// (biasanya sekali/hari via Cron Trigger native, lihat scheduled()).
				if (job === "newsprune") {
					out.newsprune = await newsPruneQueueDaily(env);
				}
				// PERBAIKAN: jadwal `schedule:` bawaan GitHub Actions TERBUKTI tidak bisa
				// diandalkan buat interval ketat (terbukti lewat cron.yml yang sudah lama
				// ada -- di-set tiap 5 menit tapi kadang cuma jalan sekali per BEBERAPA
				// JAM, murni keterbatasan penjadwal internal GitHub, bukan bug kita).
				// Job ini gantikan itu: cuma "memencet tombol" workflow_dispatch
				// news-turbo.yml (via dispatchNewsTurbo, GH API, ~1 fetch, sangat ringan)
				// -- prosesnya sendiri TETAP di GitHub Actions (bebas limit subrequest),
				// tapi PEMICUNYA dari cron eksternal (cron-job.org) yang jauh lebih
				// presisi drpd jadwal internal GitHub. count/target opsional dari query
				// string, sama seperti job=news dulu.
				if (job === "githubnews") {
					const qCount = url.searchParams.get("count");
					const qTarget = url.searchParams.get("target") || undefined;
					out.githubnews = await dispatchNewsTurbo(env, qCount ? Number(qCount) : undefined, qTarget);
				}
				// Job TERPISAH sengaja TIDAK ikut "all" -- dipanggil cron sendiri tiap
				// 10 menit (1 artikel/panggilan), independen dari jadwal Blogger.
				if (job === "fbdirect") {
					out.fbdirect = await fbDirectRun(env);
				}
				// One-shot: suntik 8 sumber RSS per-kategori Liputan6. Idempotent (aman
				// dipanggil berkali²) -- TIDAK ikut "all", dipanggil manual sekali saja.
				if (job === "seednews") {
					out.seed = await seedCategorySources(env);
				}
				if (job === "disablegnews") {
					out.disabled = await disableGnewsSources(env);
				}
				// One-shot: sumber Liputan6 Bola sempat disuntik dgn category='olahraga'
				// sebelum "bola" jadi kategori tersendiri -- perbaiki jadi 'bola'.
				if (job === "fixbolacat") {
					const r = await getTurso(env).prepare(`UPDATE news_source SET category='bola' WHERE url LIKE '%rss/bola%'`).run();
					out.fixed = r.meta.changes;
				}
				// Diagnosa sementara: lihat semua sumber terdaftar (nama/kind/url asli)
				// supaya tahu persis kenapa filter "kompas" di job disablegnews tidak
				// menemukan apa pun.
				if (job === "listsources") {
					out.sources = (await getTurso(env).prepare(`SELECT id, name, kind, url, active, category FROM news_source ORDER BY id`).all()).results;
				}
				// Diagnosa: hitung artikel per kategori -- berapa yang masih antre
				// (status='new'), sudah posting Blogger (status='posted'), dan sudah
				// tayang di situs sendiri (site_posted_at != '').
				// Diagnosa sementara: lihat 8 artikel TERAKHIR yang statusnya berubah
				// (posted/site) plus timestamp-nya -- dipakai buat verifikasi apakah
				// ctx.waitUntil() di job=news/pullnews beneran jalan sampai selesai
				// di background, bukan cuma keliatan cepat tapi diam-diam batal.
				if (job === "recentpost") {
					out.recent = (
						await getTurso(env)
							.prepare(
								`SELECT id, category, status, post_url, posted_at, site_posted_at FROM news_article WHERE status='posted' OR site_posted_at != '' ORDER BY MAX(posted_at, site_posted_at) DESC LIMIT 8`,
							)
							.all()
					).results;
				}
				if (job === "catstats") {
					out.stats = (
						await getTurso(env)
							.prepare(
								`SELECT category,
									COUNT(*) AS total,
									SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) AS queued,
									SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) AS blogger_posted,
									SUM(CASE WHEN site_posted_at != '' THEN 1 ELSE 0 END) AS site_posted
								FROM news_article GROUP BY category ORDER BY total DESC`
							)
							.all()
					).results;
				}
				// One-shot: sumber Kompas sudah nonaktif duluan, TAPI ratusan artikel
				// yang sudah kelanjur ditarik sebelumnya (status='new') tetap akan terus
				// diproses selama belum dibersihkan -- nonaktifkan source cuma menghentikan
				// TARIKAN BARU, tidak menyentuh backlog yang sudah ada.
				if (job === "skipkompasqueue") {
					const r1 = await getTurso(env)
						.prepare(`UPDATE news_article SET status='skipped' WHERE status='new' AND source LIKE '%ompas%'`)
						.run();
					// Template FB (fbTemplateGenerate) TIDAK dibatasi status='new' -- dia
					// jalan lewat kolom terpisah fb_direct_posted_at='' yg mencakup
					// SEMUA artikel lama (termasuk yg sudah lama posting ke Blogger),
					// jadi backlog Kompas juga harus dibersihkan dari SINI supaya tidak
					// terus muncul di antrean Template FB.
					const r2 = await getTurso(env)
						.prepare(`UPDATE news_article SET fb_direct_posted_at='skip' WHERE fb_direct_posted_at='' AND source LIKE '%ompas%'`)
						.run();
					out.skippedMain = r1.meta.changes;
					out.skippedFbTemplate = r2.meta.changes;
				}
			} catch (e) {
				out.ok = false;
				out.error = e instanceof Error ? e.message : String(e);
			}
			return json(out);
		}

		// selain /api dan /health -> serahkan ke static assets (Index.html panel).
		return env.ASSETS.fetch(request);
	},

	// Cron Triggers:
	//   "*/5 * * * *" -> router auto-post prediksi
	//   "* * * * *"   -> pump scan INVEST (lanjutkan user yang state-nya 'running')
	async scheduled(event, env, _ctx): Promise<void> {
		try {
			await env.DB.prepare(
				`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
				.bind(new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " | cron=" + event.cron)
				.run();
		} catch (e) {
			console.error("cron heartbeat error", e);
		}

		if (event.cron === "*/5 * * * *") {
			await runAutoPostRouter(env).catch((e) => console.error("auto-post router error", e));
			await dailyPrune(env).catch((e) => console.error("prune error", e));
			// Sekali/hari (guard sendiri di dalam fungsinya) -- buang antrean berita
			// yang belum diproses & lebih lama dari kemarin jam 22:00 WIB. TIDAK
			// PERNAH menyentuh artikel yang sudah tayang (lihat komentar di fungsinya).
			await newsPruneQueueDaily(env).catch((e) => console.error("news queue prune error", e));
		} else {
			await investPump(env).catch((e) => console.error("invest pump error", e));
		}
	},
} satisfies ExportedHandler<Env>;
