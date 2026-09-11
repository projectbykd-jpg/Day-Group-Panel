// Modul NEWS untuk Role BOT: tarik feed berita -> rewrite via Gemini ->
// posting ke Blogger. Semua state di Turso (bot_kv / news_source / news_article).
import { getTurso } from "./turso";
import { tsNow } from "./time";

// ---------------------------------------------------------------------------
// Konfigurasi (key-value)
// ---------------------------------------------------------------------------
export async function botCfg(env: Env): Promise<Record<string, string>> {
	const r = await getTurso(env).prepare(`SELECT k, v FROM bot_kv`).all<{ k: string; v: string }>();
	const o: Record<string, string> = {};
	for (const row of r.results ?? []) o[String(row.k)] = String(row.v ?? "");
	return o;
}

export async function botCfgSet(env: Env, patch: Record<string, string>): Promise<void> {
	const now = tsNow();
	const stmts = Object.entries(patch).map(([k, v]) =>
		getTurso(env)
			.prepare(
				`INSERT INTO bot_kv (k, v, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
			)
			.bind(k, String(v ?? ""), now),
	);
	if (stmts.length) await getTurso(env).batch(stmts);
}

const escHtml = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escHtml(s).replace(/"/g, "&quot;");

async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayKey(): string {
	return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------
interface FeedItem {
	title: string;
	url: string;
	excerpt: string;
	image: string;
}

function decodeEntities(s: string): string {
	return String(s || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
	return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseRss(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
	for (const b of blocks) {
		const pick = (tag: string) => {
			const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
			return m ? decodeEntities(m[1]).trim() : "";
		};
		const title = stripTags(pick("title"));
		let url = pick("link");
		// beberapa feed pakai <link/> kosong + <guid> berisi url, atau link di atribut
		if (!url) url = pick("guid");
		const descRaw = pick("description") || pick("content:encoded");
		const excerpt = stripTags(descRaw).slice(0, 600);
		let image = "";
		const enc = b.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
		if (enc) image = decodeEntities(enc[1]);
		if (!image) {
			const media = b.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
			if (media) image = decodeEntities(media[1]);
		}
		if (!image) {
			const img = descRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
			if (img) image = decodeEntities(img[1]);
		}
		if (title && url) items.push({ title, url: url.trim(), excerpt, image });
	}
	return items;
}

/** Google News RSS link -> URL artikel asli (ikuti redirect). */
async function resolveGnews(link: string): Promise<string> {
	try {
		const r = await fetch(link, { headers: { "User-Agent": UA }, redirect: "follow" });
		const finalUrl = r.url || link;
		if (finalUrl && !/news\.google\.com/i.test(finalUrl)) return finalUrl;
		// Kadang Google News balas HTML dgn <a href> ke artikel.
		const html = await r.text();
		const m = html.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google)[^"']+)["']/i);
		return m ? m[1] : link;
	} catch {
		return link;
	}
}

async function fetchFeed(kind: string, url: string): Promise<FeedItem[]> {
	const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" } });
	if (!r.ok) throw new Error(`feed ${url} -> HTTP ${r.status}`);
	const xml = await r.text();
	return parseRss(xml);
}

// ---------------------------------------------------------------------------
// Tarik feed -> simpan artikel baru (status "new")
// ---------------------------------------------------------------------------
export async function newsPullSources(env: Env, perSource = 12): Promise<{ added: number; scanned: number }> {
	const srcs =
		(await getTurso(env).prepare(`SELECT id, name, kind, url FROM news_source WHERE active = 1`).all<{ id: number; name: string; kind: string; url: string }>())
			.results ?? [];
	let added = 0;
	let scanned = 0;
	for (const s of srcs) {
		try {
			const items = (await fetchFeed(s.kind, s.url)).slice(0, perSource);
			for (const it of items) {
				scanned++;
				const realUrl = s.kind === "gnews" ? await resolveGnews(it.url) : it.url;
				if (!/^https?:\/\//i.test(realUrl)) continue;
				const h = await sha256Hex(realUrl.split("#")[0]);
				const res = await getTurso(env)
					.prepare(
						`INSERT OR IGNORE INTO news_article
						   (source, url, url_hash, title, excerpt, image_url, status, found_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
					)
					.bind(s.name, realUrl, h, it.title, it.excerpt, it.image || "", tsNow())
					.run();
				if (res.meta.changes > 0) added++;
			}
		} catch (e) {
			console.error("newsPullSources", s.name, e instanceof Error ? e.message : e);
		}
	}
	return { added, scanned };
}

// ---------------------------------------------------------------------------
// Gemini rewrite
// ---------------------------------------------------------------------------
interface Rewritten {
	title: string;
	html: string;
}

export async function geminiRewrite(env: Env, cfg: Record<string, string>, art: { title: string; excerpt: string; source: string; url: string }): Promise<Rewritten> {
	const key = cfg.gemini_key;
	const model = cfg.gemini_model || "gemini-3-flash-preview";
	if (!key) throw new Error("gemini_key belum diisi di konfigurasi BOT.");
	const style = cfg.rewrite_style || "Tulis ulang jadi artikel berbahasa Indonesia yang mengalir, gaya jurnalistik ringan.";
	const pMin = Math.max(1, Number(cfg.para_min || "5"));
	const pMax = Math.max(pMin, Number(cfg.para_max || "10"));
	const paraTarget = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
	const prompt =
		`${style}\n\n` +
		`Berdasarkan ringkasan berikut, tulis artikel BARU sepanjang ${paraTarget} paragraf ` +
		`(jangan menyalin kalimat asli, jangan mengarang fakta/angka yang tidak ada di ringkasan; ` +
		`boleh menambah konteks umum, latar belakang, dan analisis ringan agar artikel penuh). ` +
		`Balas HANYA JSON valid tanpa markdown: {"title": "...", "body_html": "<p>...</p><p>...</p>"}.\n\n` +
		`JUDUL ASLI: ${art.title}\n` +
		`RINGKASAN: ${art.excerpt || "(tidak ada, tulis ringkas dari judul saja)"}\n` +
		`SUMBER: ${art.source}`;
	// Model utama sering 503 (high demand) -> coba beberapa model berurutan.
	const models = [...new Set([model, "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest"])];
	let j: any = null;
	let lastErr = "";
	for (const mdl of models) {
		// thinkingConfig cuma didukung sebagian model (mis. gemini-3-flash-preview).
		// gemini-flash-lite-latest & sebagian lain balas 400 INVALID_ARGUMENT kalau
		// field ini disertakan -> kirim HANYA utk model yg namanya mengandung "3".
		const supportsThinking = /gemini-3/i.test(mdl);
		const generationConfig: Record<string, unknown> = {
			temperature: 0.85,
			maxOutputTokens: 8192,
			responseMimeType: "application/json",
		};
		if (supportsThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "X-goog-api-key": key },
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig,
					}),
				},
			);
			const body = (await r.json()) as any;
			const hasText = !!body?.candidates?.[0]?.content?.parts?.some((p: any) => p.text);
			if (r.ok && hasText) {
				j = body;
				break;
			}
			lastErr =
				"HTTP " + r.status + " " +
				(body?.candidates?.[0]?.finishReason
					? "finishReason=" + body.candidates[0].finishReason
					: JSON.stringify(body?.error || body).slice(0, 200));
			if (r.status === 503 || r.status === 429) {
				await new Promise((res) => setTimeout(res, 1200));
				continue;
			}
			break; // error non-transient -> ganti model
		}
		if (j) break;
	}
	if (!j) throw new Error("Gemini gagal semua model: " + lastErr);
	let text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
	text = text.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

	let title = "";
	let html = "";

	// 1) coba parse JSON apa adanya
	const tryParse = (s: string): boolean => {
		try {
			const p = JSON.parse(s);
			if (p && (p.body_html || p.html)) {
				title = String(p.title || "").trim();
				html = String(p.body_html || p.html || "").trim();
				return true;
			}
		} catch {
			/* noop */
		}
		return false;
	};
	const jsonM = text.match(/\{[\s\S]*\}/);
	if (!tryParse(text) && jsonM) {
		// 2) perbaiki masalah umum: newline mentah di dalam string JSON
		const repaired = jsonM[0].replace(/([^\\])\n/g, "$1\\n").replace(/\r/g, "");
		tryParse(repaired);
	}
	// 3) kalau JSON tetap gagal, ekstrak field pakai regex (JANGAN buang mentah JSON)
	if (!html) {
		const tm = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		const bm = text.match(/"body_html"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (bm) {
			const unesc = (x: string) => x.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			html = unesc(bm[1]).trim();
			if (tm) title = unesc(tm[1]).trim();
		}
	}
	// 4) benar-benar bukan JSON: anggap teks polos = body (bersihkan sisa JSON kalau ada)
	if (!html && text && !/^[\s{[]*["{]?\s*"?title"?\s*:/.test(text)) {
		html = text
			.split(/\n{2,}/)
			.map((p) => `<p>${p.replace(/<[^>]+>/g, "").trim()}</p>`)
			.filter((p) => p !== "<p></p>")
			.join("\n");
	}

	if (!html || /^\s*\{[\s\S]*"body_html"/.test(html)) {
		throw new Error("Gemini balas format tidak bisa dibaca (bukan artikel).");
	}
	if (!title) title = art.title;
	return { title: title.slice(0, 180), html };
}

// ---------------------------------------------------------------------------
// Blogger API v3
// ---------------------------------------------------------------------------
let _bloggerTok: { token: string; exp: number } | null = null;

export async function bloggerAccessToken(env: Env, cfg: Record<string, string>): Promise<string> {
	if (_bloggerTok && _bloggerTok.exp > Date.now() + 60_000) return _bloggerTok.token;
	const body = new URLSearchParams({
		client_id: cfg.blogger_client_id || "",
		client_secret: cfg.blogger_client_secret || "",
		refresh_token: cfg.blogger_refresh_token || "",
		grant_type: "refresh_token",
	});
	const r = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const j = (await r.json()) as any;
	if (!r.ok || !j.access_token) {
		throw new Error("Blogger OAuth refresh gagal: " + JSON.stringify(j).slice(0, 300));
	}
	_bloggerTok = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3500) * 1000 };
	return _bloggerTok.token;
}

export async function bloggerCreatePost(
	env: Env,
	cfg: Record<string, string>,
	post: { title: string; content: string; labels?: string[] },
): Promise<string> {
	const token = await bloggerAccessToken(env, cfg);
	const blogId = cfg.blogger_blog_id;
	if (!blogId) throw new Error("blogger_blog_id belum diisi.");
	const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts/`, {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: JSON.stringify({ kind: "blogger#post", title: post.title, content: post.content, labels: post.labels || [] }),
	});
	const j = (await r.json()) as any;
	if (!r.ok || !j.url) throw new Error("Blogger post gagal: " + JSON.stringify(j).slice(0, 300));
	return String(j.url);
}

// ---------------------------------------------------------------------------
// Proses 1 artikel: rewrite -> post -> tandai
// ---------------------------------------------------------------------------
export async function newsProcessOne(env: Env): Promise<{ done: boolean; title?: string; postUrl?: string; error?: string }> {
	const cfg = await botCfg(env);
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE status = 'new' ORDER BY id ASC LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false };
	const id = Number(row.id);
	try {
		const rw = await geminiRewrite(env, cfg, {
			title: String(row.title),
			excerpt: String(row.excerpt),
			source: String(row.source),
			url: String(row.url),
		});
		let content = rw.html;

		// Blok promo (disisipkan setelah paragraf ke-2 kalau bisa, biar natural).
		const promoUrl = (cfg.promo_url || "").trim();
		if (promoUrl) {
			const promoText = (cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim();
			const promo =
				`\n<div style="border:1px solid #e2e2e2;border-radius:10px;padding:14px 16px;margin:20px 0;background:#fafafa">` +
				`<p style="margin:0;font-size:14px">🛒 <strong>${escHtml(promoText)}</strong> &mdash; ` +
				`<a href="${escAttr(promoUrl)}" rel="noopener" target="_blank"><strong>Kunjungi Toko &raquo;</strong></a></p></div>`;
			const parts = content.split(/(<\/p>)/i);
			if (parts.length >= 6) {
				parts.splice(4, 0, promo); // setelah </p> ke-2
				content = parts.join("");
			} else {
				content += promo;
			}
		}

		if (String(cfg.attribution || "1") === "1") {
			content +=
				`\n<p style="font-size:13px;color:#666;margin-top:24px">Sumber: ` +
				`<a href="${escAttr(String(row.url))}" rel="nofollow noopener" target="_blank">${escHtml(String(row.source))}</a></p>`;
		}
		if (row.image_url) {
			content = `<p><img src="${escAttr(String(row.image_url))}" alt="" style="max-width:100%"></p>\n` + content;
		}

		// Label: sumber + label wajib dari config (mis. "LapakStore88").
		const labels = [String(row.source)];
		for (const l of String(cfg.post_labels || "").split(",").map((x) => x.trim()).filter(Boolean)) {
			if (!labels.includes(l)) labels.push(l);
		}
		const postUrl = await bloggerCreatePost(env, cfg, { title: rw.title, content, labels });
		await getTurso(env)
			.prepare(`UPDATE news_article SET status='posted', rewritten_html=?, post_url=?, posted_at=?, error='' WHERE id=?`)
			.bind(content, postUrl, tsNow(), id)
			.run();
		return { done: true, title: rw.title, postUrl };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await getTurso(env).prepare(`UPDATE news_article SET status='error', error=? WHERE id=?`).bind(msg.slice(0, 400), id).run();
		return { done: true, error: msg };
	}
}

async function postedToday(env: Env): Promise<number> {
	const r = await getTurso(env)
		.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE status='posted' AND substr(posted_at,1,10) = ?`)
		.bind(todayKey())
		.first<{ c: number }>();
	return Number(r?.c ?? 0);
}

/** Entry cron: /__cron?job=news */
export async function botNewsRun(env: Env): Promise<{ pulled: number; posted: number; capped: boolean; message: string }> {
	const cfg = await botCfg(env);
	if (String(cfg.enabled || "0") !== "1") {
		return { pulled: 0, posted: 0, capped: false, message: "BOT NEWS dimatikan (enabled=0)." };
	}
	const pull = await newsPullSources(env);
	const cap = Number(cfg.daily_cap || "8");
	const perRun = Math.max(1, Number(cfg.per_run || "2"));
	let posted = 0;
	let capped = false;
	for (let i = 0; i < perRun; i++) {
		if ((await postedToday(env)) >= cap) {
			capped = true;
			break;
		}
		const r = await newsProcessOne(env);
		if (!r.done) break; // tidak ada artikel 'new'
		if (r.postUrl) posted++;
	}
	return {
		pulled: pull.added,
		posted,
		capped,
		message: `Feed +${pull.added} artikel baru; diposting ${posted}${capped ? " (batas harian tercapai)" : ""}.`,
	};
}

// ---------------------------------------------------------------------------
// Untuk panel (API)
// ---------------------------------------------------------------------------
export async function botNewsSnapshot(env: Env) {
	const cfg = await botCfg(env);
	const sources =
		(await getTurso(env).prepare(`SELECT id, name, kind, url, active FROM news_source ORDER BY id`).all()).results ?? [];
	const counts =
		(await getTurso(env).prepare(`SELECT status, COUNT(*) AS c FROM news_article GROUP BY status`).all<{ status: string; c: number }>())
			.results ?? [];
	const recent =
		(await getTurso(env)
			.prepare(`SELECT id, source, title, status, url, post_url, error, found_at, posted_at FROM news_article ORDER BY id DESC LIMIT 40`)
			.all()).results ?? [];
	const history =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, post_url, posted_at
				 FROM news_article WHERE status='posted' ORDER BY posted_at DESC, id DESC LIMIT 200`,
			)
			.all()).results ?? [];
	const byStatus: Record<string, number> = {};
	for (const r of counts) byStatus[String(r.status)] = Number(r.c);
	return {
		success: true,
		config: {
			enabled: String(cfg.enabled || "0") === "1",
			per_run: Number(cfg.per_run || "2"),
			daily_cap: Number(cfg.daily_cap || "8"),
			attribution: String(cfg.attribution || "1") === "1",
			rewrite_style: cfg.rewrite_style || "",
			para_min: Number(cfg.para_min || "5"),
			para_max: Number(cfg.para_max || "10"),
			promo_url: cfg.promo_url || "",
			promo_text: cfg.promo_text || "",
			post_labels: cfg.post_labels || "",
			gemini_model: cfg.gemini_model || "gemini-flash-latest",
			has_gemini_key: !!cfg.gemini_key,
			has_blogger: !!(cfg.blogger_refresh_token && cfg.blogger_blog_id),
			blog_id: cfg.blogger_blog_id || "",
		},
		postedToday: await postedToday(env),
		byStatus,
		sources,
		recent,
		history,
	};
}
