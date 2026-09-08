// Port PanelCore.gs: adminListUsersInternal_ / adminSaveUserInternal_ /
// adminDeleteUserInternal_ / adminResetUserLockInternal_ + adminListActiveSessions
// + kontrol Auto Posting & retensi Activity Log (versi Cloudflare).
import { requireSession } from "./auth";
import { hashPassword } from "../lib/crypto";
import { logActivity } from "../lib/activity";
import { getUserProfile } from "../lib/db";
import { SessionRecord } from "../lib/session";
import { tsNow } from "../lib/time";

const OFFSET_MS = 7 * 60 * 60 * 1000;
const msToWIB = (ms: number): string =>
	ms ? new Date(ms + OFFSET_MS).toISOString().slice(0, 19).replace("T", " ") : "-";

async function getSetting(env: Env, key: string): Promise<string> {
	const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
	return String(r?.value ?? "");
}
async function setSetting(env: Env, key: string, value: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	)
		.bind(key, value)
		.run();
}
export async function isAutoPostEnabled(env: Env): Promise<boolean> {
	return String(await getSetting(env, "autopost_enabled") || "TRUE").toUpperCase().trim() !== "FALSE";
}

const ROLES = ["ADMIN", "OPERATOR", "VIEWER"];
const STATUSES = ["AKTIF", "NONAKTIF", "TERKUNCI"];

function toWebsitesJson(input: unknown): string {
	let arr: string[];
	if (Array.isArray(input)) arr = input.map((x) => String(x));
	else arr = String(input ?? "").split(",");
	return JSON.stringify(
		arr.map((s) => s.trim().toUpperCase()).filter(Boolean),
	);
}

export async function adminListUsers(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	const res = await env.DB.prepare(
		`SELECT username, display_name, websites, role, status,
		        perm_telegram, perm_linktree, perm_panelz, last_login_at, failed_login, note
		 FROM users ORDER BY lower(username)`,
	).all<Record<string, unknown>>();
	return (res.results ?? []).map((r) => {
		let sites = "";
		try {
			sites = (JSON.parse(String(r.websites ?? "[]")) as string[]).join(",");
		} catch {
			sites = String(r.websites ?? "");
		}
		return {
			username: String(r.username ?? ""),
			displayName: String(r.display_name ?? ""),
			websites: sites,
			role: String(r.role ?? "OPERATOR").toUpperCase(),
			status: String(r.status ?? "AKTIF").toUpperCase(),
			telegram: !!r.perm_telegram,
			linktree: !!r.perm_linktree,
			panelz: !!r.perm_panelz,
			lastLogin: String(r.last_login_at ?? ""),
			failed: Number(r.failed_login ?? 0),
			note: String(r.note ?? ""),
		};
	});
}

export async function adminSaveUser(env: Env, token: string, data: Record<string, unknown>) {
	const admin = await requireSession(env, token, { admin: true });
	data = data ?? {};
	const original = String(data.originalUsername ?? "").trim();
	const username = String(data.username ?? "").trim();
	if (!username) throw new Error("Username wajib diisi.");
	const role = String(data.role ?? "OPERATOR").toUpperCase();
	const status = String(data.status ?? "AKTIF").toUpperCase();
	if (!ROLES.includes(role)) throw new Error("Role tidak valid.");
	if (!STATUSES.includes(status)) throw new Error("Status akun tidak valid.");

	const existing = await env.DB.prepare(`SELECT id, username FROM users WHERE username_lc = ?`)
		.bind(username.toLowerCase())
		.first<{ id: number; username: string }>();
	const originalRow = original
		? await env.DB.prepare(`SELECT id, username, role FROM users WHERE username_lc = ?`)
				.bind(original.toLowerCase())
				.first<{ id: number; username: string; role: string }>()
		: null;

	if (!original && existing) throw new Error("Username sudah digunakan.");
	if (original && !originalRow) throw new Error("User yang diedit tidak ditemukan.");
	if (original && existing && existing.id !== originalRow!.id) {
		throw new Error("Username baru sudah digunakan akun lain.");
	}
	if (
		originalRow &&
		originalRow.username.toLowerCase() === admin.username.toLowerCase() &&
		(role !== "ADMIN" || status !== "AKTIF")
	) {
		throw new Error("Akun admin yang sedang digunakan tidak boleh diturunkan role atau dinonaktifkan.");
	}

	const password = String(data.password ?? "");
	const websitesJson = toWebsitesJson(data.websites);
	const displayName = String(data.displayName ?? username).trim();
	const note = String(data.note ?? "");
	const telegram = data.telegram ? 1 : 0;
	const linktree = data.linktree ? 1 : 0;
	const panelz = data.panelz ? 1 : 0;

	if (originalRow) {
		const sets = [
			"username = ?",
			"username_lc = ?",
			"websites = ?",
			"perm_telegram = ?",
			"perm_linktree = ?",
			"perm_panelz = ?",
			"role = ?",
			"status = ?",
			"display_name = ?",
			"note = ?",
		];
		const args: unknown[] = [
			username,
			username.toLowerCase(),
			websitesJson,
			telegram,
			linktree,
			panelz,
			role,
			status,
			displayName,
			note,
		];
		if (password) {
			sets.push("password_hash = ?");
			args.push(await hashPassword(password));
		}
		args.push(originalRow.id);
		await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
		await logActivity(
			env,
			admin.username,
			"EDIT USER",
			`Target: ${username} | Role: ${role} | Status: ${status}`,
			"BERHASIL",
			`Website: ${websitesJson}`,
		);
		return { success: true, message: "User berhasil diperbarui." };
	}

	if (!password) throw new Error("Password wajib untuk akun baru.");
	await env.DB.prepare(
		`INSERT INTO users
		   (username, username_lc, password_hash, websites, perm_telegram, perm_linktree, perm_panelz,
		    role, status, display_name, note)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			username.toLowerCase(),
			await hashPassword(password),
			websitesJson,
			telegram,
			linktree,
			panelz,
			role,
			status,
			displayName,
			note,
		)
		.run();
	await logActivity(
		env,
		admin.username,
		"TAMBAH USER",
		`Target: ${username} | Role: ${role} | Status: ${status}`,
		"BERHASIL",
		`Website: ${websitesJson}`,
	);
	return { success: true, message: "User baru berhasil ditambahkan." };
}

export async function adminDeleteUser(env: Env, token: string, targetUsername: string) {
	const admin = await requireSession(env, token, { admin: true });
	const target = String(targetUsername ?? "").trim();
	if (!target) throw new Error("Username target kosong.");
	if (target.toLowerCase() === admin.username.toLowerCase()) {
		throw new Error("Anda tidak dapat menghapus akun admin yang sedang digunakan.");
	}
	const row = await env.DB.prepare(`SELECT id, role FROM users WHERE username_lc = ?`)
		.bind(target.toLowerCase())
		.first<{ id: number; role: string }>();
	if (!row) throw new Error("User tidak ditemukan.");
	if (String(row.role).toUpperCase() === "ADMIN") {
		const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM users WHERE upper(role) = 'ADMIN'`).first<{
			n: number;
		}>();
		if (Number(cnt?.n ?? 0) <= 1) throw new Error("Admin terakhir tidak boleh dihapus.");
	}
	await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(row.id).run();
	await logActivity(env, admin.username, "HAPUS USER", "Target: " + target, "BERHASIL", "Akun dihapus");
	return { success: true, message: "User " + target + " berhasil dihapus." };
}

export async function adminResetUserLock(env: Env, token: string, targetUsername: string) {
	const admin = await requireSession(env, token, { admin: true });
	const target = String(targetUsername ?? "").trim();
	const row = await env.DB.prepare(`SELECT id, username, status FROM users WHERE username_lc = ?`)
		.bind(target.toLowerCase())
		.first<{ id: number; username: string; status: string }>();
	if (!row) throw new Error("User tidak ditemukan.");
	const newStatus = String(row.status).toUpperCase() === "TERKUNCI" ? "AKTIF" : row.status;
	await env.DB.prepare(
		`UPDATE users SET failed_login = 0, locked_until = NULL, status = ? WHERE id = ?`,
	)
		.bind(newStatus, row.id)
		.run();
	await logActivity(
		env,
		admin.username,
		"RESET KUNCI USER",
		"Target: " + row.username,
		"BERHASIL",
		"Login gagal direset menjadi 0",
	);
	return { success: true, message: "Kunci dan login gagal " + row.username + " berhasil direset." };
}

export async function adminListActiveSessions(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	const list = await env.SESS.list({ prefix: "dg_" });
	const now = Date.now();

	// Kelompokkan token per username.
	const byUser: Record<string, { username: string; count: number; firstLoginMs: number; lastExpiresMs: number }> = {};
	for (const k of list.keys) {
		const raw = await env.SESS.get(k.name);
		if (!raw) continue;
		let rec: SessionRecord;
		try {
			rec = JSON.parse(raw) as SessionRecord;
		} catch {
			continue;
		}
		if (!rec.username || !rec.expiresAt || Number(rec.expiresAt) <= now) continue;
		const key = rec.username.toLowerCase();
		if (!byUser[key]) byUser[key] = { username: rec.username, count: 0, firstLoginMs: 0, lastExpiresMs: 0 };
		const g = byUser[key];
		g.count++;
		const created = Number(rec.createdAt || 0);
		if (created && (!g.firstLoginMs || created < g.firstLoginMs)) g.firstLoginMs = created;
		if (Number(rec.expiresAt) > g.lastExpiresMs) g.lastExpiresMs = Number(rec.expiresAt);
	}

	const sessions = [];
	for (const key of Object.keys(byUser).sort()) {
		const g = byUser[key];
		const p = await getUserProfile(env, g.username);
		const websites = p ? p.websites : [];
		const telegramOn = !!(p && p.permissions.telegram);
		sessions.push({
			username: g.username,
			displayName: p ? p.displayName : g.username,
			role: p ? p.role : "-",
			websites: websites.join(", "),
			telegram: telegramOn,
			sessions: g.count,
			loginAt: msToWIB(g.firstLoginMs),
			expiresAt: msToWIB(g.lastExpiresMs),
			autoPostEligible: telegramOn && websites.length > 0,
		});
	}

	return {
		success: true,
		generatedAt: tsNow(),
		autoPostEnabled: await isAutoPostEnabled(env),
		totalUsers: sessions.length,
		totalSessions: sessions.reduce((n, s) => n + s.sessions, 0),
		sessions,
	};
}

// --- Kontrol Auto Posting Prediksi (settings.autopost_enabled) ------------
export async function adminSetAutoPost(env: Env, token: string, enabled: boolean) {
	const s = await requireSession(env, token, { admin: true });
	await setSetting(env, "autopost_enabled", enabled ? "TRUE" : "FALSE");
	await setSetting(env, "updated_by", s.username);
	await setSetting(env, "updated_at", tsNow());
	await logActivity(
		env,
		s.username,
		"AUTO POSTING",
		enabled ? "Auto posting prediksi diaktifkan" : "Auto posting prediksi dinonaktifkan",
		"BERHASIL",
		"",
	);
	return {
		success: true,
		enabled,
		message: enabled
			? "Auto Posting Prediksi AKTIF. Pastikan cron eksternal memanggil /__cron?job=autopost tiap menit."
			: "Auto Posting Prediksi DINONAKTIFKAN. Router akan melewati semua sesi jam.",
	};
}

// --- Retensi Activity Log (pengganti "backup" sheet Apps Script) ----------
const LOG_RETENTION_DAYS = 7;

export async function adminPruneActivityLog(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	const cutoff = new Date(Date.now() + OFFSET_MS - LOG_RETENTION_DAYS * 864e5).toISOString().slice(0, 10);
	const before = await env.DB.prepare(`SELECT COUNT(*) n FROM activity_log`).first<{ n: number }>();
	await env.DB.prepare(`DELETE FROM activity_log WHERE substr(ts,1,10) < ?`).bind(cutoff).run();
	const after = await env.DB.prepare(`SELECT COUNT(*) n FROM activity_log`).first<{ n: number }>();
	const removed = Number(before?.n ?? 0) - Number(after?.n ?? 0);
	await setSetting(env, "log_pruned_at", tsNow());
	await logActivity(
		env,
		s.username,
		"RETENSI LOG",
		`Pangkas log < ${cutoff}: ${removed} baris dihapus, tersisa ${after?.n ?? 0}.`,
		"BERHASIL",
		"",
	);
	return {
		success: true,
		removed,
		remaining: Number(after?.n ?? 0),
		message: `${removed} baris log lama (> ${LOG_RETENTION_DAYS} hari) dihapus. Tersisa ${after?.n ?? 0} baris.`,
	};
}

export async function adminSetLogRetention(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	await setSetting(env, "log_retention_enabled", "TRUE");
	await logActivity(env, s.username, "RETENSI LOG", "Auto retensi log 7 hari diaktifkan", "BERHASIL", "");
	return {
		success: true,
		message:
			`Auto retensi AKTIF: cron harian akan menghapus log lebih tua dari ${LOG_RETENTION_DAYS} hari ` +
			"(dijalankan lewat /__cron). Tidak ada sheet backup terpisah — semua log di database utama.",
	};
}

/** Dipanggil dari cron harian (index.ts) — hening, tanpa sesi. */
export async function pruneActivityLogCron(env: Env): Promise<number> {
	if (String(await getSetting(env, "log_retention_enabled") || "TRUE").toUpperCase() === "FALSE") return 0;
	const cutoff = new Date(Date.now() + OFFSET_MS - LOG_RETENTION_DAYS * 864e5).toISOString().slice(0, 10);
	const res = await env.DB.prepare(`DELETE FROM activity_log WHERE substr(ts,1,10) < ?`).bind(cutoff).run();
	await setSetting(env, "log_pruned_at", tsNow());
	return res.meta?.changes ?? 0;
}
