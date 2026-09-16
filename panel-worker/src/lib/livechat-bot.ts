// Modul "Live Chat Auto-Reply" — bot balas otomatis khusus sesi chat
// DayLiveChat (daylivechat.com, dipakai CS HUGOTOGEL) yang SENGAJA dipilih
// operator lewat panel ini. DayLiveChat tidak punya API publik, tapi
// aplikasinya (dibongkar dari /js/cs-dashboard.js) ternyata REST + Socket.IO
// biasa (login JWT lewat POST /api/auth/login, real-time lewat Socket.IO
// event 'chat:new_message', kirim balasan lewat emit 'cs:message') -- jadi
// panel ini login LANGSUNG pakai akun CS yang disimpan di sini, TIDAK lewat
// browser/ekstensi sama sekali. Koneksi Socket.IO yang perlu tetap hidup
// dipegang oleh Durable Object (lihat src/durable/livechat-bot-do.ts),
// modul ini murni penyimpanan (Turso):
//   - livechat_credential : 1 baris, email+password akun CS DayLiveChat.
//   - livechat_session    : sesi chat yang pernah terlihat DO + status
//     bot_enabled (di-toggle dari panel) -- HANYA sesi yang diaktifkan
//     operator yang dibalas otomatis, sisanya tetap manual.
//   - livechat_template   : daftar kalimat balasan (dipilih ACAK tiap bot
//     membalas -- bot ini khusus pacify member spam/kasar, bukan FAQ, jadi
//     balasannya TIDAK memandang isi keluhan member).
//   - livechat_log        : jejak setiap balasan otomatis yang terkirim.
import { getTurso } from "./turso";
import { tsNow } from "./time";

let tablesEnsured = false;
async function ensureTables(env: Env): Promise<void> {
	if (tablesEnsured) return;
	const db = getTurso(env);
	for (const stmt of [
		`CREATE TABLE IF NOT EXISTS livechat_credential (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			email TEXT NOT NULL DEFAULT '',
			password TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS livechat_session (
			session_key TEXT PRIMARY KEY,
			queue_code TEXT NOT NULL DEFAULT '',
			customer_name TEXT NOT NULL DEFAULT '',
			divisi TEXT NOT NULL DEFAULT '',
			last_message TEXT NOT NULL DEFAULT '',
			last_sender TEXT NOT NULL DEFAULT '',
			bot_enabled INTEGER NOT NULL DEFAULT 0,
			last_seen_at TEXT NOT NULL DEFAULT '',
			bot_updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS livechat_template (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			reply_text TEXT NOT NULL DEFAULT '',
			active INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS livechat_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_key TEXT NOT NULL DEFAULT '',
			customer_message TEXT NOT NULL DEFAULT '',
			matched_template_id INTEGER,
			reply_text TEXT NOT NULL DEFAULT '',
			sent_at TEXT NOT NULL DEFAULT ''
		)`,
	]) {
		await db.prepare(stmt).run();
	}
	tablesEnsured = true;
}

export interface LivechatSessionRow {
	session_key: string;
	queue_code: string;
	customer_name: string;
	divisi: string;
	last_message: string;
	last_sender: string;
	bot_enabled: number;
	last_seen_at: string;
	bot_updated_at: string;
}

export interface LivechatTemplateRow {
	id: number;
	reply_text: string;
	active: number;
	sort_order: number;
	updated_at: string;
}

export interface LivechatCredential {
	email: string;
	password: string;
	updatedAt: string;
}

// --- Kredensial akun CS DayLiveChat ---

export async function getCredential(env: Env): Promise<LivechatCredential | null> {
	await ensureTables(env);
	const row = await getTurso(env)
		.prepare(`SELECT email, password, updated_at FROM livechat_credential WHERE id = 1`)
		.first<{ email: string; password: string; updated_at: string }>();
	if (!row || !row.email || !row.password) return null;
	return { email: row.email, password: row.password, updatedAt: row.updated_at };
}

export async function saveCredential(env: Env, email: string, password: string): Promise<void> {
	await ensureTables(env);
	const cleanEmail = String(email ?? "").trim();
	const cleanPassword = String(password ?? "").trim();
	if (!cleanEmail || !cleanPassword) throw new Error("Email & password akun CS wajib diisi.");
	await getTurso(env)
		.prepare(
			`INSERT INTO livechat_credential (id, email, password, updated_at) VALUES (1, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET email = excluded.email, password = excluded.password, updated_at = excluded.updated_at`,
		)
		.bind(cleanEmail, cleanPassword, tsNow())
		.run();
}

// --- Sesi chat ---

/** Dipanggil panel (role ADMIN/OPERATOR) untuk menampilkan daftar sesi + status toggle. */
export async function listSessions(env: Env): Promise<LivechatSessionRow[]> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT * FROM livechat_session ORDER BY bot_enabled DESC, last_seen_at DESC LIMIT 200`)
		.all<LivechatSessionRow>();
	return r.results;
}

/** Toggle "Aktifkan Bot" per sesi -- ini SATU-SATUNYA cara sesi jadi bot_enabled=1. */
export async function setSessionBot(env: Env, sessionKey: string, enabled: boolean): Promise<void> {
	await ensureTables(env);
	await getTurso(env)
		.prepare(`UPDATE livechat_session SET bot_enabled = ?, bot_updated_at = ? WHERE session_key = ?`)
		.bind(enabled ? 1 : 0, tsNow(), sessionKey)
		.run();
}

export async function isSessionBotEnabled(env: Env, sessionKey: string): Promise<boolean> {
	await ensureTables(env);
	const row = await getTurso(env)
		.prepare(`SELECT bot_enabled FROM livechat_session WHERE session_key = ?`)
		.bind(sessionKey)
		.first<{ bot_enabled: number }>();
	return !!row && Number(row.bot_enabled) === 1;
}

/**
 * Dipanggil Durable Object (lihat livechat-bot-do.ts) tiap kali chat terlihat
 * lewat inbox/socket -- upsert data tampilan (nama, pesan terakhir, dst) di
 * panel. bot_enabled TIDAK PERNAH disentuh dari sini, hanya setSessionBot
 * (dipicu toggle operator) yang boleh mengubahnya.
 */
export async function upsertSessionSeen(
	env: Env,
	row: { sessionKey: string; queueCode?: string; customerName?: string; divisi?: string; lastMessage?: string; lastSender?: string },
): Promise<void> {
	await ensureTables(env);
	const key = String(row.sessionKey || "").trim();
	if (!key) return;
	const now = tsNow();
	await getTurso(env)
		.prepare(
			`INSERT INTO livechat_session (session_key, queue_code, customer_name, divisi, last_message, last_sender, bot_enabled, last_seen_at, bot_updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, '')
			 ON CONFLICT(session_key) DO UPDATE SET
				queue_code = excluded.queue_code,
				customer_name = excluded.customer_name,
				divisi = excluded.divisi,
				last_message = excluded.last_message,
				last_sender = excluded.last_sender,
				last_seen_at = excluded.last_seen_at`,
		)
		.bind(
			key,
			String(row.queueCode ?? "").slice(0, 100),
			String(row.customerName ?? "").slice(0, 200),
			String(row.divisi ?? "").slice(0, 100),
			String(row.lastMessage ?? "").slice(0, 2000),
			String(row.lastSender ?? "").slice(0, 30),
			now,
		)
		.run();
}

// --- Template balasan (daftar acak, tanpa memandang isi keluhan member) ---

export async function listTemplates(env: Env): Promise<LivechatTemplateRow[]> {
	await ensureTables(env);
	const r = await getTurso(env).prepare(`SELECT * FROM livechat_template ORDER BY sort_order ASC, id ASC`).all<LivechatTemplateRow>();
	return r.results;
}

export async function listActiveTemplates(env: Env): Promise<LivechatTemplateRow[]> {
	await ensureTables(env);
	const r = await getTurso(env).prepare(`SELECT * FROM livechat_template WHERE active = 1`).all<LivechatTemplateRow>();
	return r.results;
}

export function pickRandomTemplate(templates: LivechatTemplateRow[]): LivechatTemplateRow | null {
	if (!templates.length) return null;
	return templates[Math.floor(Math.random() * templates.length)];
}

export async function saveTemplate(env: Env, data: { id?: number; replyText: string; active?: boolean; sortOrder?: number }): Promise<void> {
	await ensureTables(env);
	const db = getTurso(env);
	const replyText = String(data.replyText ?? "").trim();
	if (!replyText) throw new Error("Isi balasan wajib diisi.");
	const active = data.active === false ? 0 : 1;
	const sortOrder = Number.isFinite(data.sortOrder) ? Number(data.sortOrder) : 0;
	if (data.id) {
		await db
			.prepare(`UPDATE livechat_template SET reply_text = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
			.bind(replyText, active, sortOrder, tsNow(), data.id)
			.run();
	} else {
		await db
			.prepare(`INSERT INTO livechat_template (reply_text, active, sort_order, updated_at) VALUES (?, ?, ?, ?)`)
			.bind(replyText, active, sortOrder, tsNow())
			.run();
	}
}

export async function deleteTemplate(env: Env, id: number): Promise<void> {
	await ensureTables(env);
	await getTurso(env).prepare(`DELETE FROM livechat_template WHERE id = ?`).bind(id).run();
}

// --- Audit ---

export async function logAutoReply(env: Env, sessionKey: string, customerMessage: string, matchedTemplateId: number | null, replyText: string): Promise<void> {
	await ensureTables(env);
	await getTurso(env)
		.prepare(`INSERT INTO livechat_log (session_key, customer_message, matched_template_id, reply_text, sent_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(sessionKey, customerMessage.slice(0, 2000), matchedTemplateId, replyText.slice(0, 2000), tsNow())
		.run();
}

export async function recentLogs(env: Env, limit = 100): Promise<Array<Record<string, unknown>>> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT * FROM livechat_log ORDER BY id DESC LIMIT ?`)
		.bind(Math.min(500, Math.max(1, limit)))
		.all();
	return r.results;
}
