// Sesi token disimpan di KV (binding SESS). Port dgCreateSession_ / dgLoadSession_.
// Tidak ada timeout aktif; TTL 180 hari hanya untuk pembersihan otomatis KV.
//
// FALLBACK D1: kuota KV Free = 1000 write/hari. Kalau jebol (mis. cron yang
// terlalu sering menulis KV), SESS.put melempar "KV put() limit exceeded" dan
// TIDAK ADA yang bisa login. Karena itu createSession menulis ke tabel D1
// `sessions` bila KV gagal, dan loadSession membaca D1 saat KV miss.

const TTL_SECONDS = 60 * 60 * 24 * 180;

export interface SessionRecord {
	username: string;
	createdAt: number;
	expiresAt: number;
}

export async function createSession(env: Env, username: string): Promise<string> {
	const token =
		"dg_" +
		crypto.randomUUID().replace(/-/g, "") +
		crypto.randomUUID().replace(/-/g, "").slice(0, 24);
	const rec: SessionRecord = {
		username,
		createdAt: Date.now(),
		expiresAt: Date.now() + TTL_SECONDS * 1000,
	};
	let kvOk = false;
	try {
		await env.SESS.put(token, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
		kvOk = true;
	} catch {
		/* kuota KV habis / KV error -> pakai D1 */
	}
	if (!kvOk) {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(token, username, rec.createdAt, rec.expiresAt)
			.run();
	}
	return token;
}

export async function loadSession(env: Env, token: string): Promise<SessionRecord | null> {
	token = String(token ?? "").trim();
	if (!token.startsWith("dg_")) return null;

	let raw: string | null = null;
	try {
		raw = await env.SESS.get(token);
	} catch {
		/* KV error -> coba D1 */
	}
	if (raw) {
		try {
			const rec = JSON.parse(raw) as SessionRecord;
			if (!rec.expiresAt || rec.expiresAt <= Date.now()) {
				try {
					await env.SESS.delete(token);
				} catch {
					/* abaikan */
				}
				return null;
			}
			return rec;
		} catch {
			return null;
		}
	}

	// KV miss -> cek fallback D1
	const row = await env.DB.prepare(
		`SELECT username, created_at, expires_at FROM sessions WHERE token = ?`,
	)
		.bind(token)
		.first<{ username: string; created_at: number; expires_at: number }>();
	if (!row) return null;
	if (!row.expires_at || row.expires_at <= Date.now()) {
		await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
		return null;
	}
	return { username: row.username, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
	if (!token) return;
	try {
		await env.SESS.delete(token);
	} catch {
		/* abaikan */
	}
	try {
		await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
	} catch {
		/* abaikan */
	}
}
