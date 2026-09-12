// Modul NEWS untuk Role BOT: tarik feed berita -> rewrite via Gemini ->
// posting ke Blogger. Semua state di Turso (bot_kv / news_source / news_article).
import { getTurso } from "./turso";
import { tsNow } from "./time";

// Dipakai dropdown "Tambah Sumber" (panel) & filter kategori di endpoint publik
// /public/news. Daftar cocok dengan kategori RSS Liputan6 yang sudah dicek --
// begitu sumber per-kategori ditambahkan, artikelnya otomatis kebagi rapi.
export const NEWS_CATEGORIES = ["umum", "nasional", "bisnis", "olahraga", "bola", "hiburan", "selebritis", "teknologi", "otomotif", "kesehatan", "lifestyle"] as const;
const NEWS_CATEGORY_LABELS: Record<string, string> = {
	umum: "Umum",
	nasional: "Nasional",
	bisnis: "Bisnis",
	olahraga: "Olahraga",
	bola: "Bola",
	hiburan: "Hiburan",
	selebritis: "Selebritis",
	teknologi: "Teknologi",
	otomotif: "Otomotif",
	kesehatan: "Kesehatan",
	lifestyle: "Lifestyle",
};
function newsCategoryLabel(cat: string): string {
	return NEWS_CATEGORY_LABELS[cat] || NEWS_CATEGORY_LABELS.umum;
}

// Kolom category ditambahkan belakangan -- migrasi malas (lazy), sama seperti
// fb_template_caption di bawah: dicoba sekali per cold-start isolate, aman
// dipanggil berkali² (duplicate column diabaikan), tidak perlu skrip migrasi
// manual terpisah.
let newsCategoryColumnsEnsured = false;
export async function ensureNewsCategoryColumns(env: Env): Promise<void> {
	if (newsCategoryColumnsEnsured) return;
	for (const stmt of [
		`ALTER TABLE news_source ADD COLUMN category TEXT NOT NULL DEFAULT 'umum'`,
		`ALTER TABLE news_article ADD COLUMN category TEXT NOT NULL DEFAULT 'umum'`,
		// site_posted_at = kapan artikel ini tersedia di LapakStore88 (Berita Terkini) --
		// TERPISAH dari posted_at (kapan sukses posting ke Blogger). Blogger tetap
		// dibatasi daily_cap (anti-spam-flag), tapi situs sendiri TIDAK dibatasi sama
		// sekali (lihat newsProcessOne/botNewsRun) -- pemilik minta situs sendiri boleh
		// jauh lebih banyak daripada Blogger.
		`ALTER TABLE news_article ADD COLUMN site_posted_at TEXT NOT NULL DEFAULT ''`,
	]) {
		try {
			await getTurso(env).prepare(stmt).run();
		} catch {
			/* kolom sudah ada -> abaikan */
		}
	}
	// PEMBALIKAN backfill lama: sempat ada migrasi sementara yang mengisi
	// site_posted_at dari posted_at utk SEMUA artikel status='posted' (Blogger),
	// supaya tidak "hilang" dari Berita Terkini sebelum loop situs sendiri ada.
	// Sekarang pemilik tegas minta 2 jalur ini TIDAK BOLEH dobel -- artikel yang
	// posting ke Blogger TIDAK tampil di situs sendiri. Bersihkan sisa dari
	// backfill lama itu (idempotent: no-op begitu semuanya sudah bersih).
	try {
		await getTurso(env).prepare(`UPDATE news_article SET site_posted_at = '' WHERE status = 'posted' AND site_posted_at != ''`).run();
	} catch {
		/* abaikan */
	}
	newsCategoryColumnsEnsured = true;
}

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
		// Beberapa situs (mis. Kompas) menaruh atribut dalam urutan/variasi lain --
		// dicoba beberapa pola sebelum menyerah, bukan cuma og:image standar.
		const m =
			html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
			html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i) ||
			html.match(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i) ||
			html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
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
	await ensureNewsCategoryColumns(env);
	// ORDER BY RANDOM() -- PENTING: EXTERNAL_FETCH_BUDGET di bawah (14) selalu
	// lebih kecil dari jumlah sumber aktif sekarang (~19+ setelah nambah RSS
	// per-kategori Liputan6+Detik), jadi kalau urutannya tetap (id ASC, default
	// SQLite), sumber dgn id lebih besar (yang paling baru ditambah) TIDAK
	// PERNAH kebagian giliran ditarik -- budget selalu habis duluan di sumber
	// lama. Acak urutannya tiap pull supaya semua sumber gantian kebagian.
	const srcs =
		(
			await getTurso(env)
				.prepare(`SELECT id, name, kind, url, category FROM news_source WHERE active = 1 ORDER BY RANDOM()`)
				.all<{ id: number; name: string; kind: string; url: string; category: string }>()
		).results ?? [];
	// Cloudflare Free: 50 subrequest/invocation, TERHITUNG jg query Turso — dan
	// botNewsRun masih lanjut newsProcessOne (fetch Gemini+Blogger) sesudah ini
	// dalam invocation yang SAMA. Batasi total fetch eksternal (feed + resolve
	// gnews) di sini, dan tulis hasil lewat batch (bukan 1 query per artikel) —
	// dulu 10 sumber x 12 item x 1 query = ratusan subrequest -> "Too many
	// subrequests" -> exception tak tertangkap -> auto-post diam tanpa error.
	const EXTERNAL_FETCH_BUDGET = 14;
	let extFetches = 0;
	let scanned = 0;
	const rows: { source: string; url: string; hash: string; title: string; excerpt: string; image: string; category: string }[] = [];
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
				rows.push({ source: s.name, url: realUrl, hash: h, title: it.title, excerpt: it.excerpt, image: it.image || "", category: s.category || "umum" });
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
				   (source, url, url_hash, title, excerpt, image_url, status, found_at, category)
				 VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
			)
			.bind(r.source, r.url, r.hash, r.title, r.excerpt, r.image, now, r.category),
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
	category: string;
}

export async function geminiRewrite(env: Env, cfg: Record<string, string>, art: { title: string; excerpt: string; source: string; url: string }): Promise<Rewritten> {
	const key = cfg.gemini_key;
	const model = cfg.gemini_model || "gemini-3-flash-preview";
	if (!key) throw new Error("gemini_key belum diisi di konfigurasi BOT.");
	const style = cfg.rewrite_style || "Tulis ulang jadi artikel berbahasa Indonesia yang mengalir, gaya jurnalistik ringan.";
	const pMin = Math.max(1, Number(cfg.para_min || "8"));
	const pMax = Math.max(pMin, Number(cfg.para_max || "14"));
	const paraTarget = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
	const prompt =
		`${style}\n\n` +
		`Berdasarkan ringkasan berikut, tulis artikel BARU yang PANJANG dan MENDALAM, sepanjang ${paraTarget} paragraf ` +
		`(jangan menyalin kalimat asli, jangan mengarang fakta/angka spesifik yang tidak ada di ringkasan). ` +
		`Supaya pembahasannya detail dan tidak terasa diulur-ulur, bangun artikel dengan beberapa sudut berikut ` +
		`(pilih yang relevan dengan topiknya, TIDAK harus semua & TIDAK usah pakai sub-judul eksplisit): ` +
		`(1) pembukaan yang menjelaskan inti kejadian, (2) latar belakang/kronologi/konteks sebelumnya, ` +
		`(3) penjelasan lebih rinci tiap poin penting di ringkasan — pecah jadi beberapa paragraf, jangan digabung jadi satu, ` +
		`(4) dampak atau relevansinya bagi pembaca/masyarakat/industri terkait, ` +
		`(5) reaksi atau sudut pandang pihak-pihak terkait (SECARA UMUM/wajar, JANGAN mengarang kutipan/nama yang tidak ada di ringkasan), ` +
		`(6) penutup yang merangkum & memberi gambaran ke depan. ` +
		`Tiap paragraf idealnya 3-5 kalimat yang mengalir, bukan poin-poin pendek. ` +
		`Sertakan juga "meta_description": ringkasan 1 kalimat (maks 155 karakter) utk cuplikan hasil pencarian Google — ` +
		`bukan copy kalimat pertama artikel, tapi rangkuman inti isi artikel. ` +
		`Sertakan juga "category": kategori artikel ini, PILIH TEPAT SATU dari daftar berikut sesuai topik sebenarnya ` +
		`(jangan mengarang kategori lain di luar daftar): ${NEWS_CATEGORIES.join(", ")}. ` +
		`Balas HANYA JSON valid tanpa markdown: {"title": "...", "meta_description": "...", "category": "...", "body_html": "<p>...</p><p>...</p>"}.\n\n` +
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
	let category = "";

	// 1) coba parse JSON apa adanya
	const tryParse = (s: string): boolean => {
		try {
			const p = JSON.parse(s);
			if (p && (p.body_html || p.html)) {
				title = String(p.title || "").trim();
				html = String(p.body_html || p.html || "").trim();
				metaDescription = String(p.meta_description || "").trim();
				category = String(p.category || "").trim().toLowerCase();
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
		const cm = text.match(/"category"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (bm) {
			const unesc = (x: string) => x.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			html = unesc(bm[1]).trim();
			if (tm) title = unesc(tm[1]).trim();
			if (dm) metaDescription = unesc(dm[1]).trim();
			if (cm) category = unesc(cm[1]).trim().toLowerCase();
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
	// Kategori dari AI dipakai HANYA kalau cocok salah satu dari daftar resmi --
	// kalau Gemini "mengarang" nilai di luar daftar, biarkan kosong supaya
	// pemanggil (newsProcessOne) jatuh balik ke kategori sumbernya (aman,
	// tidak pernah menyimpan kategori sampah/tidak dikenal ke database).
	if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) category = "";
	return { title: title.slice(0, 180), html, metaDescription: metaDescription.slice(0, 155), category };
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
// Domain situs sendiri (LapakStore88 / "Berita Terkini") -- dipromosikan di
// setiap posting Facebook Page bersama link Blogger & toko, sesuai permintaan
// pemilik supaya ketiga aset (Blogger, situs berita sendiri, toko) selalu
// saling mempromosikan satu sama lain.
const LAPAKSTORE_SITE_URL = "https://lokalstore88.online";

function buildFbCaption(title: string, metaDescription: string, links: { blogger?: string; site?: string; store?: string }): string {
	const lines = [`📰 ${title}`];
	if (metaDescription) lines.push("", metaDescription);
	lines.push("");
	if (links.blogger) lines.push(`🔗 Baca di blog kami: ${links.blogger}`);
	if (links.site) lines.push(`📰 Baca di web berita kami: ${links.site}`);
	if (links.store) lines.push(`🛒 Toko aplikasi premium: ${links.store}`);
	return lines.join("\n").slice(0, 1900); // batas wajar caption FB
}

/** Posting ke Facebook Page (foto+caption kalau ada gambar, teks+link kalau tidak). Gagal = non-fatal, dicatat saja. */
export async function fbPostToPage(
	cfg: Record<string, string>,
	post: { title: string; metaDescription: string; postUrl: string; imageUrl?: string; siteUrl?: string; storeUrl?: string },
): Promise<string | null> {
	const pageId = cfg.fb_page_id;
	const token = cfg.fb_page_token;
	if (!pageId || !token) return null; // belum disetel -> lewati diam-diam
	const caption = buildFbCaption(post.title, post.metaDescription, { blogger: post.postUrl, site: post.siteUrl, store: post.storeUrl });
	const primaryLink = post.postUrl || post.siteUrl || post.storeUrl || "";
	const endpoint = post.imageUrl
		? `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/photos`
		: `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/feed`;
	const body = new URLSearchParams({ access_token: token });
	if (post.imageUrl) {
		body.set("url", post.imageUrl);
		body.set("caption", caption);
	} else {
		body.set("message", caption);
		body.set("link", primaryLink);
	}
	const r = await fetch(endpoint, { method: "POST", body });
	const j = (await r.json()) as any;
	if (!r.ok || (!j.id && !j.post_id)) {
		throw new Error("Facebook post gagal: " + JSON.stringify(j?.error || j).slice(0, 300));
	}
	return String(j.post_id || j.id);
}

// ---------------------------------------------------------------------------
// FACEBOOK LANGSUNG — jalur terpisah dari Blogger. Ambil artikel dari kolam
// yang sama (news_article) tapi dilacak lewat kolom fb_direct_posted_at
// sendiri, jadi TIDAK terganggu kalau Blogger sedang kena rate-limit, dan
// TIDAK bentrok dgn newsProcessOne (keduanya boleh memproses artikel yg sama,
// masing-masing independen).
// ---------------------------------------------------------------------------

/** Caption pendek & menarik ala media sosial — LEBIH RINGAN dari rewrite artikel penuh (hemat token & subrequest). */
async function geminiFbCaption(cfg: Record<string, string>, art: { title: string; excerpt: string; source: string }): Promise<string> {
	const key = cfg.gemini_key;
	const model = cfg.gemini_model || "gemini-3-flash-preview";
	if (!key) throw new Error("gemini_key belum diisi di konfigurasi BOT.");
	const prompt =
		`Buatkan caption Facebook yang singkat, menarik, dan mengundang rasa penasaran (gaya media sosial, ` +
		`boleh pakai 1-2 emoji, MAKS 3 kalimat, JANGAN mengarang fakta baru di luar ringkasan). ` +
		`Balas HANYA teks captionnya saja, tanpa tanda kutip, tanpa markdown.\n\n` +
		`JUDUL: ${art.title}\nRINGKASAN: ${art.excerpt || "(tidak ada)"}\nSUMBER: ${art.source}`;
	const models = [...new Set([model, "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest"])];
	for (const mdl of models) {
		const supportsThinking = /gemini-3/i.test(mdl);
		const generationConfig: Record<string, unknown> = { temperature: 0.9, maxOutputTokens: 300 };
		if (supportsThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
		try {
			const r = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "X-goog-api-key": key },
					body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
				},
			);
			const body = (await r.json()) as any;
			const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim();
			if (r.ok && text) return text.replace(/^["']|["']$/g, "").slice(0, 500);
		} catch {
			/* coba model berikutnya */
		}
	}
	// fallback tanpa AI kalau semua model gagal -- tetap bisa posting, cuma polos.
	return `${art.title}`;
}

export async function fbDirectProcessOne(env: Env): Promise<{ done: boolean; title?: string; error?: string }> {
	const cfg = await botCfg(env);
	if (!cfg.fb_page_id || !cfg.fb_page_token) return { done: false, error: "Facebook belum tersambung." };
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE fb_direct_posted_at = '' ORDER BY id ASC LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false };
	const id = Number(row.id);
	try {
		const caption = await geminiFbCaption(cfg, { title: String(row.title), excerpt: String(row.excerpt), source: String(row.source) });
		let imageUrl = String(row.image_url || "");
		if (!imageUrl) imageUrl = await fetchOgImage(String(row.url));
		// Kalau artikel ini SUDAH ada versi Blogger-nya, arahkan ke situ (bangun
		// trafik blog); kalau belum, arahkan ke sumber asli sbg atribusi.
		const linkUrl = row.post_url || row.url;
		await fbPostToPage(cfg, {
			title: String(row.title),
			metaDescription: caption,
			postUrl: String(linkUrl),
			imageUrl,
			siteUrl: `${LAPAKSTORE_SITE_URL}/berita/artikel/?id=${id}`,
			storeUrl: (cfg.promo_url || "").trim() || undefined,
		});
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = ? WHERE id = ?`).bind(tsNow(), id).run();
		return { done: true, title: String(row.title) };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Transient (geo-block/rate-limit) -> JANGAN tandai selesai, biarkan dicoba lagi.
		if (/location is not supported|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(msg)) {
			return { done: true, error: msg + " (akan dicoba lagi otomatis)" };
		}
		// Error lain (mis. token FB kadaluwarsa) -> tandai supaya tidak diulang
		// tanpa henti, tapi catat alasannya di kolom error (dipakai bareng Blogger).
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = 'error' WHERE id = ?`).bind(id).run();
		return { done: true, error: msg };
	}
}

// ---------------------------------------------------------------------------
// TEMPLATE FB — pengganti posting otomatis (Facebook API sering diblokir
// Facebook untuk Page baru/kategori berita). Sama sekali TIDAK menyentuh
// Graph API: cuma menyiapkan gambar + caption supaya pemilik tinggal
// copy-paste & posting MANUAL dari akun Facebook-nya sendiri.
// ---------------------------------------------------------------------------

// Hashtag "evergreen" biar postingan gampang ketemu orang yang lagi cari/scroll berita,
// dipasang tetap di tiap template supaya jangkauan konsisten walau AI-nya kadang pelit hashtag.
const FB_TEMPLATE_EVERGREEN_HASHTAGS = ["#BeritaTerkini", "#BeritaHariIni", "#InfoTerkini", "#BeritaViral", "#BeritaUpdate"];

/** Caption + hashtag utk template manual — link ditambahkan terpisah di bawah (bukan oleh AI). */
async function geminiFbTemplateCaption(
	cfg: Record<string, string>,
	art: { title: string; excerpt: string; source: string },
): Promise<{ text: string; hashtags: string[] }> {
	const key = cfg.gemini_key;
	const model = cfg.gemini_model || "gemini-3-flash-preview";
	if (!key) throw new Error("gemini_key belum diisi di konfigurasi BOT.");
	const prompt =
		`Buatkan caption Facebook yang singkat, menarik, dan memancing rasa penasaran pembaca (gaya media sosial, ` +
		`boleh pakai 1-3 emoji, MAKS 4 kalimat, JANGAN mengarang fakta baru di luar ringkasan). ` +
		`Tutup dengan satu kalimat ajakan yang bikin orang PENASARAN untuk klik link selengkapnya ` +
		`(JANGAN tulis link/URL apa pun, link akan ditambahkan otomatis di bawah captionmu). ` +
		`SETELAH itu, di baris terpisah setelah tanda "===HASHTAG===", tuliskan 5-8 hashtag ` +
		`(gabungan Bahasa Indonesia, dipisah spasi, huruf tanpa spasi di dalamnya, contoh: #BeritaJakarta) ` +
		`yang relevan dengan topik/tokoh/kategori berita ini SUPAYA postingan gampang muncul di pencarian & ` +
		`beranda orang yang suka/cari berita. Balas HANYA dalam format:\n` +
		`<caption>\n===HASHTAG===\n<hashtag1> <hashtag2> ...\n\n` +
		`JUDUL: ${art.title}\nRINGKASAN: ${art.excerpt || "(tidak ada)"}\nSUMBER: ${art.source}`;
	const models = [...new Set([model, "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest"])];
	for (const mdl of models) {
		const supportsThinking = /gemini-3/i.test(mdl);
		const generationConfig: Record<string, unknown> = { temperature: 0.9, maxOutputTokens: 350 };
		if (supportsThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
		try {
			const r = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "X-goog-api-key": key },
					body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
				},
			);
			const body = (await r.json()) as any;
			const raw = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim();
			if (r.ok && raw) {
				const [captionPart, hashtagPart] = raw.split(/===HASHTAG===/i);
				const text = (captionPart || raw).replace(/^["']|["']$/g, "").trim().slice(0, 500);
				const aiTags = (hashtagPart || "").match(/#[\p{L}\p{N}_]+/gu) || [];
				return { text, hashtags: aiTags.slice(0, 8) };
			}
		} catch {
			/* coba model berikutnya */
		}
	}
	return { text: art.title, hashtags: [] };
}

// Kolom penyimpan hasil template supaya bisa "dibuka lagi" dari Riwayat (caption
// tadinya cuma balikan sesaat, hilang begitu di-refresh). Migrasi malas (lazy) --
// dicoba sekali per cold-start isolate, aman dipanggil berkali² (duplicate column
// diabaikan) jadi tidak perlu skrip migrasi terpisah lagi.
let fbTemplateColumnEnsured = false;
async function ensureFbTemplateColumn(env: Env): Promise<void> {
	if (fbTemplateColumnEnsured) return;
	try {
		await getTurso(env).prepare(`ALTER TABLE news_article ADD COLUMN fb_template_caption TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada -> abaikan */
	}
	fbTemplateColumnEnsured = true;
}

/** Ambil 1 artikel berikutnya & siapkan gambar+caption utk di-copy manual ke Facebook. Tidak memanggil Graph API sama sekali. */
export async function fbTemplateGenerate(
	env: Env,
): Promise<{ done: boolean; title?: string; imageUrl?: string; caption?: string; error?: string }> {
	await ensureFbTemplateColumn(env);
	const cfg = await botCfg(env);
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE fb_direct_posted_at = '' ORDER BY id ASC LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false, error: "Tidak ada artikel baru untuk dibuatkan template." };
	const id = Number(row.id);
	try {
		const gen = await geminiFbTemplateCaption(cfg, {
			title: String(row.title),
			excerpt: String(row.excerpt),
			source: String(row.source),
		});
		let imageUrl = String(row.image_url || "");
		if (!imageUrl) imageUrl = await fetchOgImage(String(row.url));
		const linkUrl = String(row.post_url || row.url || "");
		const hashtags = [...new Set([...gen.hashtags, ...FB_TEMPLATE_EVERGREEN_HASHTAGS])].slice(0, 12);
		const parts = [gen.text];
		if (linkUrl) parts.push(`🔗 Baca selengkapnya: ${linkUrl}`);
		// Promosi toko -- sama seperti yang otomatis disisipkan di artikel Blogger/
		// situs sendiri, supaya caption manual ini juga ikut mempromosikan toko.
		const promoUrl = (cfg.promo_url || "").trim();
		if (promoUrl) parts.push(`🛒 ${(cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim()}: ${promoUrl}`);
		if (hashtags.length) parts.push(hashtags.join(" "));
		const caption = parts.join("\n\n");
		// Simpan hasilnya (bukan cuma tandai selesai) supaya bisa "dibuka lagi" dari Riwayat.
		await getTurso(env)
			.prepare(
				`UPDATE news_article SET fb_direct_posted_at = ?, fb_template_caption = ?, image_url = CASE WHEN image_url = '' THEN ? ELSE image_url END WHERE id = ?`,
			)
			.bind(tsNow(), caption, imageUrl, id)
			.run();
		return { done: true, title: String(row.title), imageUrl, caption };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/location is not supported|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(msg)) {
			return { done: false, error: msg + " (coba lagi sebentar)" };
		}
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = 'error' WHERE id = ?`).bind(id).run();
		return { done: false, error: msg };
	}
}

async function fbDirectPostedToday(env: Env): Promise<number> {
	const r = await getTurso(env)
		.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error') AND substr(fb_direct_posted_at,1,10) = ?`)
		.bind(todayKey())
		.first<{ c: number }>();
	return Number(r?.c ?? 0);
}

/** Entry cron: /__cron?job=fbdirect (disarankan tiap 10 menit -> 1 artikel/panggilan). */
export async function fbDirectRun(env: Env): Promise<{ posted: number; message: string }> {
	const cfg = await botCfg(env);
	if (String(cfg.fb_direct_enabled || "0") !== "1") {
		return { posted: 0, message: "Facebook Langsung dimatikan (fb_direct_enabled=0)." };
	}
	const cap = Number(cfg.fb_direct_daily_cap || "50");
	if ((await fbDirectPostedToday(env)) >= cap) {
		return { posted: 0, message: "Batas harian Facebook Langsung tercapai." };
	}
	const r = await fbDirectProcessOne(env);
	if (!r.done) return { posted: 0, message: r.error || "Tidak ada artikel baru untuk diposting." };
	if (r.error) return { posted: 0, message: r.error };
	return { posted: 1, message: `Terposting: ${r.title}` };
}

// ---------------------------------------------------------------------------
// Proses 1 artikel: rewrite -> post -> tandai
// ---------------------------------------------------------------------------
export async function newsProcessOne(
	env: Env,
	opts: { postToBlogger: boolean } = { postToBlogger: true },
): Promise<{ done: boolean; title?: string; postUrl?: string; error?: string; siteOnly?: boolean }> {
	await ensureNewsCategoryColumns(env);
	const cfg = await botCfg(env);
	// RANDOM (bukan FIFO/id ASC) -- pemilik minta artikel yang diproses "diacak",
	// supaya tidak keterusan memproses satu sumber/kategori secara berurutan
	// lama sebelum sempat menyentuh kategori lain di antrean yang sama.
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE status = 'new' ORDER BY RANDOM() LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false };
	const id = Number(row.id);
	// Klaim atomik: loop Blogger & loop situs sendiri jalan berurutan dalam 1
	// invocation (aman), TAPI 2 jadwal cron yang tumpang-tindih (lihat
	// wrangler.jsonc: */5 & tiap menit) bisa saja overlap jadi 2 invocation
	// berbeda -- tanpa klaim ini, keduanya bisa SELECT baris 'new' yang SAMA
	// sebelum salah satu sempat UPDATE status-nya -> artikel yang sama diproses
	// dobel (dobel post Blogger, atau dobel di situs sendiri). UPDATE ... WHERE
	// status='new' ini atomik di level SQLite -- kalau invocation lain sudah
	// lebih dulu mengklaim, changes=0 di sini dan kita mundur dgn aman.
	const claim = await getTurso(env).prepare(`UPDATE news_article SET status='processing' WHERE id=? AND status='new'`).bind(id).run();
	if (!claim.meta.changes) return { done: false };
	try {
		const rw = await geminiRewrite(env, cfg, {
			title: String(row.title),
			excerpt: String(row.excerpt),
			source: String(row.source),
			url: String(row.url),
		});
		let content = rw.html;
		// Kategori otomatis dari AI (klasifikasi isi artikel yang sebenarnya) --
		// menang atas kategori bawaan sumbernya (yang cuma tebakan kasar per-feed).
		// Kalau Gemini tidak balas kategori valid, tetap pakai punya sumber.
		const category = rw.category || String(row.category || "umum");

		// Blok promo (disisipkan setelah paragraf ke-2 kalau bisa, biar natural).
		const promoUrl = (cfg.promo_url || "").trim();
		if (promoUrl) {
			const promoText = (cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim();
			// Tint pakai rgba semi-transparan (BUKAN warna solid #fafafa) supaya kotak ini
			// tetap enak dilihat baik di halaman Blogger (biasanya terang) MAUPUN di
			// artikel Berita Terkini (tema gelap) -- warna solid terang dulu bikin kotak
			// putih mencolok aneh di tengah halaman gelap.
			const promo =
				`\n<div style="border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:14px 16px;margin:20px 0;background:rgba(127,127,127,.08)">` +
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

		// Ajakan follow Fanspage Facebook (kalau sudah diisi di Konfigurasi Lanjutan).
		const fbPageUrl = (cfg.fb_page_url || "").trim();
		if (fbPageUrl) {
			content +=
				`\n<p style="font-size:14px;margin-top:14px">📘 Follow Fanspage kami di Facebook: ` +
				`<a href="${escAttr(fbPageUrl)}" rel="noopener" target="_blank"><strong>klik di sini</strong></a></p>`;
		}
		// Promosi silang ke situs Blogger -- SELALU disisipkan (tidak digate
		// postToBlogger) karena ini juga ikut tayang di artikel Berita Terkini
		// LapakStore88, bukan cuma di postingan Blogger itu sendiri.
		const bloggerSiteUrl = (cfg.blogger_site_url || "").trim();
		if (bloggerSiteUrl) {
			content +=
				`\n<p style="font-size:14px;margin-top:10px">📰 Baca artikel lainnya di blog kami: ` +
				`<a href="${escAttr(bloggerSiteUrl)}" rel="noopener" target="_blank"><strong>kunjungi blog</strong></a></p>`;
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

		// Label: "LapakStore88" (brand sendiri) + kategori otomatis (dari AI) + label
		// tambahan dari config -- SENGAJA TIDAK menyertakan nama sumber berita lagi
		// (mis. "Detik News") sesuai permintaan pemilik, supaya Label Blogger selalu
		// menonjolkan brand sendiri. Atribusi sumber di ISI artikel (paragraf
		// "Sumber: ...") TIDAK diubah -- itu kewajiban hak cipta yang beda urusan.
		const labels = ["LapakStore88", newsCategoryLabel(category)];
		for (const l of String(cfg.post_labels || "").split(",").map((x) => x.trim()).filter(Boolean)) {
			if (!labels.includes(l)) labels.push(l);
		}
		// Blogger (dan Facebook auto-share yang menyertainya) TETAP dibatasi
		// daily_cap milik pemilik akun -- kalau limit sudah tercapai, lewati
		// langkah ini, tapi artikel TETAP disimpan & tersedia di situs sendiri
		// (site_posted_at) lewat cabang else di bawah. Jadi situs sendiri tidak
		// pernah "menunggu jatah" Blogger.
		let postUrl = "";
		if (opts.postToBlogger) {
			postUrl = await bloggerCreatePost(env, cfg, { title: rw.title, content, labels, searchDescription: rw.metaDescription });
			if (String(cfg.fb_enabled || "0") === "1") {
				try {
					await fbPostToPage(cfg, {
						title: rw.title,
						metaDescription: rw.metaDescription,
						postUrl,
						imageUrl,
						siteUrl: `${LAPAKSTORE_SITE_URL}/berita/artikel/?id=${id}`,
						storeUrl: promoUrl || undefined,
					});
				} catch (e) {
					console.error("fbPostToPage gagal:", e instanceof Error ? e.message : e);
				}
			}
		}
		// site_posted_at HANYA diisi untuk artikel yang TIDAK diposting ke Blogger
		// (postUrl kosong) -- pemilik minta 2 kumpulan ini benar-benar terpisah,
		// TIDAK boleh dobel tampil di Blogger maupun situs sendiri sekaligus.
		// image_url DISIMPAN BALIK ke sini (kalau tadinya kosong) -- sebelumnya
		// imageUrl yang sudah ketemu (dari RSS atau fetchOgImage) cuma dipakai
		// sesaat utk konten Blogger, tidak pernah ditulis ke kolomnya sendiri.
		// Akibatnya proses LAIN yang baca ulang artikel yang sama nanti (mis.
		// Template FB) melihat image_url kosong lagi & harus coba cari ulang dari
		// nol -- padahal sudah pernah ketemu sebelumnya.
		const now = tsNow();
		await getTurso(env)
			.prepare(
				`UPDATE news_article SET status=?, rewritten_html=?, post_url=?, posted_at=?, site_posted_at=?, category=?, image_url=CASE WHEN image_url='' THEN ? ELSE image_url END, error='' WHERE id=?`,
			)
			.bind(postUrl ? "posted" : "site", content, postUrl, postUrl ? now : "", postUrl ? "" : now, category, imageUrl, id)
			.run();

		return { done: true, title: rw.title, postUrl: postUrl || undefined, siteOnly: !postUrl };
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
	opts: { force?: boolean; count?: number; mode?: "both" | "blogger" | "site" } = {},
): Promise<{ pulled: number; posted: number; siteOnly: number; capped: boolean; message: string }> {
	const mode = opts.mode || "both";
	const cfg = await botCfg(env);
	if (!opts.force && String(cfg.enabled || "0") !== "1") {
		return { pulled: 0, posted: 0, siteOnly: 0, capped: false, message: "BOT NEWS dimatikan (enabled=0)." };
	}
	const countOverride = opts.count ? Math.max(1, Math.min(MAX_RUN_COUNT, Math.floor(opts.count))) : 0;
	const perRun = mode === "site" ? 0 : countOverride || Math.max(1, Number(cfg.per_run || "2"));
	// Pace KHUSUS situs sendiri (LapakStore88) -- SENGAJA terpisah total dari
	// per_run/daily_cap Blogger di atas. PENTING: pakai "||" bukan "??" -- kalau
	// field ini pernah tersimpan sebagai string kosong (mis. form disimpan tanpa
	// diisi), "" ?? "5" tetap "" (cuma null/undefined yg ke-catch "??"), lalu
	// Number("")=0 -> loop situs mati total tanpa pesan error apa pun. "||" aman
	// dari kasus itu, dan tetap menghormati "0" eksplisit (mematikan loop situs).
	let sitePerRun = mode === "blogger" ? 0 : countOverride || Math.max(0, Number(cfg.site_per_run || "5"));
	// PENTING: kalau mode="both" (ini yang dipanggil cron eksternal otomatis),
	// loop Blogger & situs jalan dalam 1 INVOCATION yang SAMA -> subrequest-nya
	// NUMPUK (tiap artikel Blogger ~6-9 subrequest: Gemini+Blogger+FB+Turso;
	// situs ~3-4). Cloudflare Free cuma 50 subrequest/invocation, dan begitu
	// kelewat, SELURUH invocation mati mendadak (exception tidak tertangkap
	// try/catch manapun) -- bukan cuma loop situs yang gagal, Blogger yang
	// sudah jalan duluan pun ikut tidak sempat tersimpan. Makanya cron
	// otomatis "kelihatan cuma posting Blogger" (kadang malah dua²nya gagal
	// diam²): total gabungan kelewat limit. Klik manual TIDAK kena batas ini
	// (mode="site"/"blogger" sendiri-sendiri, tidak ada loop lain yang numpuk
	// di invocation yang sama).
	if (mode === "both") {
		// 6 ternyata masih kena "Too many subrequests" sesekali (tiap artikel Blogger
		// bisa sampai ~4 subrequest CUMA utk retry beberapa model Gemini kalau satu
		// model gagal, belum lagi Blogger+FB+Turso) -- turun ke angka yang jauh lebih
		// konservatif. Klik manual "PROSES KE SITUS SENDIRI" TIDAK kena batas ini
		// (invocation sendiri, tidak numpuk dgn loop Blogger), jadi tetap jadi cara
		// utama isi banyak sekaligus; otomatis cukup nyicil pasti-jalan tiap tick.
		const SAFE_COMBINED_BUDGET = 4;
		sitePerRun = Math.max(0, Math.min(sitePerRun, SAFE_COMBINED_BUDGET - perRun));
	}

	// Coba pull+proses dalam 1 invocation ternyata TETAP kelewat limit 50
	// subrequest walau sudah dikecilkan -- perkiraan biaya per artikel di
	// kondisi geo-block Gemini (retry beberapa model, masing² 1 subrequest)
	// ternyata lebih mahal dari perkiraan. Daripada tebak-tebak angka lagi,
	// PISAH TOTAL: pull TIDAK PERNAH jalan inline di sini lagi -- jalankan
	// lewat job KHUSUS (/__cron?job=pullnews) yang isinya CUMA
	// newsPullSources tanpa proses apa pun sesudahnya (aman sendiri, ~10
	// subrequest), dipanggil cron eksternal terpisah dari job=news.
	const pull = { added: 0, scanned: 0 };

	const cap = Number(cfg.daily_cap || "8");
	// Query 1x, lalu update di memori -> bukan 1 query/iterasi (hemat subrequest).
	let postedSoFar = await postedToday(env);
	let posted = 0;
	let lastError = "";
	// ---- Loop 1: BLOGGER -- pace & limit persis seperti yang sudah disetel pemilik, TIDAK diubah. ----
	for (let i = 0; i < perRun; i++) {
		if (postedSoFar >= cap) break; // Blogger capped -> loop Blogger cukup di sini, bukan urusan loop situs di bawah.
		const r = await newsProcessOne(env, { postToBlogger: true });
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
	// ---- Loop 2: SITUS SENDIRI -- 100% terpisah, postToBlogger SELALU false di
	// sini (tidak pernah coba posting Blogger sama sekali), pace-nya cuma dari
	// site_per_run. Berjalan tiap tick TERLEPAS dari status cap Blogger di atas. ----
	let siteOnly = 0;
	for (let i = 0; i < sitePerRun; i++) {
		const r = await newsProcessOne(env, { postToBlogger: false });
		if (!r.done) break; // tidak ada artikel 'new' lagi
		if (r.siteOnly) siteOnly++;
		if (r.error) lastError = r.error;
		if (r.error && /location is not supported|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(r.error)) break;
	}
	const capped = postedSoFar >= cap;
	const parts: string[] = [`Feed +${pull.added} artikel baru`];
	if (mode !== "site") parts.push(`diposting ${posted} ke Blogger`);
	if (mode !== "blogger") parts.push(`${siteOnly} ke situs sendiri`);
	return {
		pulled: pull.added,
		posted,
		siteOnly,
		capped,
		// Kalau 0 posting & ada error, tampilkan alasannya -- biar user/kita tidak
		// perlu buka database tiap kali cuma buat tahu KENAPA 0.
		message: parts.join("; ") + "." + (posted === 0 && siteOnly === 0 && lastError ? ` [${lastError.slice(0, 200)}]` : ""),
	};
}

// ---------------------------------------------------------------------------
// Untuk panel (API)
// ---------------------------------------------------------------------------
export async function botNewsSnapshot(env: Env) {
	await ensureNewsCategoryColumns(env);
	const cfg = await botCfg(env);
	const sources =
		(await getTurso(env).prepare(`SELECT id, name, kind, url, active, category FROM news_source ORDER BY id`).all()).results ?? [];
	const counts =
		(await getTurso(env).prepare(`SELECT status, COUNT(*) AS c FROM news_article GROUP BY status`).all<{ status: string; c: number }>())
			.results ?? [];
	const recent =
		(await getTurso(env)
			.prepare(`SELECT id, source, title, status, url, post_url, error, found_at, posted_at FROM news_article ORDER BY id DESC LIMIT 40`)
			.all()).results ?? [];
	await ensureFbTemplateColumn(env);
	const fbDirectHistory =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, post_url, image_url, fb_direct_posted_at, fb_template_caption
				 FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error')
				 ORDER BY fb_direct_posted_at DESC, id DESC LIMIT 100`,
			)
			.all()).results ?? [];
	const history =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, post_url, posted_at
				 FROM news_article WHERE status='posted' ORDER BY posted_at DESC, id DESC LIMIT 200`,
			)
			.all()).results ?? [];
	// Riwayat KHUSUS situs sendiri -- terpisah total dari history Blogger di atas
	// (lihat newsProcessOne: site_posted_at cuma keisi kalau TIDAK diposting ke
	// Blogger, jadi tidak ada baris yang muncul di kedua riwayat sekaligus).
	const siteHistory =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, category, site_posted_at
				 FROM news_article WHERE site_posted_at != '' ORDER BY site_posted_at DESC, id DESC LIMIT 200`,
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
			site_per_run: Number(cfg.site_per_run || "5"),
			attribution: String(cfg.attribution || "1") === "1",
			rewrite_style: cfg.rewrite_style || "",
			para_min: Number(cfg.para_min || "8"),
			para_max: Number(cfg.para_max || "14"),
			promo_url: cfg.promo_url || "",
			promo_text: cfg.promo_text || "",
			post_labels: cfg.post_labels || "",
			gemini_model: cfg.gemini_model || "gemini-flash-latest",
			has_gemini_key: !!cfg.gemini_key,
			has_blogger: !!(cfg.blogger_refresh_token && cfg.blogger_blog_id),
			blog_id: cfg.blogger_blog_id || "",
			blogger_site_url: cfg.blogger_site_url || "",
			fb_enabled: String(cfg.fb_enabled || "0") === "1",
			fb_page_id: cfg.fb_page_id || "",
			has_facebook: !!(cfg.fb_page_id && cfg.fb_page_token),
			fb_direct_enabled: String(cfg.fb_direct_enabled || "0") === "1",
			fb_direct_daily_cap: Number(cfg.fb_direct_daily_cap || "50"),
			fb_page_url: cfg.fb_page_url || "",
			news_banner_enabled: String(cfg.news_banner_enabled || "0") === "1",
			news_banner_image: cfg.news_banner_image || "",
			news_banner_url: cfg.news_banner_url || "",
			news_banner_text: cfg.news_banner_text || "",
		},
		postedToday: await postedToday(env),
		fbDirectPostedToday: await fbDirectPostedToday(env),
		fbDirectQueue: Number(
			(await getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at = ''`).first<{ c: number }>())?.c ?? 0,
		),
		byStatus,
		sources,
		recent,
		history,
		siteHistory,
		fbDirectHistory,
	};
}

// ---------------------------------------------------------------------------
// Untuk situs publik (LapakStore88 "Berita Terkini") — TANPA sesi/auth. Filter
// pakai site_posted_at (BUKAN status='posted') karena situs sendiri sengaja
// TIDAK dibatasi daily_cap Blogger -- artikel bisa "site_posted_at" terisi
// (status='site') meski belum/tidak pernah diposting ke Blogger. Tetap tidak
// pernah menampilkan artikel 'new'/'error' yang isinya masih mentah/gagal.
// ---------------------------------------------------------------------------
export async function publicNewsList(env: Env, category: string, page: number, pageSize: number) {
	await ensureNewsCategoryColumns(env);
	const size = Math.min(30, Math.max(1, pageSize || 20));
	const offset = Math.max(0, (Math.max(1, page || 1) - 1) * size);
	const cat = category && (NEWS_CATEGORIES as readonly string[]).includes(category) ? category : "";
	const where = cat ? `WHERE site_posted_at != '' AND category=?` : `WHERE site_posted_at != ''`;
	const args = cat ? [cat] : [];
	const rows =
		(
			await getTurso(env)
				.prepare(
					`SELECT id, title, excerpt, image_url, category, source, site_posted_at AS posted_at FROM news_article ${where} ORDER BY site_posted_at DESC, id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...args, size, offset)
				.all<{ id: number; title: string; excerpt: string; image_url: string; category: string; source: string; posted_at: string }>()
		).results ?? [];
	const total = Number(
		(await getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article ${where}`).bind(...args).first<{ c: number }>())?.c ?? 0,
	);
	return { success: true, articles: rows, total, page: Math.max(1, page || 1), pageSize: size, categories: NEWS_CATEGORIES };
}

export async function publicNewsDetail(env: Env, id: number) {
	await ensureNewsCategoryColumns(env);
	const row = await getTurso(env)
		.prepare(`SELECT id, title, rewritten_html, image_url, category, source, url, site_posted_at AS posted_at FROM news_article WHERE id=? AND site_posted_at != ''`)
		.bind(id)
		.first<{ id: number; title: string; rewritten_html: string; image_url: string; category: string; source: string; url: string; posted_at: string }>();
	if (!row) return { success: false, message: "Artikel tidak ditemukan." };
	return { success: true, article: row };
}

/** Suntik sumber RSS per-kategori Liputan6 sekali jalan (dipanggil dari /__cron?job=seednews,
 * gate cron-key BUKAN sesi -- pemilik tidak perlu ketik 8 baris manual di panel).
 * Idempotent: kalau URL sudah ada di news_source, dilewati (tidak dobel). */
export async function seedCategorySources(env: Env): Promise<{ added: string[]; skipped: string[] }> {
	await ensureNewsCategoryColumns(env);
	const seeds: { name: string; url: string; category: string }[] = [
		{ name: "Liputan6 Bisnis", url: "https://feed.liputan6.com/rss/bisnis", category: "bisnis" },
		{ name: "Liputan6 Bola", url: "https://feed.liputan6.com/rss/bola", category: "bola" },
		{ name: "Liputan6 Showbiz", url: "https://feed.liputan6.com/rss/showbiz", category: "hiburan" },
		{ name: "Liputan6 Tekno", url: "https://feed.liputan6.com/rss/tekno", category: "teknologi" },
		{ name: "Liputan6 Otomotif", url: "https://feed.liputan6.com/rss/otomotif", category: "otomotif" },
		{ name: "Liputan6 Kesehatan", url: "https://feed.liputan6.com/rss/kesehatan", category: "kesehatan" },
		{ name: "Liputan6 Lifestyle", url: "https://feed.liputan6.com/rss/lifestyle", category: "lifestyle" },
		{ name: "Liputan6 Cek Fakta", url: "https://feed.liputan6.com/rss/cek-fakta", category: "umum" },
		// Detik per-channel -- supaya tiap kategori punya LEBIH DARI 1 sumber
		// (bukan cuma Liputan6), volumenya jadi jauh lebih banyak per kategori.
		{ name: "Detik Finance", url: "https://finance.detik.com/rss", category: "bisnis" },
		{ name: "Detik Sepakbola", url: "https://sport.detik.com/sepakbola/rss", category: "bola" },
		{ name: "Detik Sport", url: "https://sport.detik.com/rss", category: "olahraga" },
		{ name: "Detik Hot", url: "https://hot.detik.com/rss", category: "hiburan" },
		{ name: "Detik Inet", url: "https://inet.detik.com/rss", category: "teknologi" },
		{ name: "Detik Oto", url: "https://oto.detik.com/rss", category: "otomotif" },
		{ name: "Detik Health", url: "https://health.detik.com/rss", category: "kesehatan" },
		{ name: "Detik Wolipop", url: "https://wolipop.detik.com/rss", category: "lifestyle" },
		{ name: "Detik Travel", url: "https://travel.detik.com/rss", category: "lifestyle" },
		{ name: "Liputan6 Selebritis", url: "https://feed.liputan6.com/rss/showbiz/celeb", category: "selebritis" },
	];
	const added: string[] = [];
	const skipped: string[] = [];
	for (const s of seeds) {
		const exists = await getTurso(env).prepare(`SELECT id FROM news_source WHERE url = ?`).bind(s.url).first();
		if (exists) {
			skipped.push(s.name);
			continue;
		}
		await getTurso(env)
			.prepare(`INSERT INTO news_source (name, kind, url, active, added_at, category) VALUES (?, 'rss', ?, 1, ?, ?)`)
			.bind(s.name, s.url, tsNow(), s.category)
			.run();
		added.push(s.name);
	}
	return { added, skipped };
}

/** One-shot: matikan sumber "gnews" (Kompas via Google News) -- Google mengubah
 * halaman redirect artikelnya jadi full client-side JS (dikonfirmasi manual: HTML
 * mentahnya 0 <a href>, 0 kata "kompas.com"), jadi resolveGnews/fetchOgImage tidak
 * akan pernah dapat URL/gambar asli lagi. Pemilik pilih matikan sumbernya saja
 * daripada membangun scraper ke API privat Google (yang dilarang di ToS RSS-nya). */
export async function disableGnewsSources(env: Env): Promise<{ disabled: string[] }> {
	// Cocokkan lewat kind='gnews' ATAU nama mengandung "ompas" -- source Kompas
	// ternyata bisa saja terdaftar kind='rss' langsung ke URL search Google News
	// (bukan lewat kind='gnews'+resolveGnews), jadi jangan cuma andalkan kind.
	const rows =
		(
			await getTurso(env)
				.prepare(`SELECT id, name FROM news_source WHERE active = 1 AND (kind = 'gnews' OR name LIKE '%ompas%' OR url LIKE '%kompas%')`)
				.all<{ id: number; name: string }>()
		).results ?? [];
	const disabled: string[] = [];
	for (const r of rows) {
		await getTurso(env).prepare(`UPDATE news_source SET active = 0 WHERE id = ?`).bind(r.id).run();
		disabled.push(r.name);
	}
	return { disabled };
}

/** Banner promosi sidebar Berita Terkini -- diatur dari Panel BOT (Konfigurasi Lanjutan). */
export async function publicNewsBanner(env: Env) {
	const cfg = await botCfg(env);
	if (String(cfg.news_banner_enabled || "0") !== "1" || !cfg.news_banner_image) return { success: true, banner: null };
	return {
		success: true,
		banner: { image: cfg.news_banner_image, url: cfg.news_banner_url || "", text: cfg.news_banner_text || "" },
	};
}

/** Beberapa artikel acak (utk widget "Arsip Berita" sidebar) -- kalau category dikirim, hanya dari kategori itu. */
export async function publicNewsRandom(env: Env, category: string, limit: number) {
	await ensureNewsCategoryColumns(env);
	const n = Math.min(20, Math.max(1, limit || 6));
	const cat = category && (NEWS_CATEGORIES as readonly string[]).includes(category) ? category : "";
	const where = cat ? `WHERE site_posted_at != '' AND category=?` : `WHERE site_posted_at != ''`;
	const args = cat ? [cat] : [];
	const rows =
		(
			await getTurso(env)
				.prepare(`SELECT id, title, image_url, category FROM news_article ${where} ORDER BY RANDOM() LIMIT ?`)
				.bind(...args, n)
				.all<{ id: number; title: string; image_url: string; category: string }>()
		).results ?? [];
	return { success: true, articles: rows };
}
