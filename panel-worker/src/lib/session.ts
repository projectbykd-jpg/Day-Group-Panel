// Sesi token disimpan di KV (binding SESS). Port dgCreateSession_ / dgLoadSession_.
// Tidak ada timeout aktif; TTL 180 hari hanya untuk pembersihan otomatis KV.

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
	await env.SESS.put(token, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
	return token;
}

export async function loadSession(env: Env, token: string): Promise<SessionRecord | null> {
	token = String(token ?? "").trim();
	if (!token.startsWith("dg_")) return null;
	const raw = await env.SESS.get(token);
	if (!raw) return null;
	try {
		const rec = JSON.parse(raw) as SessionRecord;
		if (!rec.expiresAt || rec.expiresAt <= Date.now()) {
			await env.SESS.delete(token);
			return null;
		}
		return rec;
	} catch {
		return null;
	}
}

export async function deleteSession(env: Env, token: string): Promise<void> {
	if (token) await env.SESS.delete(token);
}
