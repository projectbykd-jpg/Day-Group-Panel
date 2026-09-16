// Modul "Live Chat Auto-Reply" — bot balas otomatis untuk sesi chat DayLiveChat
// (daylivechat.com, dipakai CS HUGOTOGEL) yang SENGAJA dipilih operator lewat
// panel ini. DayLiveChat adalah SaaS pihak ketiga tanpa API publik, jadi
// "mata & tangan" bot-nya jalan lewat userscript browser (lihat
// userscripts/daylivechat-autobot.user.js) yang sinkron ke tabel di sini:
//   - livechat_session : daftar sesi chat yang terdeteksi userscript + status
//     bot_enabled (di-toggle dari panel, BUKAN dari userscript) -- operator
//     memilih sesi mana yang boleh dioperasikan bot, sisanya tetap manual.
//   - livechat_template : aturan balasan (kategori + kata kunci -> teks balasan).
//   - livechat_log : jejak setiap balasan otomatis yang terkirim (audit).
import { getTurso } from "./turso";
import { tsNow } from "./time";

let tablesEnsured = false;
async function ensureTables(env: Env): Promise<void> {
	if (tablesEnsured) return;
	const db = getTurso(env);
	for (const stmt of [
		`CREATE TABLE IF NOT EXISTS livechat_session (
			session_key TEXT PRIMARY KEY,
			customer_name TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL DEFAULT '',
			divisi TEXT NOT NULL DEFAULT '',
			last_message TEXT NOT NULL DEFAULT '',
			last_sender TEXT NOT NULL DEFAULT '',
			unread INTEGER NOT NULL DEFAULT 0,
			bot_enabled INTEGER NOT NULL DEFAULT 0,
			last_synced_at TEXT NOT NULL DEFAULT '',
			bot_updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS livechat_template (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			category TEXT NOT NULL DEFAULT '',
			keyword TEXT NOT NULL DEFAULT '',
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
	customer_name: string;
	category: string;
	divisi: string;
	last_message: string;
	last_sender: string;
	unread: number;
	bot_enabled: number;
	last_synced_at: string;
	bot_updated_at: string;
}

export interface LivechatTemplateRow {
	id: number;
	category: string;
	keyword: string;
	reply_text: string;
	active: number;
	sort_order: number;
	updated_at: string;
}

/** Dipanggil panel (role ADMIN/OPERATOR) untuk menampilkan daftar sesi + status toggle. */
export async function listSessions(env: Env): Promise<LivechatSessionRow[]> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT * FROM livechat_session ORDER BY unread DESC, last_synced_at DESC LIMIT 200`)
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

/**
 * Dipanggil userscript (auth via LIVECHAT_BOT_KEY, bukan sesi login) tiap
 * beberapa detik: upsert daftar sesi yang TERLIHAT di sidebar Kotak Masuk
 * DayLiveChat saat itu. bot_enabled TIDAK pernah disentuh dari sini -- hanya
 * panel (setSessionBot) yang boleh mengubahnya, supaya toggle operator tidak
 * pernah kereset cuma karena userscript sinkron ulang.
 */
export async function syncSessionsFromScript(
	env: Env,
	rows: Array<{ sessionKey: string; customerName?: string; category?: string; divisi?: string; lastMessage?: string; lastSender?: string; unread?: boolean }>,
): Promise<{ synced: number }> {
	await ensureTables(env);
	const db = getTurso(env);
	const now = tsNow();
	let n = 0;
	for (const row of rows) {
		const key = String(row.sessionKey || "").trim();
		if (!key) continue;
		await db
			.prepare(
				`INSERT INTO livechat_session (session_key, customer_name, category, divisi, last_message, last_sender, unread, bot_enabled, last_synced_at, bot_updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '')
				 ON CONFLICT(session_key) DO UPDATE SET
					customer_name = excluded.customer_name,
					category = excluded.category,
					divisi = excluded.divisi,
					last_message = excluded.last_message,
					last_sender = excluded.last_sender,
					unread = excluded.unread,
					last_synced_at = excluded.last_synced_at`,
			)
			.bind(
				key,
				String(row.customerName ?? "").slice(0, 200),
				String(row.category ?? "").slice(0, 100),
				String(row.divisi ?? "").slice(0, 100),
				String(row.lastMessage ?? "").slice(0, 2000),
				String(row.lastSender ?? "").slice(0, 30),
				row.unread ? 1 : 0,
				now,
			)
			.run();
		n++;
	}
	// Sesi yang sudah tidak sinkron > 2 jam dianggap sudah ditutup/selesai --
	// dibuang supaya daftar di panel tidak menumpuk sesi mati selamanya.
	await db.prepare(`DELETE FROM livechat_session WHERE last_synced_at < datetime(?, '-2 hours')`).bind(now).run();
	return { synced: n };
}

/** Dipanggil userscript: daftar session_key yang boleh dioperasikan bot saat ini. */
export async function pullEnabledSessions(env: Env): Promise<{ enabledKeys: string[]; templates: LivechatTemplateRow[] }> {
	await ensureTables(env);
	const db = getTurso(env);
	const sessions = await db
		.prepare(`SELECT session_key FROM livechat_session WHERE bot_enabled = 1`)
		.all<{ session_key: string }>();
	const templates = await db
		.prepare(`SELECT * FROM livechat_template WHERE active = 1 ORDER BY sort_order ASC, id ASC`)
		.all<LivechatTemplateRow>();
	return { enabledKeys: sessions.results.map((r) => r.session_key), templates: templates.results };
}

export async function listTemplates(env: Env): Promise<LivechatTemplateRow[]> {
	await ensureTables(env);
	const r = await getTurso(env).prepare(`SELECT * FROM livechat_template ORDER BY sort_order ASC, id ASC`).all<LivechatTemplateRow>();
	return r.results;
}

export async function saveTemplate(
	env: Env,
	data: { id?: number; category?: string; keyword?: string; replyText: string; active?: boolean; sortOrder?: number },
): Promise<void> {
	await ensureTables(env);
	const db = getTurso(env);
	const replyText = String(data.replyText ?? "").trim();
	if (!replyText) throw new Error("Isi balasan wajib diisi.");
	const category = String(data.category ?? "").trim().toLowerCase();
	const keyword = String(data.keyword ?? "").trim().toLowerCase();
	const active = data.active === false ? 0 : 1;
	const sortOrder = Number.isFinite(data.sortOrder) ? Number(data.sortOrder) : 0;
	if (data.id) {
		await db
			.prepare(`UPDATE livechat_template SET category = ?, keyword = ?, reply_text = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
			.bind(category, keyword, replyText, active, sortOrder, tsNow(), data.id)
			.run();
	} else {
		await db
			.prepare(`INSERT INTO livechat_template (category, keyword, reply_text, active, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.bind(category, keyword, replyText, active, sortOrder, tsNow())
			.run();
	}
}

export async function deleteTemplate(env: Env, id: number): Promise<void> {
	await ensureTables(env);
	await getTurso(env).prepare(`DELETE FROM livechat_template WHERE id = ?`).bind(id).run();
}

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
