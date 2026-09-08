// Akses D1: profil user + settings/maintenance. Port getUserProfile_ / getMaintenanceSettings_.

export interface UserProfile {
	id: number;
	username: string;
	role: string; // ADMIN | OPERATOR | VIEWER
	status: string; // AKTIF | NONAKTIF | TERKUNCI
	displayName: string;
	websites: string[]; // UPPERCASE
	permissions: { telegram: boolean; linktree: boolean; panelz: boolean };
	passwordHash: string;
	failedLogin: number;
	lockedUntil: string | null; // "yyyy-MM-dd HH:mm:ss" GMT+7 atau null
}

export async function getUserProfile(env: Env, username: string): Promise<UserProfile | null> {
	const lc = String(username ?? "").trim().toLowerCase();
	if (!lc) return null;
	const row = await env.DB.prepare(
		`SELECT id, username, password_hash, websites,
		        perm_telegram, perm_linktree, perm_panelz,
		        role, status, display_name, failed_login, locked_until
		 FROM users WHERE username_lc = ?`,
	)
		.bind(lc)
		.first<Record<string, unknown>>();
	if (!row) return null;

	let sites: string[] = [];
	try {
		sites = JSON.parse(String(row.websites ?? "[]"));
	} catch {
		sites = String(row.websites ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	return {
		id: Number(row.id),
		username: String(row.username ?? ""),
		role: String(row.role ?? "OPERATOR").toUpperCase(),
		status: String(row.status ?? "AKTIF").toUpperCase(),
		displayName: String(row.display_name || row.username || ""),
		websites: sites.map((s) => String(s).trim().toUpperCase()).filter(Boolean),
		permissions: {
			telegram: !!row.perm_telegram,
			linktree: !!row.perm_linktree,
			panelz: !!row.perm_panelz,
		},
		passwordHash: String(row.password_hash ?? ""),
		failedLogin: Number(row.failed_login ?? 0),
		lockedUntil: (row.locked_until as string) || null,
	};
}

export interface Maintenance {
	enabled: boolean;
	message: string;
}

export async function getMaintenance(env: Env): Promise<Maintenance> {
	const res = await env.DB.prepare(
		`SELECT key, value FROM settings WHERE key IN ('maintenance','maintenance_message')`,
	).all<{ key: string; value: string }>();
	const m: Record<string, string> = {};
	for (const r of res.results ?? []) m[r.key] = r.value;
	return {
		enabled: String(m.maintenance ?? "").toUpperCase() === "TRUE",
		message: m.maintenance_message || "Panel sedang dalam pemeliharaan.",
	};
}
