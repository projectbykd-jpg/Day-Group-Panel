// Akses tabel site_accounts (port readSosmedAccountsFast_ / getAkunByWebsiteInternal_).

export interface TelegramCfg {
	token: string;
	chatId: string;
}
export interface LinktreeCfg {
	email: string;
	pass: string;
}
export interface PanelZCfg {
	user: string;
	pass: string;
	user2: string;
	pass2: string;
	url: string;
}
export interface SiteAccount {
	website: string;
	telegram: TelegramCfg;
	telegramPred: TelegramCfg;
	linktree: LinktreeCfg;
	panelz: PanelZCfg;
}

function rowToSiteAccount(w: string, r: Record<string, string>): SiteAccount {
	return {
		website: w,
		telegram: { token: r.tg_token ?? "", chatId: r.tg_chat_id ?? "" },
		telegramPred: { token: r.tg_pred_token ?? "", chatId: r.tg_pred_chat_id ?? "" },
		linktree: { email: r.lt_email ?? "", pass: r.lt_pass ?? "" },
		panelz: {
			user: r.pz_user ?? "",
			pass: r.pz_pass ?? "",
			user2: r.pz_user2 ?? "",
			pass2: r.pz_pass2 ?? "",
			url: (r.pz_url ?? "").replace(/\/+$/, ""),
		},
	};
}

export async function getSiteAccount(env: Env, website: string): Promise<SiteAccount | null> {
	const w = String(website ?? "").trim().toUpperCase();
	if (!w) return null;
	const r = await env.DB.prepare(`SELECT * FROM site_accounts WHERE website = ?`)
		.bind(w)
		.first<Record<string, string>>();
	return r ? rowToSiteAccount(w, r) : null;
}

/**
 * Versi BANYAK-SEKALIGUS dari getSiteAccount — satu query `IN (...)` untuk
 * semua website, bukan 1 query per website. Dipakai autoPostWebsites yang
 * jalan TIAP MENIT lewat cron, jadi hemat query-nya terasa sepanjang hari.
 * Hasil di-key pakai nama website huruf besar (sama seperti kolomnya).
 */
export async function getSiteAccounts(env: Env, websites: string[]): Promise<Map<string, SiteAccount>> {
	const out = new Map<string, SiteAccount>();
	const names = [...new Set(websites.map((w) => String(w ?? "").trim().toUpperCase()).filter(Boolean))];
	if (!names.length) return out;
	for (let i = 0; i < names.length; i += 50) {
		const chunk = names.slice(i, i + 50);
		const res = await env.DB.prepare(
			`SELECT * FROM site_accounts WHERE website IN (${chunk.map(() => "?").join(",")})`,
		)
			.bind(...chunk)
			.all<Record<string, string>>();
		for (const r of res.results ?? []) {
			const w = String(r.website ?? "").trim().toUpperCase();
			if (w) out.set(w, rowToSiteAccount(w, r));
		}
	}
	return out;
}
