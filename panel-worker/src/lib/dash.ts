// Port getDashboardDataFresh_ / normalizeDashboardRequest_ dari PanelCore.gs.
// Jauh lebih ringkas: activity_log di D1 -> WHERE / ORDER BY / LIMIT langsung,
// tidak perlu scan sheet + rollover + arsip seperti versi Apps Script.
import { getMaintenance, UserProfile } from "./db";
import { dateKeyNow } from "./time";

export interface DashOptions {
	page: number;
	pageSize: number;
	query: string;
	username: string;
	action: string;
	status: string;
	dateFrom: string; // yyyy-MM-dd
	dateTo: string; // yyyy-MM-dd
}

export function normalizeDashOptions(raw: unknown): DashOptions {
	if (typeof raw === "number") {
		return {
			page: 1,
			pageSize: Math.min(Math.max(raw || 100, 10), 250),
			query: "",
			username: "",
			action: "",
			status: "",
			dateFrom: "",
			dateTo: "",
		};
	}
	const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		page: Math.max(Number(v.page) || 1, 1),
		pageSize: Math.min(Math.max(Number(v.pageSize) || 75, 10), 200),
		query: String(v.query ?? "").trim(),
		username: String(v.username ?? "").trim(),
		action: String(v.action ?? "").trim(),
		status: String(v.status ?? "").trim(),
		dateFrom: String(v.dateFrom ?? "").trim(),
		dateTo: String(v.dateTo ?? "").trim(),
	};
}

export interface ActivityRow {
	ts: string;
	username: string;
	action: string;
	status: string;
	detail: string;
	content: string;
}

export async function getDashboardData(env: Env, profile: UserProfile, opts: DashOptions) {
	const isAdmin = profile.role === "ADMIN";
	const today = dateKeyNow();

	const where: string[] = [];
	const args: unknown[] = [];

	if (!isAdmin) {
		// operator/viewer: hanya aktivitas sendiri, hanya hari ini
		where.push("username = ?");
		args.push(profile.username);
		where.push("substr(ts,1,10) = ?");
		args.push(today);
	} else {
		if (opts.username) {
			where.push("username = ?");
			args.push(opts.username);
		}
		if (opts.dateFrom) {
			where.push("substr(ts,1,10) >= ?");
			args.push(opts.dateFrom);
		}
		if (opts.dateTo) {
			where.push("substr(ts,1,10) <= ?");
			args.push(opts.dateTo);
		}
	}
	if (opts.action) {
		where.push("upper(action) = ?");
		args.push(opts.action.toUpperCase());
	}
	if (opts.status) {
		where.push("upper(status) = ?");
		args.push(opts.status.toUpperCase());
	}
	if (opts.query) {
		const like = `%${opts.query}%`;
		where.push(
			"(username LIKE ? OR action LIKE ? OR status LIKE ? OR detail LIKE ? OR content LIKE ?)",
		);
		args.push(like, like, like, like, like);
	}
	const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

	const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM activity_log ${whereSql}`)
		.bind(...args)
		.first<{ n: number }>();
	const total = Number(totalRow?.n ?? 0);
	const totalPages = Math.max(Math.ceil(total / opts.pageSize), 1);
	const page = Math.min(opts.page, totalPages);
	const offset = (page - 1) * opts.pageSize;

	const rowsRes = await env.DB.prepare(
		`SELECT ts, username, action, status, detail, content
		 FROM activity_log ${whereSql}
		 ORDER BY id DESC LIMIT ? OFFSET ?`,
	)
		.bind(...args, opts.pageSize, offset)
		.all<Record<string, string>>();
	// Frontend lama membaca baris sebagai ARRAY: [ts, user, action, status, detail, content, source].
	const rows: string[][] = (rowsRes.results ?? []).map((r) => [
		r.ts ?? "",
		r.username ?? "",
		r.action ?? "",
		r.status ?? "",
		r.detail ?? "",
		r.content ?? "",
		"HARI INI",
	]);

	// Statistik: cakupan HARI INI untuk user ini (admin = semua user hari ini).
	const statArgs: unknown[] = [today];
	let statScope = "substr(ts,1,10) = ?";
	if (!isAdmin) {
		statScope += " AND username = ?";
		statArgs.push(profile.username);
	}
	const s = await env.DB.prepare(
		`SELECT
		   COUNT(*) AS today,
		   SUM(CASE WHEN action = 'LOGIN' AND status = 'BERHASIL' THEN 1 ELSE 0 END) AS login,
		   SUM(CASE WHEN upper(action) LIKE '%SEND%' OR upper(action) LIKE '%KIRIM%' THEN 1 ELSE 0 END) AS sends,
		   SUM(CASE WHEN status = 'BERHASIL' THEN 1 ELSE 0 END) AS success,
		   SUM(CASE WHEN upper(status) IN ('GAGAL','ERROR') THEN 1 ELSE 0 END) AS failed
		 FROM activity_log WHERE ${statScope}`,
	)
		.bind(...statArgs)
		.first<Record<string, number>>();

	const stats = {
		today: Number(s?.today ?? 0),
		login: Number(s?.login ?? 0),
		sends: Number(s?.sends ?? 0),
		success: Number(s?.success ?? 0),
		failed: Number(s?.failed ?? 0),
		found: total,
	};

	const distinct = async (col: "username" | "action" | "status"): Promise<string[]> => {
		if (isAdmin) {
			const res = await env.DB.prepare(
				`SELECT DISTINCT ${col} AS v FROM activity_log WHERE ${col} <> '' ORDER BY v LIMIT 200`,
			).all<{ v: string }>();
			return (res.results ?? []).map((r) => r.v);
		}
		const res = await env.DB.prepare(
			`SELECT DISTINCT ${col} AS v FROM activity_log
			 WHERE ${col} <> '' AND username = ? AND substr(ts,1,10) = ? ORDER BY v LIMIT 200`,
		)
			.bind(profile.username, today)
			.all<{ v: string }>();
		return (res.results ?? []).map((r) => r.v);
	};

	return {
		role: profile.role,
		rows,
		stats,
		maintenance: await getMaintenance(env),
		pagination: {
			page,
			pageSize: opts.pageSize,
			total,
			totalPages,
			hasPrev: page > 1,
			hasNext: page < totalPages,
		},
		sourceInfo: { currentTotal: total, backupTotal: 0, archiveScanned: 0, scanLimited: false },
		filterOptions: {
			usernames: await distinct("username"),
			actions: await distinct("action"),
			statuses: await distinct("status"),
		},
	};
}
