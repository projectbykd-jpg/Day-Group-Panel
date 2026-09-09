// Menu "Laporan Harian" — port PANEL AUTO (Code.cpp) ke Worker.
// Bagian ini: kredensial per operator + snapshot hasil di D1 + helper umum.
import { tsNow } from "./time";

export interface LapCreds {
	linkAdmin: string;
	cookieAdmin: string;
	linkMotion: string;
	tokenMotion: string;
	linkMozart: string;
	cookieMozart: string;
	mozartAccounts: string;
}

const EMPTY: LapCreds = {
	linkAdmin: "",
	cookieAdmin: "",
	linkMotion: "",
	tokenMotion: "",
	linkMozart: "",
	cookieMozart: "",
	mozartAccounts: "",
};

export async function lapLoadCreds(env: Env, username: string): Promise<LapCreds> {
	const r = await env.DB.prepare(`SELECT * FROM lap_credentials WHERE username = ?`)
		.bind(username)
		.first<Record<string, string>>();
	if (!r) return { ...EMPTY };
	return {
		linkAdmin: String(r.link_admin || ""),
		cookieAdmin: String(r.cookie_admin || ""),
		linkMotion: String(r.link_motion || ""),
		tokenMotion: String(r.token_motion || ""),
		linkMozart: String(r.link_mozart || ""),
		cookieMozart: String(r.cookie_mozart || ""),
		mozartAccounts: String(r.mozart_accounts || ""),
	};
}

export async function lapSaveCreds(env: Env, username: string, data: Partial<LapCreds>): Promise<LapCreds> {
	const cur = await lapLoadCreds(env, username);
	const linkAdminRaw = pick(data.linkAdmin, cur.linkAdmin);
	const linkMotionRaw = pick(data.linkMotion, cur.linkMotion);
	const linkMozartRaw = pick(data.linkMozart, cur.linkMozart);
	const next: LapCreds = {
		// Link disimpan sebagai scheme://host saja — path seperti "/wd" atau
		// "/riwayat-pga" bikin URL API salah.
		linkAdmin: linkAdminRaw ? hostOnly(linkAdminRaw) : "",
		cookieAdmin: pick(data.cookieAdmin, cur.cookieAdmin),
		linkMotion: linkMotionRaw ? hostOnly(linkMotionRaw) : "",
		tokenMotion: pick(data.tokenMotion, cur.tokenMotion),
		linkMozart: linkMozartRaw ? hostOnly(linkMozartRaw) : "",
		cookieMozart: pick(data.cookieMozart, cur.cookieMozart),
		mozartAccounts: data.mozartAccounts === undefined ? cur.mozartAccounts : String(data.mozartAccounts),
	};
	await env.DB.prepare(
		`INSERT INTO lap_credentials
		   (username, link_admin, cookie_admin, link_motion, token_motion, link_mozart, cookie_mozart, mozart_accounts, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   link_admin=excluded.link_admin, cookie_admin=excluded.cookie_admin,
		   link_motion=excluded.link_motion, token_motion=excluded.token_motion,
		   link_mozart=excluded.link_mozart, cookie_mozart=excluded.cookie_mozart,
		   mozart_accounts=excluded.mozart_accounts,
		   updated_at=excluded.updated_at`,
	)
		.bind(
			username,
			next.linkAdmin,
			next.cookieAdmin,
			next.linkMotion,
			next.tokenMotion,
			next.linkMozart,
			next.cookieMozart,
			next.mozartAccounts,
			tsNow(),
		)
		.run();
	return next;
}
function pick(v: string | undefined, fallback: string): string {
	return v === undefined ? fallback : String(v).trim();
}

// -------------------------------------------------------------------------
// Snapshot hasil per modul
// -------------------------------------------------------------------------
export async function lapSaveResults(env: Env, username: string, map: Record<string, unknown[]>): Promise<void> {
	const now = tsNow();
	const stmts = Object.keys(map).map((mod) =>
		env.DB.prepare(
			`INSERT INTO lap_result (username, module, data, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(username, module) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
		).bind(username, mod, JSON.stringify(map[mod] ?? []), now),
	);
	for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
}

export async function lapLoadResults(env: Env, username: string): Promise<Record<string, unknown>> {
	const res = await env.DB.prepare(`SELECT module, data, updated_at FROM lap_result WHERE username = ?`)
		.bind(username)
		.all<{ module: string; data: string; updated_at: string }>();
	const out: Record<string, unknown> = {};
	for (const r of res.results ?? []) {
		try {
			out[r.module] = JSON.parse(r.data);
		} catch {
			out[r.module] = [];
		}
	}
	return out;
}

// -------------------------------------------------------------------------
// Helper umum
// -------------------------------------------------------------------------
export const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function normLink(raw: string, fallback: string): string {
	let s = String(raw || "").trim() || fallback;
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	return s.replace(/\/+$/, "");
}

/** Ambil scheme://host saja (buang path/query/hash) — untuk base URL API. */
export function hostOnly(raw: string, fallback = ""): string {
	let s = String(raw || "").trim() || fallback;
	if (!s) return "";
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	const m = s.match(/^(https?:\/\/[^/\s?#]+)/i);
	return m ? m[1] : s.replace(/\/+$/, "");
}

export function num(v: unknown): number {
	const n = Number(String(v === undefined || v === null ? 0 : v).replace(/[^0-9.\-]/g, ""));
	return isNaN(n) ? 0 : n;
}

/** POST JSON, paralel per batch, dengan batas total request. */
export async function postJsonBatch(
	reqs: { url: string; headers: Record<string, string>; body: unknown }[],
	batchSize = 15,
): Promise<(unknown | null)[]> {
	const out: (unknown | null)[] = [];
	for (let i = 0; i < reqs.length; i += batchSize) {
		const chunk = reqs.slice(i, i + batchSize);
		const settled = await Promise.allSettled(
			chunk.map((r) =>
				fetch(r.url, {
					method: "POST",
					headers: { "content-type": "application/json", ...r.headers },
					body: JSON.stringify(r.body),
				}).then((res) => res.text()),
			),
		);
		for (const s of settled) {
			if (s.status !== "fulfilled") {
				out.push(null);
				continue;
			}
			try {
				out.push(JSON.parse(s.value));
			} catch {
				out.push(null);
			}
		}
	}
	return out;
}

/** Ambil username murni dari deskripsi transaksi Motion. */
export function extractPureUsername(item: Record<string, unknown>): string {
	if (!item) return "-";
	const desc = typeof item.description === "string" ? item.description.trim() : "";
	if (desc) {
		const m = desc.match(/Deposit from\s+([a-zA-Z0-9_.-]+)/i);
		if (m) return m[1].trim();
		const first = desc.split(/\s+/)[0];
		if (first && first.length > 1) return first.replace(/[^a-zA-Z0-9_.-]/g, "").trim();
	}
	for (const k of ["user", "customer_name"]) {
		const v = item[k];
		if (typeof v === "string" && v.trim()) return v.trim().split(/\s+/)[0];
	}
	const cust = item.customer as Record<string, unknown> | undefined;
	if (cust && typeof cust.name === "string" && cust.name.trim()) return cust.name.trim().split(/\s+/)[0];
	return "-";
}
