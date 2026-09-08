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

export async function getSiteAccount(env: Env, website: string): Promise<SiteAccount | null> {
	const w = String(website ?? "").trim().toUpperCase();
	if (!w) return null;
	const r = await env.DB.prepare(`SELECT * FROM site_accounts WHERE website = ?`)
		.bind(w)
		.first<Record<string, string>>();
	if (!r) return null;
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
