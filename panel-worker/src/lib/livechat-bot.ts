// Modul "Live Chat Auto-Reply" — bot balas otomatis khusus sesi chat
// DayLiveChat (daylivechat.com, dipakai CS HUGOTOGEL) yang SENGAJA dipilih
// operator lewat panel ini.
//
// PENTING kenapa arsitekturnya begini: DayLiveChat mengunci login akun CS ke
// IP tertentu (fitur keamanan resmi mereka -- terbukti lewat percobaan nyata:
// login dari Cloudflare Worker/Durable Object SELALU ditolak 403 "IP tidak
// diizinkan untuk akun ini", walau kredensial benar), dan tidak ada akses
// admin DayLiveChat di sini untuk melonggarkan itu. Jadi "mata & tangan"
// bot-nya TERPAKSA jalan dari userscript browser (lihat userscripts/) yang
// beroperasi dari IP CS yang SUDAH diizinkan -- BUKAN dari server. Userscript
// itu memakai token login yang SUDAH ADA di localStorage browser (hasil login
// manual CS seperti biasa) + client Socket.IO bawaan halaman itu sendiri,
// jadi TIDAK PERNAH menyimpan password di mana pun.
//
// Modul ini murni penyimpanan (Turso), dipakai dari 2 arah:
//   - Panel (sesi login ADMIN/OPERATOR): lihat/toggle sesi, kelola template.
//   - Userscript (auth via secret LIVECHAT_BOT_KEY, bukan sesi login): sync
//     daftar sesi yang terlihat, tarik sesi mana yang bot_enabled + template,
//     lapor tiap balasan otomatis yang terkirim.
//
// Tabel:
//   - livechat_session : sesi chat yang pernah terlihat userscript + status
//     bot_enabled (di-toggle dari panel) -- HANYA sesi yang diaktifkan
//     operator yang dibalas otomatis, sisanya tetap manual.
//   - livechat_template : daftar kalimat balasan (dipilih ACAK tiap bot
//     membalas -- bot ini khusus pacify member spam/kasar, bukan FAQ, jadi
//     balasannya TIDAK memandang isi keluhan member).
//   - livechat_log      : jejak setiap balasan otomatis yang terkirim.
import { getTurso } from "./turso";
import { tsNow } from "./time";

let tablesEnsured = false;
async function ensureTables(env: Env): Promise<void> {
	if (tablesEnsured) return;
	const db = getTurso(env);
	for (const stmt of [
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
	// livechat_session sempat dibuat versi lama (arsitektur userscript, sebelum
	// pivot ke login langsung) -- CREATE TABLE IF NOT EXISTS di atas TIDAK
	// mengubah tabel yang sudah ada, jadi kolom baru (queue_code, last_seen_at)
	// harus ditambah lewat ALTER lazy ini supaya query lama yang sempat
	// ke-deploy sebelum migrasi ini tidak lagi gagal dengan "no such column".
	for (const stmt of [
		`ALTER TABLE livechat_session ADD COLUMN queue_code TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE livechat_session ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''`,
	]) {
		try {
			await db.prepare(stmt).run();
		} catch {
			/* kolom sudah ada -- aman diabaikan */
		}
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

/**
 * Dipanggil userscript (auth via LIVECHAT_BOT_KEY, bukan sesi login) tiap
 * beberapa detik: upsert daftar sesi yang terlihat lewat GET /api/chats/inbox
 * (dipanggil userscript langsung ke DayLiveChat, browser CS sendiri yang
 * IP-nya sudah diizinkan). bot_enabled TIDAK PERNAH disentuh dari sini --
 * hanya setSessionBot (dipicu toggle operator di panel) yang boleh mengubahnya,
 * supaya toggle operator tidak pernah kereset cuma karena sinkron ulang.
 */
export async function syncSessionsFromScript(
	env: Env,
	rows: Array<{ sessionKey: string; queueCode?: string; customerName?: string; divisi?: string; lastMessage?: string; lastSender?: string }>,
): Promise<{ synced: number }> {
	await ensureTables(env);
	const db = getTurso(env);
	const now = tsNow();
	let n = 0;
	const keys: string[] = [];
	for (const row of rows) {
		const key = String(row.sessionKey || "").trim();
		if (!key) continue;
		keys.push(key);
		await db
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
		n++;
	}
	// `rows` SELALU daftar LENGKAP Kotak Masuk saat ini (dikirim userscript
	// tiap tick, termasuk kalau kosong) -- jadi sesi manual (bot_enabled=0)
	// yang tidak ada lagi di daftar ini berarti sudah ditutup/diarsipkan di
	// DayLiveChat, langsung dibuang SEKARANG JUGA (bukan nunggu basi berjam-jam
	// seperti sebelumnya). Sesi yang bot_enabled=1 tetap dikasih toleransi 15
	// menit sebelum ikut dibuang -- supaya toggle operator tidak hilang cuma
	// gara-gara 1 kali sinkron sempat gagal/telat.
	if (keys.length) {
		const placeholders = keys.map(() => "?").join(",");
		await db
			.prepare(`DELETE FROM livechat_session WHERE bot_enabled = 0 AND session_key NOT IN (${placeholders})`)
			.bind(...keys)
			.run();
	} else {
		await db.prepare(`DELETE FROM livechat_session WHERE bot_enabled = 0`).run();
	}
	await db.prepare(`DELETE FROM livechat_session WHERE bot_enabled = 1 AND last_seen_at < datetime(?, '-15 minutes')`).bind(now).run();
	return { synced: n };
}

/** Dipanggil userscript: daftar session_key yang boleh dioperasikan bot saat ini + template aktif. */
export async function pullEnabledSessions(env: Env): Promise<{ enabledKeys: string[]; templates: LivechatTemplateRow[] }> {
	await ensureTables(env);
	const db = getTurso(env);
	const sessions = await db.prepare(`SELECT session_key FROM livechat_session WHERE bot_enabled = 1`).all<{ session_key: string }>();
	const templates = await db.prepare(`SELECT * FROM livechat_template WHERE active = 1 ORDER BY sort_order ASC, id ASC`).all<LivechatTemplateRow>();
	return { enabledKeys: sessions.results.map((r) => r.session_key), templates: templates.results };
}

// --- Template balasan (daftar acak, tanpa memandang isi keluhan member) ---

export async function listTemplates(env: Env): Promise<LivechatTemplateRow[]> {
	await ensureTables(env);
	const r = await getTurso(env).prepare(`SELECT * FROM livechat_template ORDER BY sort_order ASC, id ASC`).all<LivechatTemplateRow>();
	return r.results;
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
