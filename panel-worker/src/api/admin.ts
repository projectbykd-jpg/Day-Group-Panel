// Port PanelCore.gs: adminListUsersInternal_ / adminSaveUserInternal_ /
// adminDeleteUserInternal_ / adminResetUserLockInternal_ + adminListActiveSessions.
import { requireSession } from "./auth";
import { hashPassword } from "../lib/crypto";
import { logActivity } from "../lib/activity";
import { SessionRecord } from "../lib/session";

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
	const out: { token: string; username: string; createdAt: string }[] = [];
	for (const k of list.keys) {
		const raw = await env.SESS.get(k.name);
		if (!raw) continue;
		try {
			const rec = JSON.parse(raw) as SessionRecord;
			out.push({
				token: k.name.slice(0, 12) + "…",
				username: rec.username,
				createdAt: new Date(rec.createdAt).toISOString(),
			});
		} catch {
			/* skip */
		}
	}
	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
}
