// Endpoint panel "Live Chat Auto-Reply" (role ADMIN/OPERATOR -- VIEWER & BOT
// ditolak, BOT terisolasi ke modul NEWS lihat api/bot.ts). Panel login
// LANGSUNG ke DayLiveChat pakai akun CS yang disimpan di sini (lewat Durable
// Object, lihat src/durable/livechat-bot-do.ts) -- tidak ada userscript/
// ekstensi browser sama sekali.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import {
	deleteTemplate,
	getCredential,
	listSessions,
	listTemplates,
	recentLogs,
	saveCredential,
	saveTemplate,
	setSessionBot,
} from "../lib/livechat-bot";

async function gatePanel(env: Env, token: string) {
	const s = await requireSession(env, token);
	if (s.profile.role !== "ADMIN" && s.profile.role !== "OPERATOR") {
		throw new Error("Menu Live Chat hanya untuk ADMIN atau OPERATOR.");
	}
	return s;
}

/** "Bangunkan" Durable Object bot -- dipanggil abis toggle sesi/simpan kredensial
 *  supaya koneksi Socket.IO ke DayLiveChat langsung dicoba saat itu juga,
 *  tidak perlu nunggu heartbeat cron 1 menit berikutnya. */
async function wakeBot(env: Env): Promise<void> {
	try {
		const id = env.LIVECHAT_BOT.idFromName("global");
		await env.LIVECHAT_BOT.get(id).fetch("https://livechat-bot/wake");
	} catch (e) {
		console.error("wakeBot gagal", e instanceof Error ? e.message : e);
	}
}

export async function livechatListSessions(env: Env, token: string) {
	await gatePanel(env, token);
	return { success: true, sessions: await listSessions(env) };
}

export async function livechatSetBotEnabled(env: Env, token: string, sessionKey: string, enabled: boolean) {
	const s = await gatePanel(env, token);
	if (!sessionKey) throw new Error("session_key wajib.");
	await setSessionBot(env, sessionKey, enabled);
	await logActivity(env, s.username, "LIVE CHAT BOT", `${enabled ? "Aktifkan" : "Matikan"} auto-reply untuk sesi ${sessionKey}`, "BERHASIL", "");
	await wakeBot(env);
	return { success: true };
}

export async function livechatListTemplates(env: Env, token: string) {
	await gatePanel(env, token);
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatSaveTemplate(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gatePanel(env, token);
	await saveTemplate(env, {
		id: data.id ? Number(data.id) : undefined,
		replyText: String(data.replyText ?? data.reply_text ?? ""),
		active: data.active !== false && data.active !== 0 && data.active !== "0",
		sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
	});
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", data.id ? "Ubah template balasan" : "Tambah template balasan", "BERHASIL", "");
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatDeleteTemplate(env: Env, token: string, id: number) {
	const s = await gatePanel(env, token);
	if (!id) throw new Error("id template wajib.");
	await deleteTemplate(env, id);
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", "Hapus template balasan #" + id, "BERHASIL", "");
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatRecentLogs(env: Env, token: string) {
	await gatePanel(env, token);
	return { success: true, logs: await recentLogs(env) };
}

/** Status akun CS tersimpan -- TIDAK PERNAH mengembalikan password ke browser. */
export async function livechatGetCredentialStatus(env: Env, token: string) {
	await gatePanel(env, token);
	const cred = await getCredential(env);
	return {
		success: true,
		configured: !!cred,
		email: cred ? cred.email : "",
		updatedAt: cred ? cred.updatedAt : "",
	};
}

export async function livechatSaveCredential(env: Env, token: string, email: string, password: string) {
	const s = await gatePanel(env, token);
	await saveCredential(env, email, password);
	await logActivity(env, s.username, "LIVE CHAT AKUN CS", "Simpan/ubah kredensial akun CS DayLiveChat (" + email + ")", "BERHASIL", "");
	await wakeBot(env);
	return { success: true };
}

export async function livechatBotStatus(env: Env, token: string) {
	await gatePanel(env, token);
	try {
		const id = env.LIVECHAT_BOT.idFromName("global");
		const r = await env.LIVECHAT_BOT.get(id).fetch("https://livechat-bot/status");
		return await r.json();
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}
