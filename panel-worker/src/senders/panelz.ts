// Port loginPanelZInternal_ / getPanelRowAutoInternal_ / sendToPanelZInternal_ / sendCustomPanelZInternal_.
import type { PanelZCfg } from "../lib/site";
import { convertMarketToPanel } from "../lib/parser";

interface PanelSession {
	basicAuth: string;
	cookie: string;
}

async function loginPanelZ(cfg: PanelZCfg): Promise<PanelSession | string> {
	const basicAuth = "Basic " + btoa(`${cfg.user}:${cfg.pass}`);
	const res = await fetch(cfg.url + "/assets/sys-tmbet/authentication.php", {
		method: "POST",
		redirect: "manual",
		headers: { Authorization: basicAuth, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: cfg.user2, password: cfg.pass2 }),
	});
	const many = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	const raw = many[0] || res.headers.get("set-cookie") || "";
	if (!raw) return "Error: PHPSESSID tidak ditemukan";
	const m = raw.match(/PHPSESSID=[^;]+/);
	if (!m) return "Error: Session gagal";
	return { basicAuth, cookie: m[0] };
}

async function getPanelRow(
	session: PanelSession,
	cfg: PanelZCfg,
	market: string,
): Promise<string | null> {
	const res = await fetch(cfg.url + "/dashboard.php?hal=result", {
		headers: { Authorization: session.basicAuth, Cookie: session.cookie },
	});
	const html = await res.text();
	const key = convertMarketToPanel(market);
	if (!key) return null;
	const re = new RegExp(key + "[\\s\\S]{0,500}?update-resultlotto\\.php\\?row=(\\d+)", "i");
	const m = html.match(re);
	return m ? m[1] : null;
}

async function pushAngka(
	session: PanelSession,
	cfg: PanelZCfg,
	rowId: string,
	angka: string,
): Promise<string> {
	const res = await fetch(cfg.url + "/config/update-resultlotto.php?row=" + rowId, {
		method: "POST",
		redirect: "manual",
		headers: {
			Authorization: session.basicAuth,
			Cookie: session.cookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ updangka: angka }),
	});
	if (res.status === 200 || res.status === 302) return "Terkirim";
	return "Gagal (" + res.status + ")";
}

/** Kirim hasil result (parse Pasaran + Prize 1 dari rawText). */
export async function sendPanelZ(rawText: string, cfg: PanelZCfg): Promise<string> {
	try {
		if (!cfg.url || !cfg.user) return "Error: Konfigurasi Panel-Z kosong";
		const marketMatch = rawText.match(/Pasaran\s+(.+)/i) || rawText.match(/Hasil Pengeluaran Pasaran\s+(.+)/i);
		const prize1Match = rawText.match(/Prize\s*1[^\d]*(\d{4})/i) || rawText.match(/Prize\s*1\s*[:\-]?\s*(\d+)/i);
		if (!marketMatch) return "Pasaran tidak ditemukan";
		if (!prize1Match) return "Prize 1 tidak ditemukan dalam format teks";
		const market = marketMatch[1].trim().toUpperCase();
		const prize1 = prize1Match[1];

		const session = await loginPanelZ(cfg);
		if (typeof session === "string") return session;
		const rowId = await getPanelRow(session, cfg, market);
		if (!rowId) return "Row tidak ditemukan : " + market;
		return pushAngka(session, cfg, rowId, prize1);
	} catch (e) {
		return "Error: " + (e instanceof Error ? e.message : String(e));
	}
}

/** Kirim angka custom (dipakai fitur Send Panel-Z / TOTOMACAU manual). */
export async function sendCustomPanelZ(market: string, angka: string, cfg: PanelZCfg): Promise<string> {
	try {
		if (!cfg.url || !cfg.user) return "Error: Konfigurasi Panel-Z kosong";
		const session = await loginPanelZ(cfg);
		if (typeof session === "string") return session;
		const rowId = await getPanelRow(session, cfg, String(market).toUpperCase());
		if (!rowId) return "Row tidak ditemukan";
		const r = await pushAngka(session, cfg, rowId, angka);
		return r === "Terkirim" ? "Berhasil dikirim" : r;
	} catch (e) {
		return "Error : " + (e instanceof Error ? e.message : String(e));
	}
}
