// Port Invest.gs — Menu INVEST (AutoCheck batas line invest per operator).
// Config + state per-user di D1 (invest_config / invest_state), hasil di invest_result.
// Tahap 1: config, test session, state CRUD, baca hasil. Mesin scan menyusul.
import { tsNow } from "./time";

export const INVEST_DEFAULT_CONFIG = {
	BASE_URL: "https://ag.suksesbogil.com/",
	PHPSESSID: "",
	KODEREDIS: "",
	COOKIE_EXTRA: "",
	LIMIT_2D: 20,
	LIMIT_3D: 250,
	LIMIT_4D: 1296,
};
export type InvestConfig = typeof INVEST_DEFAULT_CONFIG;

// Konstanta scan (tidak diutak-atik dari panel).
export const INVEST_TIMEZONE = "Asia/Jakarta";
export const INVEST_PERIODE_LOOKBACK = 8;
export const INVEST_PAGE_SIZE = 50;
export const INVEST_MAX_PAGES_PER_GAME = 80;
export const INVEST_GAMES = ["2D", "3D", "4D"] as const;

// 62 pasaran togel standar (index dari agent_bt.php) + IDN4D.
export const INVEST_PASARAN: [string, string][] = [
	["p33190", "ARIZONA"], ["p12698", "ATHENS"], ["p12703", "AUSTRIA"], ["p12701", "BAHRAIN"],
	["p33210", "BALI"], ["p31202", "BERLIN"], ["p33191", "BRAZIL"], ["p6680", "BULLSEYE"],
	["p31205", "BUSAN"], ["p12700", "CAIRO"], ["p21546", "CALIFORNIA"], ["p33192", "CANADA"],
	["p6682", "CAROLINADAY"], ["p21547", "CAROLINAEVE"], ["p31211", "COLORADO"], ["p31210", "DALLAS"],
	["p21545", "FLORIDAEVE"], ["p21544", "FLORIDAMID"], ["p31209", "HK SIANG"], ["p6683", "HONGKONG"],
	["p6684", "IDAHO"], ["p6685", "INDIA"], ["p28611", "INDIA MORNING"], ["p33193", "JAKARTA"],
	["p12704", "KANSAS"], ["p6686", "KENTUCKYEVE"], ["p21540", "KENTUCKYMID"], ["p31585", "KHMER LOTTO"],
	["p31199", "LAOS MALAM"], ["p31200", "LAOS SIANG"], ["p12699", "LISBON"], ["p28616", "LISBON NIGHT"],
	["p31206", "MALAYSIA"], ["p33211", "MANILA"], ["p12706", "MEXICO"], ["p31213", "MICHIGAN"],
	["p31214", "MONTANA"], ["p6687", "NEBRASKA"], ["p28614", "NEW MEXICO"], ["p21543", "NEWYORKEVE"],
	["p21542", "NEWYORKMID"], ["p31594", "NIPPON LOTTO"], ["p31212", "OHIO"], ["p21538", "OREGON03"],
	["p21535", "OREGON06"], ["p21537", "OREGON09"], ["p21539", "OREGON12"], ["p31203", "OSAKA"],
	["p6688", "PANAMA"], ["p31204", "PARIS"], ["p12705", "PARMA"], ["p31201", "ROMA"],
	["p31198", "RUSIA"], ["p12697", "SAPPORO"], ["p28613", "SAPPORO EVE"], ["p6689", "SINGAPORE"],
	["p6690", "SYDNEY"], ["p31588", "TAIPEI LOTTO"], ["p31207", "THAILAND"], ["p31587", "TIONGKOK 4D"],
	["p12702", "TURKEY"], ["p31208", "UEA SORE"],
	["p808", "IDN4D"],
];

const INVEST_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CONFIG (per-user) — invest_config
// ---------------------------------------------------------------------------
export async function investLoadConfig(env: Env, user: string): Promise<InvestConfig> {
	const row = await env.DB.prepare(`SELECT * FROM invest_config WHERE username = ?`)
		.bind(user)
		.first<Record<string, unknown>>();
	const cfg: InvestConfig = { ...INVEST_DEFAULT_CONFIG };
	if (row) {
		cfg.BASE_URL = String(row.base_url || INVEST_DEFAULT_CONFIG.BASE_URL);
		cfg.PHPSESSID = String(row.phpsessid || "");
		cfg.KODEREDIS = String(row.koderedis || "");
		cfg.COOKIE_EXTRA = String(row.cookie_extra || "");
		cfg.LIMIT_2D = Number(row.limit_2d ?? INVEST_DEFAULT_CONFIG.LIMIT_2D);
		cfg.LIMIT_3D = Number(row.limit_3d ?? INVEST_DEFAULT_CONFIG.LIMIT_3D);
		cfg.LIMIT_4D = Number(row.limit_4d ?? INVEST_DEFAULT_CONFIG.LIMIT_4D);
	}
	if (cfg.BASE_URL && !cfg.BASE_URL.endsWith("/")) cfg.BASE_URL += "/";
	return cfg;
}

export async function investSaveConfig(env: Env, user: string, data: Record<string, unknown>): Promise<InvestConfig> {
	const cur = await investLoadConfig(env, user);
	const pick = (k: keyof InvestConfig): string =>
		Object.prototype.hasOwnProperty.call(data, k) ? String(data[k] ?? "").trim() : String(cur[k]);
	const num = (k: keyof InvestConfig): number => {
		const raw = pick(k);
		const n = Number(raw);
		return raw === "" || isNaN(n) ? (INVEST_DEFAULT_CONFIG[k] as number) : n;
	};
	let baseUrl = pick("BASE_URL") || INVEST_DEFAULT_CONFIG.BASE_URL;
	if (!baseUrl.endsWith("/")) baseUrl += "/";

	await env.DB.prepare(
		`INSERT INTO invest_config
		   (username, base_url, phpsessid, koderedis, cookie_extra, limit_2d, limit_3d, limit_4d, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   base_url = excluded.base_url, phpsessid = excluded.phpsessid, koderedis = excluded.koderedis,
		   cookie_extra = excluded.cookie_extra, limit_2d = excluded.limit_2d, limit_3d = excluded.limit_3d,
		   limit_4d = excluded.limit_4d, updated_at = excluded.updated_at`,
	)
		.bind(
			user,
			baseUrl,
			pick("PHPSESSID"),
			pick("KODEREDIS"),
			pick("COOKIE_EXTRA"),
			num("LIMIT_2D"),
			num("LIMIT_3D"),
			num("LIMIT_4D"),
			tsNow(),
		)
		.run();
	return investLoadConfig(env, user);
}

// ---------------------------------------------------------------------------
// STATE (per-user) — invest_state
// ---------------------------------------------------------------------------
export interface InvestState {
	state: string; // idle | running | paused | session_expired | done | error
	cursor: number;
	total: number;
	startedAt: string;
	finishedAt: string;
	message: string;
	updatedAt: string;
	warningCount?: number;
}
export async function investGetState(env: Env, user: string): Promise<InvestState> {
	const row = await env.DB.prepare(`SELECT * FROM invest_state WHERE username = ?`)
		.bind(user)
		.first<Record<string, unknown>>();
	return {
		state: String(row?.state ?? "idle"),
		cursor: Number(row?.cursor ?? 0),
		total: Number(row?.total ?? 0),
		startedAt: String(row?.started_at ?? ""),
		finishedAt: String(row?.finished_at ?? ""),
		message: String(row?.message ?? ""),
		updatedAt: String(row?.updated_at ?? ""),
	};
}
export async function investSetState(env: Env, user: string, patch: Partial<InvestState>): Promise<InvestState> {
	const cur = await investGetState(env, user);
	const next: InvestState = { ...cur, ...patch, updatedAt: tsNow() };
	await env.DB.prepare(
		`INSERT INTO invest_state (username, state, cursor, total, started_at, finished_at, message, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   state = excluded.state, cursor = excluded.cursor, total = excluded.total,
		   started_at = excluded.started_at, finished_at = excluded.finished_at,
		   message = excluded.message, updated_at = excluded.updated_at`,
	)
		.bind(user, next.state, next.cursor, next.total, next.startedAt || null, next.finishedAt || null, next.message, next.updatedAt)
		.run();
	return next;
}
export async function investRunningUsers(env: Env): Promise<string[]> {
	const res = await env.DB.prepare(`SELECT username FROM invest_state WHERE state = 'running'`).all<{ username: string }>();
	return (res.results ?? []).map((r) => r.username);
}

// ---------------------------------------------------------------------------
// HASIL — invest_result
// ---------------------------------------------------------------------------
export async function investWarningCount(env: Env, user: string): Promise<number> {
	const r = await env.DB.prepare(`SELECT COUNT(*) n FROM invest_result WHERE owner = ?`).bind(user).first<{ n: number }>();
	return Number(r?.n ?? 0);
}

export async function investGetWarningsList(env: Env, user: string) {
	const res = await env.DB.prepare(
		`SELECT bettor, dates, markets, excess, hits FROM invest_result WHERE owner = ? ORDER BY excess DESC`,
	)
		.bind(user)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map((r) => {
		let hits: unknown[] = [];
		try {
			hits = JSON.parse(String(r.hits ?? "[]"));
		} catch {
			hits = [];
		}
		return {
			user: String(r.bettor ?? ""),
			dates: String(r.dates ?? "").split(", ").filter(Boolean),
			markets: String(r.markets ?? "").split(", ").filter(Boolean),
			excess: Number(r.excess ?? 0),
			hits,
		};
	});
}

// ---------------------------------------------------------------------------
// HTTP ke panel agen
// ---------------------------------------------------------------------------
export function investCookieHeader(cfg: InvestConfig): string {
	if (cfg.COOKIE_EXTRA) return cfg.COOKIE_EXTRA;
	let c = "PHPSESSID=" + cfg.PHPSESSID;
	if (cfg.KODEREDIS) c += "; koderedis=" + cfg.KODEREDIS;
	return c;
}

export function investIsLoginPage(location: string, body: string): boolean {
	const loc = String(location || "");
	if (/(?:^|\/)(?:login|index|logout)\.php/i.test(loc) || /[?&]expired/i.test(loc)) return true;
	if (
		/name=["']entered_login["']/i.test(body) ||
		/name=["']vb_login_md5password["']/i.test(body) ||
		/class="submit-button"\s+value="LOGIN"/i.test(body) ||
		/<form[^>]+action=["'][^"']*login/i.test(body)
	) {
		return true;
	}
	return false;
}

export class InvestSessionExpired extends Error {
	constructor() {
		super("SESSION_EXPIRED");
		this.name = "InvestSessionExpired";
	}
}

export async function investFetch(cfg: InvestConfig, path: string): Promise<string> {
	if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) {
		throw new Error("PHPSESSID kosong — isi & simpan dulu di menu INVEST.");
	}
	const res = await fetch(cfg.BASE_URL + path, {
		method: "GET",
		headers: { Cookie: investCookieHeader(cfg), "User-Agent": INVEST_UA },
		redirect: "manual",
	});
	const body = await res.text();
	if (investIsLoginPage(res.headers.get("location") || "", body)) throw new InvestSessionExpired();
	return body;
}

/** GET paralel (chunk 30) — meniru investBatchGet_. */
export async function investBatchGet(
	cfg: InvestConfig,
	paths: string[],
): Promise<{ body: string; expired: boolean; error: string }[]> {
	const out: { body: string; expired: boolean; error: string }[] = [];
	const CHUNK = 30;
	for (let i = 0; i < paths.length; i += CHUNK) {
		const chunk = paths.slice(i, i + CHUNK);
		const settled = await Promise.allSettled(
			chunk.map((p) =>
				fetch(cfg.BASE_URL + p, {
					method: "GET",
					headers: { Cookie: investCookieHeader(cfg), "User-Agent": INVEST_UA },
					redirect: "manual",
				}),
			),
		);
		for (const s of settled) {
			if (s.status !== "fulfilled") {
				out.push({ body: "", expired: false, error: "fetch gagal" });
				continue;
			}
			try {
				const b = await s.value.text();
				out.push({ body: b, expired: investIsLoginPage(s.value.headers.get("location") || "", b), error: "" });
			} catch (e) {
				out.push({ body: "", expired: false, error: e instanceof Error ? e.message : String(e) });
			}
		}
	}
	return out;
}

/** config lengkap dengan key UPPERCASE untuk frontend lama. */
export function investConfigForClient(cfg: InvestConfig) {
	return {
		BASE_URL: cfg.BASE_URL,
		PHPSESSID: cfg.PHPSESSID,
		KODEREDIS: cfg.KODEREDIS,
		COOKIE_EXTRA: cfg.COOKIE_EXTRA,
		LIMIT_2D: cfg.LIMIT_2D,
		LIMIT_3D: cfg.LIMIT_3D,
		LIMIT_4D: cfg.LIMIT_4D,
	};
}
