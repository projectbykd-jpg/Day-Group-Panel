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

/** Ambil <meta property="og:image"> dari halaman artikel — fallback saat feed (mis. Google News) tidak kirim gambar. */
async function fetchOgImage(pageUrl: string): Promise<string> {
	try {
		const r = await fetch(pageUrl, { headers: { "User-Agent": UA } });
		if (!r.ok) return "";
		const html = await r.text();
		const m =
			html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
			html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
		return m ? decodeEntities(m[1]) : "";
	} catch {
		return "";
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
export async function newsPullSources(env: Env, perSource = 6): Promise<{ added: number; scanned: number }> {
	const srcs =
		(await getTurso(env).prepare(`SELECT id, name, kind, url FROM news_source WHERE active = 1`).all<{ id: number; name: string; kind: string; url: string }>())
			.results ?? [];
	// Cloudflare Free: 50 subrequest/invocation, TERHITUNG jg query Turso — dan
	// botNewsRun masih lanjut newsProcessOne (fetch Gemini+Blogger) sesudah ini
	// dalam invocation yang SAMA. Batasi total fetch eksternal (feed + resolve
	// gnews) di sini, dan tulis hasil lewat batch (bukan 1 query per artikel) —
	// dulu 10 sumber x 12 item x 1 query = ratusan subrequest -> "Too many
	// subrequests" -> exception tak tertangkap -> auto-post diam tanpa error.
	const EXTERNAL_FETCH_BUDGET = 14;
	let extFetches = 0;
	let scanned = 0;
	const rows: { source: string; url: string; hash: string; title: string; excerpt: string; image: string }[] = [];
	const seenHash = new Set<string>();

	for (const s of srcs) {
		if (extFetches >= EXTERNAL_FETCH_BUDGET) break;
		try {
			extFetches++;
			const items = (await fetchFeed(s.kind, s.url)).slice(0, perSource);
			for (const it of items) {
				if (extFetches >= EXTERNAL_FETCH_BUDGET) break;
				scanned++;
				let realUrl = it.url;
				if (s.kind === "gnews") {
					extFetches++;
					realUrl = await resolveGnews(it.url);
				}
				if (!/^https?:\/\//i.test(realUrl)) continue;
				const h = await sha256Hex(realUrl.split("#")[0]);
				if (seenHash.has(h)) continue;
				seenHash.add(h);
				rows.push({ source: s.name, url: realUrl, hash: h, title: it.title, excerpt: it.excerpt, image: it.image || "" });
			}
		} catch (e) {
			console.error("newsPullSources", s.name, e instanceof Error ? e.message : e);
		}
	}

	let added = 0;
	const now = tsNow();
	const stmts = rows.map((r) =>
		getTurso(env)
			.prepare(
				`INSERT OR IGNORE INTO news_article
				   (source, url, url_hash, title, excerpt, image_url, status, found_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
			)
			.bind(r.source, r.url, r.hash, r.title, r.excerpt, r.image, now),
	);
	for (let i = 0; i < stmts.length; i += 25) {
		const res = await getTurso(env).batch(stmts.slice(i, i + 25));
		added += res.filter((r) => r.meta.changes > 0).length;
	}
	return { added, scanned };
}

// ---------------------------------------------------------------------------
// Gemini rewrite
// ---------------------------------------------------------------------------
interface Rewritten {
	title: string;
	html: string;
	metaDescription: string;
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
		`Sertakan juga "meta_description": ringkasan 1 kalimat (maks 155 karakter) utk cuplikan hasil pencarian Google — ` +
		`bukan copy kalimat pertama artikel, tapi rangkuman inti isi artikel. ` +
		`Balas HANYA JSON valid tanpa markdown: {"title": "...", "meta_description": "...", "body_html": "<p>...</p><p>...</p>"}.\n\n` +
		`JUDUL ASLI: ${art.title}\n` +
		`RINGKASAN: ${art.excerpt || "(tidak ada, tulis ringkas dari judul saja)"}\n` +
		`SUMBER: ${art.source}`;
	// Model utama sering 503 (high demand) -> coba beberapa model berurutan.
	// SATU percobaan per model (bukan 2x) -> tiap fetch Gemini adalah 1 subrequest
	// Cloudflare; loop lama (sampai 2 attempt x 4 model = 8 fetch) ikut andil bikin
	// invocation kena "Too many subrequests" (limit 50/invocation Free plan).
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
	}
	if (!j) throw new Error("Gemini gagal semua model: " + lastErr);
	let text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
	text = text.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

	let title = "";
	let html = "";
	let metaDescription = "";

	// 1) coba parse JSON apa adanya
	const tryParse = (s: string): boolean => {
		try {
			const p = JSON.parse(s);
			if (p && (p.body_html || p.html)) {
				title = String(p.title || "").trim();
				html = String(p.body_html || p.html || "").trim();
				metaDescription = String(p.meta_description || "").trim();
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
		const dm = text.match(/"meta_description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (bm) {
			const unesc = (x: string) => x.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			html = unesc(bm[1]).trim();
			if (tm) title = unesc(tm[1]).trim();
			if (dm) metaDescription = unesc(dm[1]).trim();
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
	if (!metaDescription) {
		// fallback: potong dari teks polos hasil rewrite (tanpa tag HTML)
		metaDescription = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 155);
	}
	return { title: title.slice(0, 180), html, metaDescription: metaDescription.slice(0, 155) };
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
	post: { title: string; content: string; labels?: string[]; searchDescription?: string },
): Promise<string> {
	const token = await bloggerAccessToken(env, cfg);
	const blogId = cfg.blogger_blog_id;
	if (!blogId) throw new Error("blogger_blog_id belum diisi.");
	const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts/`, {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: JSON.stringify({
			kind: "blogger#post",
			title: post.title,
			content: post.content,
			labels: post.labels || [],
			// Field ini yang tampil sebagai cuplikan di hasil pencarian Google
			// (SEO meta description) -- tanpa ini Google ambil cuplikan asal dari isi.
			searchDescription: (post.searchDescription || "").slice(0, 155),
		}),
	});
	const j = (await r.json()) as any;
	if (!r.ok || !j.url) throw new Error("Blogger post gagal: " + JSON.stringify(j).slice(0, 300));
	return String(j.url);
}

// ---------------------------------------------------------------------------
// Facebook Page — auto-share tiap artikel yang terbit di Blogger
// ---------------------------------------------------------------------------
function buildFbCaption(title: string, metaDescription: string, postUrl: string): string {
	const lines = [`📰 ${title}`];
	if (metaDescription) lines.push("", metaDescription);
	lines.push("", `🔗 Baca selengkapnya: ${postUrl}`);
	return lines.join("\n").slice(0, 1900); // batas wajar caption FB
}

/** Posting ke Facebook Page (foto+caption kalau ada gambar, teks+link kalau tidak). Gagal = non-fatal, dicatat saja. */
export async function fbPostToPage(
	cfg: Record<string, string>,
	post: { title: string; metaDescription: string; postUrl: string; imageUrl?: string },
): Promise<string | null> {
	const pageId = cfg.fb_page_id;
	const token = cfg.fb_page_token;
	if (!pageId || !token) return null; // belum disetel -> lewati diam-diam
	const caption = buildFbCaption(post.title, post.metaDescription, post.postUrl);
	const endpoint = post.imageUrl
		? `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/photos`
		: `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/feed`;
	const body = new URLSearchParams({ access_token: token });
	if (post.imageUrl) {
		body.set("url", post.imageUrl);
		body.set("caption", caption);
	} else {
		body.set("message", caption);
		body.set("link", post.postUrl);
	}
	const r = await fetch(endpoint, { method: "POST", body });
	const j = (await r.json()) as any;
	if (!r.ok || (!j.id && !j.post_id)) {
		throw new Error("Facebook post gagal: " + JSON.stringify(j?.error || j).slice(0, 300));
	}
	return String(j.post_id || j.id);
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
		// Feed Google News (dipakai Kompas/Tribunnews) tidak menyertakan gambar
		// sama sekali -> post-nya tampil tanpa thumbnail di daftar Blogger. Kalau
		// image_url kosong, coba ambil <meta og:image> dari halaman artikel asli
		// (1 fetch tambahan, cuma dipanggil di sini per-artikel yang DIPROSES,
		// bukan saat pull massal -> anggaran subrequest masih aman).
		let imageUrl = String(row.image_url || "");
		if (!imageUrl) {
			imageUrl = await fetchOgImage(String(row.url));
		}
		if (imageUrl) {
			content = `<p><img src="${escAttr(imageUrl)}" alt="" style="max-width:100%"></p>\n` + content;
		}

		// Label: sumber + label wajib dari config (mis. "LapakStore88").
		const labels = [String(row.source)];
		for (const l of String(cfg.post_labels || "").split(",").map((x) => x.trim()).filter(Boolean)) {
			if (!labels.includes(l)) labels.push(l);
		}
		const postUrl = await bloggerCreatePost(env, cfg, { title: rw.title, content, labels, searchDescription: rw.metaDescription });
		await getTurso(env)
			.prepare(`UPDATE news_article SET status='posted', rewritten_html=?, post_url=?, posted_at=?, error='' WHERE id=?`)
			.bind(content, postUrl, tsNow(), id)
			.run();

		// Auto-share ke Facebook Page — GAGAL DI SINI TIDAK BOLEH membatalkan
		// posting Blogger yang sudah berhasil (non-fatal, dicatat saja).
		if (String(cfg.fb_enabled || "0") === "1") {
			try {
				await fbPostToPage(cfg, { title: rw.title, metaDescription: rw.metaDescription, postUrl, imageUrl });
			} catch (e) {
				console.error("fbPostToPage gagal:", e instanceof Error ? e.message : e);
			}
		}

		return { done: true, title: rw.title, postUrl };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// "User location is not supported" = Cloudflare edge yg kebagian request ini
		// kena geo-block Gemini, sifatnya per-titik-edge & sementara (edge lain masih
		// jalan). JANGAN tandai error permanen -> biarkan 'new' supaya tick berikutnya
		// (kemungkinan lewat edge lain) otomatis coba lagi, tidak nyangkut butuh skip manual.
		// Sama dgn geo-block Gemini: rate limit Blogger (429 rateLimitExceeded/
		// RESOURCE_EXHAUSTED) sifatnya SEMENTARA (reda dlm hitungan menit) -- JANGAN
		// tandai error permanen, biar dicoba lagi otomatis tick berikutnya.
		if (/location is not supported/i.test(msg) || /rateLimitExceeded|RESOURCE_EXHAUSTED|user-?Rate ?Limit/i.test(msg)) {
			return { done: true, error: msg + " (akan dicoba lagi otomatis)" };
		}
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
// Batas keras utk sekali panggil (tombol "Proses Sekarang" manual TERMASUK):
// tiap artikel makan ~4-8 subrequest (Gemini + Blogger + Turso). Cloudflare Free
// cuma kasih 50 subrequest/invocation -- lihat catatan di newsPullSources.
const MAX_RUN_COUNT = 5;

export async function botNewsRun(
	env: Env,
	opts: { force?: boolean; count?: number } = {},
): Promise<{ pulled: number; posted: number; capped: boolean; message: string }> {
	const cfg = await botCfg(env);
	if (!opts.force && String(cfg.enabled || "0") !== "1") {
		return { pulled: 0, posted: 0, capped: false, message: "BOT NEWS dimatikan (enabled=0)." };
	}
	const perRun = opts.count
		? Math.max(1, Math.min(MAX_RUN_COUNT, Math.floor(opts.count)))
		: Math.max(1, Number(cfg.per_run || "2"));

	// newsPullSources sendiri makan ~17 subrequest (feed+resolve+batch insert).
	// Kalau antrean 'new' sudah cukup (backlog), lewati pull -> hemat anggaran
	// buat proses artikel (masih kena limit 50/invocation kalau ditambah).
	const queued = await getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article WHERE status = 'new'`).first<{ c: number }>();
	const pull = Number(queued?.c ?? 0) >= perRun * 3 ? { added: 0, scanned: 0 } : await newsPullSources(env);

	const cap = Number(cfg.daily_cap || "8");
	// Query 1x, lalu update di memori -> bukan 1 query/iterasi (hemat subrequest).
	let postedSoFar = await postedToday(env);
	let posted = 0;
	let capped = false;
	let lastError = "";
	for (let i = 0; i < perRun; i++) {
		if (postedSoFar >= cap) {
			capped = true;
			break;
		}
		const r = await newsProcessOne(env);
		if (!r.done) break; // tidak ada artikel 'new'
		if (r.postUrl) {
			posted++;
			postedSoFar++;
		}
		if (r.error) lastError = r.error;
		// Geo-block sementara di edge ini -> hentikan tick, jangan ulang artikel yang
		// sama berkali-kali (edge-nya sama sepanjang 1 invocation).
		if (r.error && /location is not supported|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(r.error)) break;
	}
	return {
		pulled: pull.added,
		posted,
		capped,
		// Kalau 0 posting & ada error, tampilkan alasannya -- biar user/kita tidak
		// perlu buka database tiap kali cuma buat tahu KENAPA 0.
		message:
			`Feed +${pull.added} artikel baru; diposting ${posted}${capped ? " (batas harian tercapai)" : ""}.` +
			(posted === 0 && lastError ? ` [${lastError.slice(0, 200)}]` : ""),
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
			fb_enabled: String(cfg.fb_enabled || "0") === "1",
			fb_page_id: cfg.fb_page_id || "",
			has_facebook: !!(cfg.fb_page_id && cfg.fb_page_token),
		},
		postedToday: await postedToday(env),
		byStatus,
		sources,
		recent,
		history,
	};
}
