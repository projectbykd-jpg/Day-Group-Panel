// Mesin scan INVEST — port investPumpScans_ / investScanUser_ / investAggregateUser_.
// Dijalankan oleh Cron Trigger Worker (tiap menit). Tiap tick memproses semua user
// yang state-nya 'running' dengan anggaran waktu, menyimpan progres ke invest_state
// (kolom cursor), lalu tick berikutnya melanjutkan.
import { tsNow } from "./time";
import { logActivity } from "./activity";
import {
	INVEST_GAMES,
	INVEST_MAX_PAGES_PER_GAME,
	INVEST_PAGE_SIZE,
	INVEST_PASARAN,
	INVEST_PERIODE_LOOKBACK,
	InvestConfig,
	InvestSessionExpired,
	investFetch,
	investGetState,
	investLoadConfig,
	investRunningUsers,
	investSetState,
} from "./invest";

const OFFSET_MS = 7 * 60 * 60 * 1000;
const PUMP_FLAG = "invest:pump:running";
const USER_SLICE_MS = 45_000; // maks per user per tick
const PUMP_BUDGET_MS = 55_000; // total per tick (cron scheduled boleh lebih lama, tapi tetap dijaga)
const RAW_FLUSH_AT = 300;

const ROW_RE_SRC =
	">(?:2D|3D|4D)-(\\d+)</font></td>\\s*<td[^>]*><FONT[^>]*>(\\d{4}-\\d{2}-\\d{2}) \\d{2}:\\d{2}:\\d{2}</font></td>\\s*<td[^>]*><FONT[^>]*>([^<]*)</font></td>";

function dateKeyTZ(offsetDays = 0): string {
	return new Date(Date.now() + OFFSET_MS + offsetDays * 864e5).toISOString().slice(0, 10);
}

function parsePeriode(html: string): number | null {
	const m = html.match(/name=["']?periode["']?[^>]*value=["'](\d+)["']/i);
	return m ? parseInt(m[1], 10) : null;
}
function parseTotals(html: string): Record<string, number> {
	const t: Record<string, number> = { "2D": 0, "3D": 0, "4D": 0 };
	for (const g of ["2D", "3D", "4D"]) {
		const m = html.match(new RegExp('value ="' + g + '">&nbsp;:&nbsp;(\\d+)'));
		if (m) t[g] = parseInt(m[1], 10);
	}
	return t;
}
function maxGame(t: Record<string, number>): string {
	let g = "2D";
	if (t["3D"] > t[g]) g = "3D";
	if (t["4D"] > t[g]) g = "4D";
	return g;
}
function framePath(per: number, game: string, start: number, size: number): string {
	return (
		"admin_invoice_frame.php?tombol=" + game + "&start=" + start + "&end=" + (start + size) +
		"&s_user=&s_nomor=&s_periode=" + per + "&pos2d=&dist=invoice"
	);
}
function firstDate(html: string): string | null {
	const m = new RegExp(ROW_RE_SRC, "g").exec(html);
	return m ? m[2] : null;
}
function countUsersFromPages(pages: string[]): Record<string, number> {
	const users: Record<string, number> = {};
	const seen: Record<string, number> = {};
	for (const html of pages) {
		const re = new RegExp(ROW_RE_SRC, "g");
		let mm: RegExpExecArray | null;
		while ((mm = re.exec(html)) !== null) {
			const id = mm[1];
			const user = (mm[3] || "").trim();
			if (seen[id]) continue;
			seen[id] = 1;
			users[user] = (users[user] || 0) + 1;
		}
	}
	return users;
}

interface RawRow {
	tanggal: string;
	bettor: string;
	pasaran: string;
	periode: string;
	game: string;
	line: number;
	limitVal: number;
}

async function flushRaw(env: Env, owner: string, buffer: RawRow[]): Promise<void> {
	if (!buffer.length) return;
	const rows = buffer.splice(0, buffer.length);
	const stmts = rows.map((r) =>
		env.DB.prepare(
			`INSERT INTO invest_raw (owner, tanggal, bettor, pasaran, periode, game, line, limit_val)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(owner, r.tanggal, r.bettor, r.pasaran, r.periode, r.game, r.line, r.limitVal),
	);
	for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// ---------------------------------------------------------------------------
// Scan 1 user dari cursor sampai selesai / deadline / sesi mati.
// ---------------------------------------------------------------------------
export async function investScanUser(env: Env, user: string, deadlineMs: number): Promise<void> {
	let st = await investGetState(env, user);
	if (st.state !== "running") return;

	const cfg = await investLoadConfig(env, user);
	const pas = INVEST_PASARAN;
	let cursor = Number(st.cursor || 0);

	const today = dateKeyTZ(0);
	const yesterday = dateKeyTZ(-1);
	const wanted: Record<string, boolean> = { [today]: true, [yesterday]: true };
	const limits: Record<string, number> = { "2D": cfg.LIMIT_2D, "3D": cfg.LIMIT_3D, "4D": cfg.LIMIT_4D };
	const buffer: RawRow[] = [];

	await investSetState(env, user, { state: "running", cursor, total: pas.length });

	if (cursor === 0) {
		await env.DB.prepare(`DELETE FROM invest_raw WHERE owner = ?`).bind(user).run();
	}

	for (; cursor < pas.length; cursor++) {
		if (Date.now() >= deadlineMs) {
			await flushRaw(env, user, buffer);
			await investSetState(env, user, {
				state: "running",
				cursor,
				message: `Scan berjalan — pasaran ${cursor}/${pas.length}…`,
			});
			return;
		}

		const [kode, nama] = pas[cursor];
		try {
			const head0 = await investFetch(cfg, "admin_invoice13.php?psr=" + kode);
			const open = parsePeriode(head0);
			if (open) {
				for (let i = 0; i < INVEST_PERIODE_LOOKBACK; i++) {
					const per = open - i;
					const head = i === 0 ? head0 : await investFetch(cfg, "admin_invoice13.php?psr=" + kode + "&periode=" + per + "&tombol=2D");
					const totals = parseTotals(head);
					const maxG = maxGame(totals);
					if (totals[maxG] === 0) continue;

					const page1 = await investFetch(cfg, framePath(per, maxG, 0, INVEST_PAGE_SIZE));
					const pdate = firstDate(page1);
					if (pdate) {
						if (pdate < yesterday) break;
						if (!wanted[pdate]) continue;
					}

					for (const g of INVEST_GAMES) {
						if (totals[g] <= limits[g]) continue;
						// kumpulkan halaman
						const pages: string[] = [];
						let start = 0;
						if (g === maxG) {
							pages.push(page1);
							start = INVEST_PAGE_SIZE;
						}
						let pageCount = g === maxG ? 1 : 0;
						for (; start <= totals[g]; start += INVEST_PAGE_SIZE) {
							if (++pageCount > INVEST_MAX_PAGES_PER_GAME) break;
							const html = await investFetch(cfg, framePath(per, g, start, INVEST_PAGE_SIZE));
							const before = pages.length;
							pages.push(html);
							// berhenti kalau halaman ini tak memuat baris baru
							if (countRows(html) === 0 && pages.length > before) {
								pages.pop();
								break;
							}
						}
						const counts = countUsersFromPages(pages);
						for (const uu of Object.keys(counts)) {
							if (counts[uu] > limits[g]) {
								buffer.push({
									tanggal: pdate || today,
									bettor: uu,
									pasaran: nama,
									periode: String(per),
									game: g,
									line: counts[uu],
									limitVal: limits[g],
								});
							}
						}
					}
				}
			}
		} catch (e) {
			if (e instanceof InvestSessionExpired) {
				await flushRaw(env, user, buffer);
				await investSetState(env, user, {
					state: "session_expired",
					cursor,
					message: `SESSION EXPIRED di ${nama}. Tempel PHPSESSID baru, SIMPAN, lalu klik LANJUTKAN SCAN.`,
				});
				return;
			}
			buffer.push({
				tanggal: today,
				bettor: "(ERROR)",
				pasaran: nama,
				periode: "-",
				game: "-",
				line: 0,
				limitVal: 0,
			});
			// simpan pesan error pada kolom bettor tidak muat -> pakai raw dengan pasaran+error
			buffer[buffer.length - 1].game = String((e instanceof Error ? e.message : String(e)) || "error").slice(0, 120);
		}

		if (buffer.length >= RAW_FLUSH_AT) await flushRaw(env, user, buffer);
		await investSetState(env, user, { cursor: cursor + 1 });
	}

	await flushRaw(env, user, buffer);
	const n = await investAggregateUser(env, user);
	await investSetState(env, user, {
		state: "done",
		cursor: pas.length,
		finishedAt: tsNow(),
		message: `Scan selesai — ${n} user lewat batas.`,
		warningCount: n,
	});
	try {
		await logActivity(env, user, "INVEST SCAN SELESAI", `${n} user lewat batas invest.`, "BERHASIL", "");
	} catch {
		/* abaikan */
	}
}

function countRows(html: string): number {
	const re = new RegExp(ROW_RE_SRC, "g");
	let n = 0;
	while (re.exec(html) !== null) n++;
	return n;
}

// ---------------------------------------------------------------------------
// Agregasi invest_raw -> invest_result (1 baris per bettor)
// ---------------------------------------------------------------------------
export async function investAggregateUser(env: Env, owner: string): Promise<number> {
	const res = await env.DB.prepare(
		`SELECT tanggal, bettor, pasaran, periode, game, line, limit_val FROM invest_raw WHERE owner = ?`,
	)
		.bind(owner)
		.all<Record<string, unknown>>();
	const rows = res.results ?? [];

	interface Hit {
		tanggal: string;
		pasaran: string;
		periode?: number | string;
		game?: string;
		line?: number;
		limit?: number;
		over?: number;
		error?: string;
	}
	const byUser: Record<string, { tgl: Set<string>; pas: Set<string>; hits: Hit[]; excess: number }> = {};
	for (const r of rows) {
		const tgl = String(r.tanggal ?? "");
		const bettor = String(r.bettor ?? "");
		const pasaran = String(r.pasaran ?? "");
		const per = r.periode;
		const game = String(r.game ?? "");
		const line = Number(r.line) || 0;
		const lim = Number(r.limit_val) || 0;
		if (!byUser[bettor]) byUser[bettor] = { tgl: new Set(), pas: new Set(), hits: [], excess: 0 };
		const u = byUser[bettor];
		u.tgl.add(tgl);
		if (bettor === "(ERROR)") {
			u.hits.push({ tanggal: tgl, pasaran, error: game || "error" });
			continue;
		}
		u.pas.add(pasaran);
		const over = line - lim;
		u.excess += over;
		u.hits.push({ tanggal: tgl, pasaran, periode: per as string, game, line, limit: lim, over });
	}

	const list = Object.keys(byUser)
		.map((bettor) => {
			const u = byUser[bettor];
			return {
				user: bettor,
				dates: [...u.tgl].sort(),
				markets: [...u.pas].sort(),
				excess: u.excess,
				hits: u.hits.sort((a, b) => {
					const d = a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0;
					return d !== 0 ? d : (b.over || 0) - (a.over || 0);
				}),
			};
		})
		.sort((a, b) => b.excess - a.excess);

	await env.DB.prepare(`DELETE FROM invest_result WHERE owner = ?`).bind(owner).run();
	if (list.length) {
		const now = tsNow();
		const stmts = list.map((x) =>
			env.DB.prepare(
				`INSERT INTO invest_result (owner, bettor, dates, markets, excess, hits, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(owner, x.user, x.dates.join(", "), x.markets.join(", "), x.excess, JSON.stringify(x.hits), now),
		);
		for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
	}
	return list.length;
}

// ---------------------------------------------------------------------------
// Pump — dipanggil dari Cron Trigger scheduled()
// ---------------------------------------------------------------------------
export async function investPump(env: Env): Promise<void> {
	try {
		if (await env.SESS.get(PUMP_FLAG)) return;
	} catch {
		/* lanjut */
	}
	await env.SESS.put(PUMP_FLAG, "1", { expirationTtl: 300 });
	try {
		const deadline = Date.now() + PUMP_BUDGET_MS;
		const users = await investRunningUsers(env);
		for (const user of users) {
			if (Date.now() >= deadline) break;
			const slice = Math.min(deadline, Date.now() + USER_SLICE_MS);
			try {
				await investScanUser(env, user, slice);
			} catch (e) {
				await investSetState(env, user, {
					state: "paused",
					message: "Sempat error (" + (e instanceof Error ? e.message : String(e)) + "). Klik LANJUTKAN SCAN.",
				});
			}
		}
	} finally {
		try {
			await env.SESS.delete(PUMP_FLAG);
		} catch {
			/* abaikan */
		}
	}
}
