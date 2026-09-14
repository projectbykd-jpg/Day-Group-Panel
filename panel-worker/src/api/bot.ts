// Endpoint Role BOT — modul NEWS. Boleh diakses akun role BOT (allowBot) DAN Admin.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { getTurso } from "../lib/turso";
import { tsNow } from "../lib/time";
import { botCfgSet, botNewsRun, botNewsSnapshot, ensureNewsCategoryColumns, fbDirectProcessOne, fbTemplateGenerate, NEWS_CATEGORIES } from "../lib/bot-news";

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
		"enabled", "per_run", "daily_cap", "site_per_run", "attribution", "rewrite_style", "gemini_model", "gemini_key", "groq_key", "groq_model",
		"blogger_blog_id", "para_min", "para_max", "promo_url", "promo_text", "post_labels",
		"fb_enabled", "fb_page_id", "fb_page_token", "fb_direct_enabled", "fb_direct_daily_cap", "fb_page_url", "blogger_site_url",
		"news_banner_enabled", "news_banner_image", "news_banner_url", "news_banner_text",
	];
	for (const k of allow) {
		if (Object.prototype.hasOwnProperty.call(data, k)) {
			let v = String((data as any)[k] ?? "").trim();
			if (k === "enabled" || k === "attribution" || k === "fb_enabled" || k === "fb_direct_enabled" || k === "news_banner_enabled") v = v === "1" || v === "true" ? "1" : "0";
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
	const category = String(data.category ?? "umum").trim().toLowerCase();
	if (!name || !/^https?:\/\//i.test(url)) throw new Error("Nama & URL feed wajib (URL harus http/https).");
	if (!["rss", "gnews", "scrape"].includes(kind)) throw new Error("Jenis sumber tidak valid.");
	if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) throw new Error("Kategori tidak valid.");
	await ensureNewsCategoryColumns(env);
	await getTurso(env)
		.prepare(`INSERT INTO news_source (name, kind, url, active, added_at, category) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(name, kind, url, tsNow(), category)
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

/** Tombol "PROSES KE BLOGGER" -- HANYA loop Blogger, tidak menyentuh situs sendiri sama sekali. */
export async function botNewsRunNow(env: Env, token: string, count?: number) {
	const s = await gate(env, token);
	// Abaikan flag enabled untuk run manual, tapi tetap hormati batas harian.
	// count dibatasi di botNewsRun (maks 5x sekali klik) -> jaga anggaran
	// subrequest Cloudflare (Gemini+Blogger+Turso per artikel).
	const r = await botNewsRun(env, { force: true, count: count ? Number(count) : 1, mode: "blogger" });
	await logActivity(
		env,
		s.username,
		"BOT NEWS RUN",
		`Manual (Blogger): feed +${r.pulled}, diposting ${r.posted}${r.capped ? " (batas harian tercapai)" : ""}`,
		"BERHASIL",
		"",
	);
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

/** Tombol "PROSES KE SITUS SENDIRI" -- HANYA loop situs sendiri, tidak pernah menyentuh/posting ke Blogger. */
export async function botNewsRunSiteNow(env: Env, token: string, count?: number) {
	const s = await gate(env, token);
	const r = await botNewsRun(env, { force: true, count: count ? Number(count) : 1, mode: "site" });
	await logActivity(env, s.username, "BOT NEWS RUN SITUS", `Manual (Situs Sendiri): feed +${r.pulled}, +${r.siteOnly} artikel`, "BERHASIL", "");
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

// Repo TEMPAT workflow news-turbo.yml hidup -- SENGAJA di-hardcode terpisah
// dari env.GH_REPO (itu punya repo scraper LAIN, daygroup-scraper, dipakai
// fitur LAP ADMIN di lap.ts, bukan repo panel ini).
const NEWS_TURBO_REPO = "projectbykd-jpg/Day-Group-Panel";

/**
 * Tombol "PROSES BANYAK VIA GITHUB" -- alternatif dari botNewsRunNow/
 * botNewsRunSiteNow di atas yang DIBATASI KETAT (maks 5 artikel/klik) karena
 * jalan sebagai 1 invocation Cloudflare sinkron (limit 50 subrequest/invocation,
 * tombol biasa gampang kena "Too many subrequests" kalau pilih banyak artikel
 * sekaligus). Di sini TIDAK memproses artikel sama sekali dari Worker --
 * cuma memicu workflow GitHub Actions "news-turbo.yml" (lihat
 * .github/workflows/news-turbo.yml) yang jalan di server GitHub sendiri,
 * TANPA limit subrequest itu sama sekali (mekanisme SAMA PERSIS dgn yang
 * sudah otomatis jalan tiap 10 menit) -- hasilnya (posting Blogger + Situs
 * Sendiri) masuk sendiri ke database dalam 1-2 menit, tidak instan spt tombol
 * lain, tapi bisa memproses SELURUH antrean 'new' dalam sekali klik.
 */
export async function botNewsRunViaGithub(env: Env, token: string) {
	const s = await gate(env, token);
	if (!env.GH_TOKEN) {
		throw new Error("GitHub Actions belum dikonfigurasi (secret GH_TOKEN). Hubungi admin.");
	}
	const resp = await fetch(`https://api.github.com/repos/${NEWS_TURBO_REPO}/actions/workflows/news-turbo.yml/dispatches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "daygroup-panel",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({ ref: "main" }),
	});
	if (resp.status !== 204) {
		const body = await resp.text();
		let hint = "";
		if (resp.status === 404) hint = " -- workflow news-turbo.yml belum ke-push ke repo Day-Group-Panel, atau GH_TOKEN tidak punya akses ke repo ini.";
		else if (resp.status === 403) hint = " -- GH_TOKEN kurang izin (butuh scope 'Actions: Read and write' utk repo Day-Group-Panel).";
		let detail = "";
		try {
			detail = " [" + (JSON.parse(body).message || "") + "]";
		} catch {
			/* body bukan JSON, abaikan */
		}
		throw new Error(`Gagal memicu GitHub Actions (HTTP ${resp.status})${hint}${detail}`);
	}
	await logActivity(env, s.username, "BOT NEWS RUN (GitHub)", "Memicu workflow news-turbo.yml secara manual", "BERHASIL", "");
	return {
		success: true,
		message: "Dipicu! Buka tab Actions di GitHub buat lihat progress -- hasilnya (posting Blogger + Situs Sendiri) otomatis masuk ke dashboard ini dalam 1-2 menit, klik REFRESH nanti.",
	};
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

export async function botFbTemplateGenerate(env: Env, token: string) {
	const s = await gate(env, token);
	const r = await fbTemplateGenerate(env);
	await logActivity(
		env,
		s.username,
		"BOT TEMPLATE FB",
		r.title ? `Template dibuat: ${r.title}` : r.error || "Tidak ada artikel baru.",
		r.done ? "BERHASIL" : "SEBAGIAN",
		"",
	);
	return { success: r.done, ...r };
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
