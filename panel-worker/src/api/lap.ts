// Menu "Laporan Harian" — endpoint Worker.
// Fase A: kredensial (Setting) + Lap Motion + Lap Mozart (API JSON, jalan langsung
// di Worker). Lap Admin (scraper berat) menyusul lewat GitHub Actions.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import {
	LapCreds,
	extractPureUsername,
	lapLoadCreds,
	lapLoadResults,
	lapSaveCreds,
	lapSaveResults,
	normLink,
	num,
	postJsonBatch,
	UA,
} from "../lib/lap";

// Batas aman subrequest per invocation (Cloudflare Free = 50).
const MOTION_FETCH_BUDGET = 44;
const MOZART_PAGE_CAP = 18; // per list (depo/wd)

function credsForClient(c: LapCreds) {
	return {
		linkAdmin: c.linkAdmin,
		cookiesAdmin: c.cookieAdmin,
		linkMotion: c.linkMotion,
		tokenMotion: c.tokenMotion,
		linkMozart: c.linkMozart,
		tokenMozart: c.cookieMozart,
	};
}

export async function lapGetConfig(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	return {
		success: true,
		config: credsForClient(await lapLoadCreds(env, s.username)),
		results: await lapLoadResults(env, s.username),
	};
}

export async function lapSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapSaveCreds(env, s.username, {
		linkAdmin: str(data.linkAdmin),
		cookieAdmin: str(data.cookiesAdmin ?? data.cookieAdmin),
		linkMotion: str(data.linkMotion),
		tokenMotion: str(data.tokenMotion),
		linkMozart: str(data.linkMozart),
		cookieMozart: str(data.tokenMozart ?? data.cookieMozart),
	});
	await logActivity(env, s.username, "LAP SIMPAN SETTING", "Kredensial Laporan Harian diperbarui", "BERHASIL", "");
	return { success: true, message: "Konfigurasi Laporan Harian tersimpan.", config: credsForClient(c) };
}
const str = (v: unknown) => (v === undefined ? undefined : String(v ?? "").trim());

// =========================================================================
// LAP MOTION  (port scrapeStepMotionPGA)
// =========================================================================
export async function lapRunMotion(env: Env, token: string, startDate: string, endDate: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.tokenMotion) return { success: false, message: "Token Motion belum diisi di menu Setting!" };

	const base = normLink(c.linkMotion, "https://motionv2.com");
	const tokenClean = c.tokenMotion.replace(/^Bearer\s+/i, "").trim();
	const headers: Record<string, string> = {
		"x-access-token": tokenClean,
		accept: "application/json, text/plain, */*",
		"user-agent": UA,
		referer: base + "/riwayat-pga",
		origin: base,
	};
	const urlDepo = `${base}/api/deposit/list/pga`;
	const urlWd = `${base}/api/withdraw/list/pga`;
	const LIMIT = 100;
	const pPaid = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "0", sort: { field: "paid_at", order: "desc" } };
	const pCreate = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "1", sort: { field: "created_at", order: "desc" } };
	const pWd = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "0" };

	const first = await postJsonBatch([
		{ url: urlDepo, headers, body: pPaid },
		{ url: urlDepo, headers, body: pCreate },
		{ url: urlWd, headers, body: pWd },
	]);
	let fetched = 3;
	const parsedPaid = first[0] as Rec | null;
	const parsedCreate = first[1] as Rec | null;
	const parsedWd = first[2] as Rec | null;
	if (!parsedPaid) return { success: false, message: "Token Motion kedaluwarsa / API tidak merespons. Perbarui x-access-token." };
	if (parsedPaid.success === false || parsedPaid.error) {
		return { success: false, message: "API Motion menolak: " + (parsedPaid.msg || parsedPaid.message || parsedPaid.error || "unknown") };
	}

	let listPaid = arr(parsedPaid.data);
	let listCreate = arr(parsedCreate?.data);
	let listWd = wdArr(parsedWd?.data);

	const totPaid = optTotal(parsedPaid, listPaid.length);
	const totCreate = optTotal(parsedCreate, listCreate.length);
	const totWd = wdTotal(parsedWd, listWd.length);
	let truncated = false;

	const extra: { t: "paid" | "create" | "wd"; body: Rec }[] = [];
	const addPages = (t: "paid" | "create" | "wd", total: number, base: Rec) => {
		const pages = Math.ceil(total / LIMIT);
		for (let p = 1; p < pages; p++) {
			if (fetched + extra.length >= MOTION_FETCH_BUDGET) {
				truncated = true;
				return;
			}
			extra.push({ t, body: { ...base, page: p, start: p * LIMIT } });
		}
	};
	addPages("paid", totPaid, pPaid);
	addPages("create", totCreate, pCreate);
	addPages("wd", totWd, pWd);

	if (extra.length) {
		const res = await postJsonBatch(
			extra.map((e) => ({ url: e.t === "wd" ? urlWd : urlDepo, headers, body: e.body })),
		);
		fetched += extra.length;
		res.forEach((pp, i) => {
			const j = pp as Rec | null;
			if (!j) return;
			if (extra[i].t === "paid") listPaid = listPaid.concat(arr(j.data));
			else if (extra[i].t === "create") listCreate = listCreate.concat(arr(j.data));
			else listWd = listWd.concat(wdArr(j.data));
		});
	}

	// ---- proses (port persis logika Apps Script) ----
	const motionDpPga: Rec[] = [];
	const pgaPendingError: Rec[] = [];
	const motionWdPga: Rec[] = [];

	const createMap = new Map<string, Rec>();
	for (const it of listCreate) {
		const k = String(it.reference_no || it.invoice_no || "");
		if (k) createMap.set(k, it);
	}
	const paidKeys = new Set<string>();

	let totalNominalPaidAt = 0;
	let totalTransaksiPaid = 0;
	const optP = parsedPaid.data_optional as Rec | undefined;
	if (optP && optP.total_records !== undefined) {
		totalTransaksiPaid = num(optP.total_records);
		totalNominalPaidAt = num(optP.total_amount || optP.total_sum || 0);
	}

	for (const item of listPaid) {
		const key = String(item.reference_no || item.invoice_no || "");
		if (key) paidKeys.add(key);
		const createdAt = String(item.created_at || "");
		const paidAt = String(item.paid_at || "");
		const amount = num(item.amount || item.net_amount || 0);
		const fee = num(item.fee_total_with_service_fee || item.surcharge || 0);
		const statusDesc = String(item.paid_status_description || item.paid_status_desc || "SUCCESS").toUpperCase();
		const isSuccess = item.paid_status === 1 || statusDesc === "SUCCESS" || statusDesc === "PAID";
		const user = extractPureUsername(item);
		const paidDay = paidAt.split(" ")[0] || "";
		const createdDay = createdAt.split(" ")[0] || "";
		const inRange = paidDay >= startDate && paidDay <= endDate;
		const row: Rec = {
			createdAt,
			paidAt: paidAt || "-",
			refNo: item.reference_no || item.invoice_no || "-",
			game: item.game_name || "-",
			user,
			vendor: item.pga || "-",
			amount,
			fee,
			status: statusDesc,
		};
		if (isSuccess && inRange) {
			motionDpPga.push(row);
			if (!optP) {
				totalNominalPaidAt += amount;
				totalTransaksiPaid++;
			}
			if (!createMap.has(key) || createdDay < startDate || createdDay > endDate) {
				pgaPendingError.push({ ...row, status: createdDay !== paidDay ? `BEDA TGL (CREATE: ${createdDay})` : "TIDAK ADA DI CREATE" });
			}
		} else {
			pgaPendingError.push({ ...row, status: !inRange ? `BEDA TANGGAL PAID (${paidDay})` : statusDesc });
		}
	}

	let totalTransaksiCreate = 0;
	let totalNominalCreatedAt = 0;
	const optC = parsedCreate?.data_optional as Rec | undefined;
	if (optC && optC.total_records !== undefined) {
		totalTransaksiCreate = num(optC.total_records);
		totalNominalCreatedAt = num(optC.total_amount || optC.total_sum || 0);
	}
	for (const item of listCreate) {
		const key = String(item.reference_no || item.invoice_no || "");
		if (!optC) {
			totalNominalCreatedAt += num(item.amount || item.net_amount || 0);
			totalTransaksiCreate++;
		}
		if (!paidKeys.has(key)) {
			pgaPendingError.push({
				createdAt: item.created_at || "",
				paidAt: item.paid_at || "-",
				refNo: item.reference_no || item.invoice_no || "-",
				game: item.game_name || "-",
				user: extractPureUsername(item),
				vendor: item.pga || "-",
				amount: num(item.amount || item.net_amount || 0),
				fee: num(item.fee_total_with_service_fee || item.surcharge || 0),
				status: "TIDAK ADA DI PAID",
			});
		}
	}

	let totalWdRecords = 0;
	let totalWdAmount = 0;
	const wdOpt = (parsedWd?.data as Rec | undefined) || undefined;
	if (wdOpt && wdOpt.total_records !== undefined) {
		totalWdRecords = num(wdOpt.total_records);
		totalWdAmount = num(wdOpt.total_sum || 0);
	}
	for (const item of listWd) {
		const cust = item.customer as Rec | undefined;
		motionWdPga.push({
			createdAt: item.created_at || "",
			payoutAt: item.payout_at || item.paid_at || "-",
			refNo: item.reference_no || item.unique_id || "-",
			game: item.game_name || "-",
			user: extractPureUsername(item),
			bank: cust?.bank_name || "-",
			accountNumber: cust?.bank_account_number || "-",
			vendor: item.pga || "-",
			amount: num(item.amount || 0),
			fee: num(item.fee_total_with_service_fee || item.fee || 0),
			status: String(item.payout_status_description || item.payout_description || "SUCCESS").toUpperCase(),
			adminName: item.admin_name || "-",
		});
	}

	const summary = {
		totalTransaksiPaid,
		totalNominalPaidAt,
		totalTransaksiCreate,
		totalNominalCreatedAt,
		totalPendingErrorCount: pgaPendingError.length,
		totalWdRecords: totalWdRecords || motionWdPga.length,
		totalWdAmount,
	};
	await lapSaveResults(env, s.username, {
		motionDpPga,
		motionPendingError: pgaPendingError,
		motionWd: motionWdPga,
		_motionMeta: [{ summary, truncated, at: startDate + "|" + endDate }],
	});
	await logActivity(
		env,
		s.username,
		"LAP MOTION",
		`${startDate}..${endDate} — DP ${motionDpPga.length}, pending ${pgaPendingError.length}, WD ${motionWdPga.length}` + (truncated ? " (terpotong)" : ""),
		"BERHASIL",
		"",
	);
	return { success: true, summary, motionDpPga, pgaPendingError, motionWdPga, truncated };
}

// =========================================================================
// LAP MOZART  (port scrapeStepMozart)
// =========================================================================
export async function lapRunMozart(
	env: Env,
	token: string,
	startDate: string,
	endDate: string,
	opts: { depo?: boolean; wd?: boolean; panelId?: number } = {},
) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.cookieMozart) return { success: false, message: "Cookie Mozart belum diisi di menu Setting!" };

	const base = normLink(c.linkMozart, "https://test.com");
	const cookie = c.cookieMozart.trim();
	const panelId = opts.panelId === undefined || Number.isNaN(opts.panelId) ? 0 : Number(opts.panelId);
	const doDepo = opts.depo !== false;
	const doWd = opts.wd !== false;
	const PAGE = 100;

	const mkHeaders = (ref: string): Record<string, string> => ({
		accept: "application/json, text/plain, */*",
		cookie,
		origin: base,
		referer: base + ref,
		"user-agent": UA,
	});
	const fetchAll = async (path: string, ref: string, baseBody: Rec) => {
		const rows: Rec[] = [];
		for (let page = 0; page < MOZART_PAGE_CAP; page++) {
			let j: Rec | null = null;
			try {
				const r = await fetch(base + path, {
					method: "POST",
					headers: { "content-type": "application/json", ...mkHeaders(ref) },
					body: JSON.stringify({ ...baseBody, page_number: page, page_size: PAGE }),
				});
				if (r.status === 401) throw new Error("MOZART 401: session/token ditolak / kedaluwarsa.");
				if (r.status === 403) throw new Error("MOZART 403: ditolak server (mungkin Cloudflare).");
				j = JSON.parse(await r.text());
			} catch (e) {
				if (page === 0) throw e;
				break;
			}
			const found = mozartFindRows(j);
			rows.push(...found);
			if (found.length < PAGE) return { rows, truncated: false };
		}
		return { rows, truncated: true };
	};

	let depositData: Rec[] = [];
	let withdrawData: Rec[] = [];
	let truncated = false;
	try {
		if (doDepo) {
			const d = await fetchAll("/api/transactions/fetchTransaction", "/transactions", {
				panel_id: panelId,
				start_date: startDate,
				end_date: endDate,
				not_done_filter: false,
				filter_by: null,
			});
			truncated = truncated || d.truncated;
			depositData = d.rows.map((r) => ({
				date: String(pick(r, ["created_at", "date", "transaction_date", "trx_date", "waktu", "time"], "-")),
				username: String(pick(r, ["username", "user", "player", "user_id", "nama_user"], "-")),
				name: String(pick(r, ["name", "sender_name", "recipient", "nama", "account_name"], "-")),
				amount: num(pick(r, ["amount", "nominal", "jumlah"], 0)),
				bank: String(pick(r, ["bank", "bank_name", "bank_code", "app"], "-")),
				accountNumber: String(pick(r, ["account_number", "rekening", "bank_account", "no_rek"], "-")),
				status: String(pick(r, ["status", "status_description", "state", "transaction_status"], "SUCCESS")),
				panel: String(pick(r, ["panel", "panel_name", "panelName"], "-")),
			}));
		}
		if (doWd) {
			const w = await fetchAll("/api/wd/fetchWithdrawal", "/wd", {
				panel_id: panelId,
				start_date: startDate,
				end_date: endDate,
				filter_by: { minimum_amount: 0 },
			});
			truncated = truncated || w.truncated;
			withdrawData = w.rows.map((r) => ({
				date: String(pick(r, ["created_at", "date", "transaction_date", "trx_date", "waktu", "time"], "-")),
				username: String(pick(r, ["username", "user", "player", "user_id"], "-")),
				name: String(pick(r, ["name", "recipient", "recipient_name", "nama", "account_name"], "-")),
				panel: String(pick(r, ["panel", "panel_name", "panelName"], "-")),
				amount: num(pick(r, ["amount", "nominal", "jumlah"], 0)),
				bank: String(pick(r, ["destination", "bank", "bank_name", "bank_code", "app", "to_bank"], "-")),
				accountNumber: String(pick(r, ["account_number", "rekening", "bank_account", "no_rek"], "-")),
				status: String(pick(r, ["status", "status_description", "state", "transaction_status"], "-")),
			}));
		}
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}

	const sum = (a: Rec[]) => a.reduce((n, x) => n + (num(x.amount) || 0), 0);
	const summary = {
		totalDepoRecords: depositData.length,
		totalDepoAmount: sum(depositData),
		totalWdRecords: withdrawData.length,
		totalWdAmount: sum(withdrawData),
		netAmount: sum(depositData) - sum(withdrawData),
	};
	await lapSaveResults(env, s.username, {
		mozartDepo: depositData,
		mozartWd: withdrawData,
		_mozartMeta: [{ summary, truncated, at: startDate + "|" + endDate }],
	});
	await logActivity(
		env,
		s.username,
		"LAP MOZART",
		`${startDate}..${endDate} — DP ${depositData.length}, WD ${withdrawData.length}` + (truncated ? " (terpotong)" : ""),
		"BERHASIL",
		"",
	);
	return { success: true, startDate, endDate, depositData, withdrawData, summary, truncated };
}

// -------------------------------------------------------------------------
type Rec = Record<string, unknown> & {
	success?: unknown;
	error?: unknown;
	msg?: unknown;
	message?: unknown;
	data?: unknown;
	data_optional?: unknown;
	total_records?: unknown;
	total_sum?: unknown;
	total_amount?: unknown;
};
function arr(v: unknown): Rec[] {
	return Array.isArray(v) ? (v as Rec[]) : [];
}
function wdArr(v: unknown): Rec[] {
	if (Array.isArray(v)) return v as Rec[];
	const d = (v as Rec | undefined)?.data;
	return Array.isArray(d) ? (d as Rec[]) : [];
}
function optTotal(p: Rec | null, fallback: number): number {
	const o = p?.data_optional as Rec | undefined;
	return o && o.total_records !== undefined ? num(o.total_records) : fallback;
}
function wdTotal(p: Rec | null, fallback: number): number {
	const d = p?.data as Rec | undefined;
	return d && d.total_records !== undefined ? num(d.total_records) : fallback;
}
function mozartFindRows(json: unknown): Rec[] {
	if (Array.isArray(json)) return json as Rec[];
	let best: Rec[] = [];
	for (const k of Object.keys((json as Rec) || {})) {
		const v = (json as Rec)[k];
		if (Array.isArray(v) && v.length >= best.length && (v.length === 0 || typeof v[0] === "object")) {
			best = v as Rec[];
		} else if (v && typeof v === "object" && !Array.isArray(v)) {
			const nested = mozartFindRows(v);
			if (nested.length > best.length) best = nested;
		}
	}
	return best;
}
function pick(obj: Rec, keys: string[], fallback: unknown): unknown {
	for (const k of keys) {
		const v = obj[k];
		if (v !== undefined && v !== null && String(v).trim() !== "") return v;
	}
	return fallback;
}
