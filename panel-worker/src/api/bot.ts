// Endpoint Role BOT — modul NEWS. Boleh diakses akun role BOT (allowBot) DAN Admin.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { getTurso } from "../lib/turso";
import { tsNow } from "../lib/time";
import { botCfgSet, botNewsRun, botNewsSnapshot, fbDirectProcessOne } from "../lib/bot-news";

async function gate(env: Env, token: string) {
	// BOT & ADMIN sama-sama boleh; OPERATOR/VIEWER ditolak.
	const s = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
	if (s.profile.role !== "BOT" && s.profile.role !== "ADMIN") {
		throw new Error("Menu BOT hanya untuk akun BOT atau ADMIN.");
	}
	return s;
}

export async function botNewsStatus(env: Env, token: string) {
	await gate(env, token);
	return botNewsSnapshot(env);
}

export async function botNewsSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const patch: Record<string, string> = {};
	const allow = [
		"enabled", "per_run", "daily_cap", "attribution", "rewrite_style", "gemini_model", "gemini_key",
		"blogger_blog_id", "para_min", "para_max", "promo_url", "promo_text", "post_labels",
		"fb_enabled", "fb_page_id", "fb_page_token", "fb_direct_enabled", "fb_direct_daily_cap",
	];
	for (const k of allow) {
		if (Object.prototype.hasOwnProperty.call(data, k)) {
			let v = String((data as any)[k] ?? "").trim();
			if (k === "enabled" || k === "attribution" || k === "fb_enabled" || k === "fb_direct_enabled") v = v === "1" || v === "true" ? "1" : "0";
			if ((k === "fb_page_token") && !v) continue; // kosongkan input token TIDAK menghapus yg tersimpan
			patch[k] = v;
		}
	}
	if (Object.keys(patch).length) await botCfgSet(env, patch);
	await logActivity(env, s.username, "BOT NEWS SETTING", "Ubah konfigurasi: " + Object.keys(patch).join(", "), "BERHASIL", "");
	return botNewsSnapshot(env);
}

export async function botNewsAddSource(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const name = String(data.name ?? "").trim();
	const url = String(data.url ?? "").trim();
	const kind = String(data.kind ?? "rss").trim().toLowerCase();
	if (!name || !/^https?:\/\//i.test(url)) throw new Error("Nama & URL feed wajib (URL harus http/https).");
	if (!["rss", "gnews", "scrape"].includes(kind)) throw new Error("Jenis sumber tidak valid.");
	await getTurso(env)
		.prepare(`INSERT INTO news_source (name, kind, url, active, added_at) VALUES (?, ?, ?, 1, ?)`)
		.bind(name, kind, url, tsNow())
		.run();
	await logActivity(env, s.username, "BOT NEWS SUMBER", "Tambah sumber: " + name, "BERHASIL", url);
	return botNewsSnapshot(env);
}

export async function botNewsToggleSource(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	const active = String(data.active ?? "") === "1" ? 1 : 0;
	if (!id) throw new Error("id sumber wajib.");
	await getTurso(env).prepare(`UPDATE news_source SET active = ? WHERE id = ?`).bind(active, id).run();
	return botNewsSnapshot(env);
}

export async function botNewsDeleteSource(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	if (!id) throw new Error("id sumber wajib.");
	await getTurso(env).prepare(`DELETE FROM news_source WHERE id = ?`).bind(id).run();
	return botNewsSnapshot(env);
}

export async function botNewsRunNow(env: Env, token: string, count?: number) {
	const s = await gate(env, token);
	// Abaikan flag enabled untuk run manual, tapi tetap hormati batas harian.
	// count dibatasi di botNewsRun (maks 5x sekali klik) -> jaga anggaran
	// subrequest Cloudflare (Gemini+Blogger+Turso per artikel).
	const r = await botNewsRun(env, { force: true, count: count ? Number(count) : 1 });
	await logActivity(
		env,
		s.username,
		"BOT NEWS RUN",
		`Manual: feed +${r.pulled}, diposting ${r.posted}${r.capped ? " (batas harian tercapai)" : ""}`,
		"BERHASIL",
		"",
	);
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

export async function botFbRunNow(env: Env, token: string) {
	const s = await gate(env, token);
	const r = await fbDirectProcessOne(env);
	await logActivity(
		env,
		s.username,
		"BOT FB LANGSUNG RUN",
		r.title ? `Terposting: ${r.title}` : r.error || "Tidak ada artikel baru.",
		r.error && !/akan dicoba lagi/i.test(r.error) ? "SEBAGIAN" : "BERHASIL",
		"",
	);
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

export async function botNewsSkip(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	if (!id) throw new Error("id artikel wajib.");
	await getTurso(env).prepare(`UPDATE news_article SET status='skipped' WHERE id = ? AND status IN ('new','error')`).bind(id).run();
	return botNewsSnapshot(env);
}

// dipakai cron
export { botNewsRun };
