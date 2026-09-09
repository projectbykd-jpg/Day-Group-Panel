// Menu "Laporan Harian" â€” endpoint Worker.
// Fase A: kredensial (Setting) + Lap Motion + Lap Mozart (API JSON, jalan langsung
// di Worker). Lap Admin (scraper berat) menyusul lewat GitHub Actions.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";
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
		"accept-language": "en-US,en;q=0.9",
		"user-agent": UA,
		referer: base + "/riwayat-pga",
		origin: base,
		"sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24"',
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
	};
	const urlDepo = `${base}/api/deposit/list/pga`;
	const urlWd = `${base}/api/withdraw/list/pga`;
	const LIMIT = 100;
	const pPaid = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "0", sort: { field: "paid_at", order: "desc" } };
	const pCreate = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "1", sort: { field: "created_at", order: "desc" } };
	const pWd = { page: 0, start: 0, limit: LIMIT, count: 0, date1: startDate, date2: endDate, filter_status: "1", filter_by: "0" };

	// Panggilan pertama manual -> tangkap status untuk diagnosa.
	let firstText = "";
	let firstStatus = 0;
	try {
		const fr = await fetch(urlDepo, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(pPaid),
		});
		firstStatus = fr.status;
		firstText = await fr.text();
	} catch (e) {
		return { success: false, message: "Tidak bisa menghubungi API Motion: " + (e instanceof Error ? e.message : String(e)) };
	}
	if (firstStatus === 401 || firstStatus === 403) {
		const cf = /cloudflare|attention required|just a moment|cf-ray|challenge/i.test(firstText);
		return {
			success: false,
			message:
				firstStatus === 401
					? "Token Motion (x-access-token) kedaluwarsa / salah. Perbarui di menu Setting."
					: cf
						? "Motion 403 diblokir Cloudflare â€” API menolak request dari Worker. Modul ini perlu jalur GitHub Actions."
						: "Motion 403: " + firstText.slice(0, 160),
		};
	}
	if (firstStatus >= 400) return { success: false, message: "Motion HTTP " + firstStatus + ": " + firstText.slice(0, 160) };

	let parsedPaid: Rec | null = null;
	try {
		parsedPaid = JSON.parse(firstText) as Rec;
	} catch {
		return { success: false, message: "Respons Motion bukan JSON: " + firstText.slice(0, 160) };
	}
	const rest = await postJsonBatch([
		{ url: urlDepo, headers, body: pCreate },
		{ url: urlWd, headers, body: pWd },
	]);
	let fetched = 3;
	const parsedCreate = rest[0] as Rec | null;
	const parsedWd = rest[1] as Rec | null;
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
		`${startDate}..${endDate} â€” DP ${motionDpPga.length}, pending ${pgaPendingError.length}, WD ${motionWdPga.length}` + (truncated ? " (terpotong)" : ""),
		"BERHASIL",
		"",
	);
	return { success: true, summary, motionDpPga, pgaPendingError, motionWdPga, truncated };
}

// =========================================================================
// LAP MOZART  (via GitHub Actions — API Mozart di belakang Cloudflare menolak
// request dari Cloudflare Worker, jadi scrape dijalankan di runner GitHub)
// =========================================================================
export async function lapRunMozart(
	env: Env,
	token: string,
	startDate: string,
	endDate: string,
	_opts: { depo?: boolean; wd?: boolean; panelId?: number } = {},
) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.cookieMozart) return { success: false, message: "Cookie Mozart belum diisi di menu Setting!" };
	const r = await dispatchScrapeJob(env, s.username, "mozart", startDate, endDate);
	if (r.success && !("reused" in r)) {
		await logActivity(env, s.username, "LAP MOZART", `Tarik ${startDate}..${endDate} dipicu`, "INFO", "");
	}
	return r;
}

// =========================================================================
// LAP ADMIN â€” via GitHub Actions (scraper berat)
// =========================================================================
const GH_API = "https://api.github.com";

async function dispatchScrapeJob(env: Env, username: string, kind: "admin" | "mozart", startDate: string, endDate: string) {
	if (!env.GH_TOKEN || !env.GH_REPO) {
		return { success: false as const, message: "GitHub Actions belum dikonfigurasi (GH_TOKEN/GH_REPO). Hubungi admin." };
	}
	const running = await env.DB.prepare(
		`SELECT id FROM lap_job WHERE username = ? AND kind = ? AND status IN ('pending','running')
		 AND created_at > datetime('now','+7 hours','-30 minutes') LIMIT 1`,
	)
		.bind(username, kind)
		.first<{ id: string }>();
	if (running) return { success: true as const, jobId: running.id, message: "Proses sebelumnya masih berjalan.", reused: true };

	const jobId = crypto.randomUUID().replace(/-/g, "");
	const key = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	const params = JSON.stringify({ kind, startDate, endDate, key });
	await env.DB.prepare(
		`INSERT INTO lap_job (id, username, kind, status, params, message, created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', ?, 'Menunggu GitHub Actions...', ?, ?)`,
	)
		.bind(jobId, username, kind, params, tsNow(), tsNow())
		.run();

	const callback = env.PUBLIC_URL || "https://panel-worker.projectbykd.workers.dev";
	const resp = await fetch(`${GH_API}/repos/${env.GH_REPO}/actions/workflows/scrape.yml/dispatches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "daygroup-panel",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, callback, key, kind } }),
	});
	if (resp.status !== 204) {
		const body = await resp.text();
		let hint = "";
		if (resp.status === 404) hint = " â€” workflow scrape.yml belum ada. Push repo daygroup-scraper dulu.";
		else if (resp.status === 403) hint = " â€” token GitHub kurang izin (butuh Actions: Read and write) atau belum akses repo daygroup-scraper.";
		else if (resp.status === 422) hint = " â€” branch 'main' belum ada di repo (repo masih kosong).";
		let detail = "";
		try {
			detail = " [" + (JSON.parse(body).message || "") + "]";
		} catch {
			/* ignore */
		}
		await env.DB.prepare(`UPDATE lap_job SET status='error', message=?, updated_at=? WHERE id=?`)
			.bind("GitHub " + resp.status + detail, tsNow(), jobId)
			.run();
		return { success: false as const, message: "Gagal memicu GitHub Actions (" + resp.status + ")" + detail + hint };
	}
	return { success: true as const, jobId, message: "Dijalankan di GitHub Actions â€” ~1-3 menit." };
}

export async function lapRunAdmin(env: Env, token: string, startDate: string, endDate: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.linkAdmin || !c.cookieAdmin) return { success: false, message: "Link & Cookie Admin belum diisi di menu Setting!" };
	const r = await dispatchScrapeJob(env, s.username, "admin", startDate, endDate);
	if (r.success && !("reused" in r)) {
		await logActivity(env, s.username, "LAP ADMIN", `Scan ${startDate}..${endDate} dipicu`, "INFO", "");
	}
	return r;
}

export async function lapAdminStatus(env: Env, token: string, jobId: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const row = await env.DB.prepare(`SELECT * FROM lap_job WHERE id = ? AND username = ?`)
		.bind(jobId, s.username)
		.first<Record<string, string>>();
	if (!row) return { success: false, message: "Job tidak ditemukan." };
	const out: Record<string, unknown> = {
		success: true,
		status: row.status,
		message: row.message,
		updatedAt: row.updated_at,
	};
	if (row.status === "done") out.results = await lapLoadResults(env, s.username);
	return out;
}

/** Dipanggil oleh GitHub Actions (auth: job key, bukan sesi). */
export async function lapJobStart(env: Env, jobId: string, key: string) {
	const row = await env.DB.prepare(`SELECT username, status, params FROM lap_job WHERE id = ?`)
		.bind(jobId)
		.first<{ username: string; status: string; params: string }>();
	if (!row) return { success: false, message: "job tidak ada" };
	let p: { kind?: string; startDate?: string; endDate?: string; key?: string } = {};
	try {
		p = JSON.parse(row.params || "{}");
	} catch {
		/* ignore */
	}
	if (!p.key || p.key !== key) return { success: false, message: "key salah" };
	await env.DB.prepare(`UPDATE lap_job SET status='running', message='Scraping...', updated_at=? WHERE id=?`)
		.bind(tsNow(), jobId)
		.run();
	const c = await lapLoadCreds(env, row.username);
	const kind = p.kind || "admin";
	return {
		success: true,
		creds:
			kind === "mozart"
				? { linkMozart: c.linkMozart, cookieMozart: c.cookieMozart }
				: { linkAdmin: c.linkAdmin, cookieAdmin: c.cookieAdmin },
		params: { kind, startDate: p.startDate, endDate: p.endDate },
	};
}

/** Dipanggil oleh GitHub Actions setelah scrape selesai. */
export async function lapJobResult(
	env: Env,
	jobId: string,
	key: string,
	ok: boolean,
	data: Record<string, unknown[]>,
	errors: Record<string, string>,
) {
	const row = await env.DB.prepare(`SELECT username, params FROM lap_job WHERE id = ?`)
		.bind(jobId)
		.first<{ username: string; params: string }>();
	if (!row) return { success: false, message: "job tidak ada" };
	let p: { key?: string } = {};
	try {
		p = JSON.parse(row.params || "{}");
	} catch {
		/* ignore */
	}
	if (!p.key || p.key !== key) return { success: false, message: "key salah" };

	if (ok && data && typeof data === "object") {
		const save: Record<string, unknown[]> = {};
		for (const k of Object.keys(data)) if (Array.isArray(data[k])) save[k] = data[k];
		if (Object.keys(save).length) await lapSaveResults(env, row.username, save);
	}
	const errMsg = errors && Object.keys(errors).length ? " | error: " + Object.values(errors).join("; ") : "";
	await env.DB.prepare(`UPDATE lap_job SET status=?, message=?, updated_at=? WHERE id=?`)
		.bind(ok ? "done" : "error", (ok ? "Selesai." : "Gagal.") + errMsg, tsNow(), jobId)
		.run();
	await logActivity(
		env,
		row.username,
		"LAP ADMIN",
		"Hasil scan diterima" + errMsg,
		ok ? "BERHASIL" : "GAGAL",
		"",
	);
	return { success: true };
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
