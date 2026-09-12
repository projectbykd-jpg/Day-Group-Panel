// Day-Group Panel — Cloudflare Worker (port dari Apps Script).
// Semua panggilan frontend lama google.script.run.<fn>(...) dipetakan ke
// POST /api  body: { "action": "<fn>", ...args }
import { CORS_HEADERS, json } from "./lib/respond";
import { loadSession, migrateKvSessionsOnce, pruneExpiredSessions } from "./lib/session";
import { getTurso } from "./lib/turso";
import { checkLogin, logout, resumeSession } from "./api/auth";
import { getBootstrapData, getDashboard } from "./api/dashboard";
import { logClientActivity } from "./api/activity";
import { retryFailedSystem, sendToPanelZOnly, smartAutoSendFast } from "./api/send";
import {
	adminDeleteUser,
	adminListActiveSessions,
	adminListUsers,
	adminPruneActivityLog,
	adminResetUserLock,
	adminSaveUser,
	adminSetAutoPost,
	adminSetLogRetention,
	pruneActivityLogCron,
} from "./api/admin";
import { adminDeleteSite, adminListSites, adminSaveSite } from "./api/sites";
import { setMaintenance } from "./api/settings";
import { getCurrentUserProfile, getLivePanelData } from "./api/live";
import {
	adminGetAutoPostWebhook,
	adminRunAutoPostNow,
	generateClosingPredictionCopy,
	generatePredictionCopyBundle,
	getPredictionStatusData,
	runAutoPostRouter,
	sendClosingPredictionAuto,
	sendPredictionAuto,
	setupAutoPostTriggers,
} from "./api/prediction";
import {
	investContinueScan,
	investGetConfig,
	investGetStatus,
	investGetWarnings,
	investResetScan,
	investSaveConfig,
	investStartScan,
	investTestSession,
} from "./api/invest";
import { investPump, investPumpUser } from "./lib/invest-scan";
import {
	lapAdminStatus,
	lapGetConfig,
	lapJobResult,
	lapJobStart,
	lapMozartImport,
	lapRunAdmin,
	lapRunMotion,
	lapRunMozart,
	lapSaveConfig,
} from "./api/lap";
import {
	botFbRunNow,
	botFbTemplateGenerate,
	botNewsAddSource,
	botNewsDeleteSource,
	botNewsRunNow,
	botNewsRunSiteNow,
	botNewsSaveConfig,
	botNewsSkip,
	botNewsStatus,
	botNewsToggleSource,
} from "./api/bot";
import { botNewsRun, disableGnewsSources, fbDirectRun, newsPullSources, publicNewsBanner, publicNewsDetail, publicNewsList, publicNewsRandom, seedCategorySources } from "./lib/bot-news";

type Handler = (env: Env, body: Record<string, unknown>) => Promise<unknown>;
const s = (v: unknown) => String(v ?? "");

// Pangkas Activity Log sekali per hari WIB (dikunci lewat KV).
// Pangkas Activity Log sekali per hari WIB (dikunci lewat KV).
async function dailyPrune(env: Env): Promise<number | "skip"> {
	await migrateKvSessionsOnce(env);
	const dayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
	const guard = "retention:" + dayKey;
	try {
		if (await env.SESS.get(guard)) return "skip";
		await env.SESS.put(guard, "1", { expirationTtl: 172800 });
	} catch {
		/* lanjut */
	}
	await pruneExpiredSessions(env).catch(() => {});
	return pruneActivityLogCron(env).catch(() => 0);
}

const ROUTES: Record<string, Handler> = {
	// auth
	checkLogin: (env, b) => checkLogin(env, s(b.username), s(b.password)),
	resumeSession: (env, b) => resumeSession(env, s(b.token)),
	logout: (env, b) => logout(env, s(b.token)),
	logoutSession: (env, b) => logout(env, s(b.token)),

	// dashboard / activity
	getBootstrapData: (env, b) => getBootstrapData(env, s(b.token)),
	getDashboardData: (env, b) => getDashboard(env, s(b.token), b.options ?? b.request),
	logClientActivity: (env, b) =>
		logClientActivity(env, s(b.token), s(b.action_name ?? b.act), s(b.detail), s(b.status), s(b.content)),

	// kirim result
	smartAutoSendFast: (env, b) => smartAutoSendFast(env, s(b.token), s(b.rawText)),
	retryFailedSystem: (env, b) =>
		retryFailedSystem(env, s(b.token), s(b.rawText), s(b.systemName), b.website ? s(b.website) : undefined),
	sendToPanelZOnly: (env, b) => sendToPanelZOnly(env, s(b.token), s(b.market), s(b.angka)),

	// live / profil
	getLivePanelData: (env, b) =>
		getLivePanelData(env, s(b.token), (b.opts ?? {}) as { activity?: unknown; sessions?: boolean }),
	getCurrentUserProfile: (env, b) => getCurrentUserProfile(env, s(b.token)),

	// admin
	adminListUsers: (env, b) => adminListUsers(env, s(b.token)),
	adminSaveUser: (env, b) => adminSaveUser(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	adminDeleteUser: (env, b) => adminDeleteUser(env, s(b.token), s(b.targetUsername)),
	adminResetUserLock: (env, b) => adminResetUserLock(env, s(b.token), s(b.targetUsername)),
	adminListActiveSessions: (env, b) => adminListActiveSessions(env, s(b.token)),
	setMaintenance: (env, b) => setMaintenance(env, s(b.token), !!b.enabled, s(b.message)),

	// kelola website (site_accounts)
	adminListSites: (env, b) => adminListSites(env, s(b.token)),
	adminSaveSite: (env, b) => adminSaveSite(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	adminDeleteSite: (env, b) => adminDeleteSite(env, s(b.token), s(b.website)),

	// prediksi
	getPredictionStatusData: (env, b) => getPredictionStatusData(env, s(b.token)),
	generatePredictionCopyBundle: (env, b) => generatePredictionCopyBundle(env, Number(b.index), s(b.token)),
	generateClosingPredictionCopy: (env, b) => generateClosingPredictionCopy(env, s(b.token), s(b.slot)),
	sendPredictionAuto: (env, b) =>
		sendPredictionAuto(env, Number(b.index), s(b.token), Array.isArray(b.websites) ? (b.websites as string[]) : undefined),
	sendClosingPredictionAuto: (env, b) =>
		sendClosingPredictionAuto(
			env,
			s(b.token),
			Array.isArray(b.websites) ? (b.websites as string[]) : undefined,
			s(b.slot),
		),
	adminRunAutoPostNow: (env, b) => adminRunAutoPostNow(env, s(b.token)),
	setupAutoPostTriggers: (env, b) => setupAutoPostTriggers(env, s(b.token)),
	adminGetAutoPostWebhook: (env, b) => adminGetAutoPostWebhook(env, s(b.token), s(b.__origin)),
	adminSetAutoPost: (env, b) => adminSetAutoPost(env, s(b.token), !!b.enabled),

	// retensi activity log (nama lama frontend: "backup")
	adminRunActivityBackup: (env, b) => adminPruneActivityLog(env, s(b.token)),
	setupActivityBackupTrigger: (env, b) => adminSetLogRetention(env, s(b.token)),

	// invest
	investGetConfig: (env, b) => investGetConfig(env, s(b.token)),
	investSaveConfig: (env, b) => investSaveConfig(env, s(b.token), (b.payload ?? {}) as Record<string, unknown>),
	investTestSession: (env, b) => investTestSession(env, s(b.token)),
	investStartScan: (env, b) => investStartScan(env, s(b.token)),
	investContinueScan: (env, b) => investContinueScan(env, s(b.token)),
	investResetScan: (env, b) => investResetScan(env, s(b.token)),
	investGetStatus: (env, b) => investGetStatus(env, s(b.token)),
	investGetWarnings: (env, b) => investGetWarnings(env, s(b.token)),

	// laporan harian
	lapGetConfig: (env, b) => lapGetConfig(env, s(b.token)),
	lapSaveConfig: (env, b) => lapSaveConfig(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	lapRunMotion: (env, b) => lapRunMotion(env, s(b.token), s(b.startDate), s(b.endDate)),
	lapRunMozart: (env, b) =>
		lapRunMozart(env, s(b.token), s(b.startDate), s(b.endDate), (b.opts ?? {}) as { depo?: boolean; wd?: boolean; panelId?: number }),
	lapRunAdmin: (env, b) => lapRunAdmin(env, s(b.token), s(b.startDate), s(b.endDate)),
	lapMozartImport: (env, b) =>
		lapMozartImport(
			env,
			s(b.token),
			s(b.startDate),
			s(b.endDate),
			(b.depositRows ?? []) as unknown[],
			(b.withdrawRows ?? []) as unknown[],
			b.accountsRaw ?? [],
			b.panelsRaw ?? [],
		),
	lapAdminStatus: (env, b) => lapAdminStatus(env, s(b.token), s(b.jobId)),

	// role BOT — modul NEWS
	botNewsStatus: (env, b) => botNewsStatus(env, s(b.token)),
	botNewsSaveConfig: (env, b) => botNewsSaveConfig(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsAddSource: (env, b) => botNewsAddSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsToggleSource: (env, b) => botNewsToggleSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsDeleteSource: (env, b) => botNewsDeleteSource(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),
	botNewsRunNow: (env, b) => botNewsRunNow(env, s(b.token), b.count != null ? Number(b.count) : undefined),
	botNewsRunSiteNow: (env, b) => botNewsRunSiteNow(env, s(b.token), b.count != null ? Number(b.count) : undefined),
	botFbRunNow: (env, b) => botFbRunNow(env, s(b.token)),
	botFbTemplateGenerate: (env, b) => botFbTemplateGenerate(env, s(b.token)),
	botNewsSkip: (env, b) => botNewsSkip(env, s(b.token), (b.data ?? {}) as Record<string, unknown>),

	// dipanggil GitHub Actions (auth via job key, bukan sesi)
	lapJobStart: (env, b) => lapJobStart(env, s(b.jobId), s(b.key)),
	lapJobResult: (env, b) =>
		lapJobResult(
			env,
			s(b.jobId),
			s(b.key),
			!!b.ok,
			(b.data ?? {}) as Record<string, unknown[]>,
			(b.errors ?? {}) as Record<string, string>,
		),
};

// Aksi Invest yang memicu pump di latar belakang (ctx.waitUntil) — supaya scan
// langsung bergerak begitu user klik MULAI/LANJUTKAN dan terus maju selama user
// membuka halaman (polling investGetStatus), tanpa menunggu cron eksternal.
const INVEST_PUMP_ACTIONS = new Set(["investStartScan", "investContinueScan", "investGetStatus"]);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS" && url.pathname === "/api") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method === "POST" && url.pathname === "/api") {
			let body: Record<string, unknown> = {};
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return json({ success: false, message: "Body JSON tidak valid." }, 400);
			}
			body.__origin = url.origin;
			const action = s(body.action);
			const handler = ROUTES[action];
			if (!handler) return json({ success: false, message: "Aksi tidak dikenal: " + action }, 404);
			try {
				const out = await handler(env, body);
				if (INVEST_PUMP_ACTIONS.has(action)) {
					// Pump scan user INI di latar belakang (lock per-user) -> scan-nya
					// jalan sendiri, tidak antre di belakang user lain.
					ctx.waitUntil(
						(async () => {
							const rec = await loadSession(env, s(body.token));
							if (rec?.username) await investPumpUser(env, rec.username);
						})().catch((e) => console.error("invest pump (waitUntil) error", e)),
					);
				}
				return json(out);
			} catch (e) {
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		if (url.pathname === "/health") {
			return new Response("panel-worker OK", { headers: { "content-type": "text/plain" } });
		}

		// Proxy gambar (dipakai tombol "Copy Gambar" di BOT · Template FB): banyak
		// gambar berita punya hotlink-protection / CORS ketat sehingga tidak bisa
		// di-fetch langsung dari browser untuk disalin ke clipboard. Worker ambil
		// dulu di sisi server (bebas CORS), lalu diteruskan sebagai same-origin.
		if (url.pathname === "/img") {
			const target = url.searchParams.get("url") || "";
			if (!/^https?:\/\//i.test(target)) return json({ success: false, message: "url tidak valid" }, 400);
			// Banyak situs berita menolak User-Agent "bot" walau cuma diakses server-side
			// (bukan soal CORS -- itu aturan browser, tidak berlaku fetch server-to-server
			// ini) -- pura-pura jadi browser biasa + kirim Referer dari domain gambar itu
			// sendiri (anti-hotlink umumnya cuma cek Referer kosong/beda domain).
			let targetOrigin = "";
			try {
				targetOrigin = new URL(target).origin;
			} catch {
				return json({ success: false, message: "url tidak valid" }, 400);
			}
			try {
				const r = await fetch(target, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
						Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
						Referer: targetOrigin + "/",
					},
				});
				const ct = r.headers.get("content-type") || "";
				if (!r.ok || !r.body || !ct.startsWith("image/")) {
					// Fetch server-side gagal (kena blokir situs asal) -> lempar browser
					// pengguna buka LANGSUNG ke gambar aslinya (koneksi asli user kadang
					// tidak kena blokir yang sama seperti IP Cloudflare Worker).
					return Response.redirect(target, 302);
				}
				return new Response(r.body, { headers: { "content-type": ct, "cache-control": "public, max-age=3600", ...CORS_HEADERS } });
			} catch {
				return Response.redirect(target, 302);
			}
		}

		// Endpoint PUBLIK (tanpa sesi) untuk situs "Berita Terkini" di LapakStore88 --
		// cuma baca (read-only), cuma artikel status='posted' yang pernah dikembalikan
		// (lihat publicNewsList/publicNewsDetail di lib/bot-news.ts). CORS dibuka lebar
		// karena memang dikonsumsi dari origin lain (lokalstore88.online, GitHub Pages).
		if (url.pathname === "/public/news") {
			try {
				const category = url.searchParams.get("category") || "";
				if (url.searchParams.get("banner")) {
					return json(await publicNewsBanner(env), 200);
				}
				if (url.searchParams.get("random")) {
					const limit = parseInt(url.searchParams.get("limit") || "6", 10);
					return json(await publicNewsRandom(env, category, limit), 200);
				}
				const idParam = url.searchParams.get("id");
				if (idParam) {
					const out = await publicNewsDetail(env, Number(idParam));
					return json(out, out.success ? 200 : 404);
				}
				const page = parseInt(url.searchParams.get("page") || "1", 10);
				const pageSize = parseInt(url.searchParams.get("pageSize") || "20", 10);
				const out = await publicNewsList(env, category, page, pageSize);
				return json(out, 200);
			} catch (e) {
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Endpoint cron eksternal (fallback kalau Cron Trigger Cloudflare tidak jalan).
		// Panggil tiap menit dari cron-job.org / GitHub Actions / UptimeRobot:
		//   https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=all
		if (url.pathname === "/__cron") {
			if (!env.CRON_KEY || url.searchParams.get("key") !== env.CRON_KEY) {
				return json({ ok: false, message: "unauthorized" }, 401);
			}
			const job = url.searchParams.get("job") || "all";

			// Cek koneksi Turso: /__cron?key=...&job=tursoping
			if (job === "tursoping") {
				try {
					const t0 = Date.now();
					const r = await getTurso(env).prepare(`SELECT COUNT(*) AS n FROM invest_config`).first<{ n: number }>();
					const r2 = await getTurso(env).prepare(`SELECT COUNT(*) AS n FROM lap_result`).first<{ n: number }>();
					return json({ ok: true, ms: Date.now() - t0, invest_config: r?.n ?? null, lap_result: r2?.n ?? null });
				} catch (e) {
					return json({ ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, 500);
				}
			}

			// Diagnosa sementara: /__cron?key=...&job=debug&user=<username>&path=<path>
			//   atau inline: &base=<url>&cookie=<PHPSESSID=...>
			if (job === "debug") {
				let baseUrl = url.searchParams.get("base") || "";
				let cookie = url.searchParams.get("cookie") || "";
				if (!baseUrl || !cookie) {
					const dbgUser = url.searchParams.get("user") || "Admin";
					const cfgRow = await getTurso(env).prepare(
						`SELECT base_url, phpsessid, koderedis, cookie_extra FROM invest_config WHERE username = ?`,
					)
						.bind(dbgUser)
						.first<Record<string, string>>();
					if (!cfgRow) return json({ ok: false, message: "no invest_config for " + dbgUser });
					baseUrl = String(cfgRow.base_url || "");
					cookie = cfgRow.cookie_extra
						? cfgRow.cookie_extra
						: "PHPSESSID=" + cfgRow.phpsessid + (cfgRow.koderedis ? "; koderedis=" + cfgRow.koderedis : "");
				}
				baseUrl = baseUrl.split("#")[0].split("?")[0];
				if (!baseUrl.endsWith("/")) baseUrl += "/";
				const paths = (url.searchParams.get("path") || "admin_invoice13.php?psr=p33190").split("|");
				const results: unknown[] = [];
				for (const p of paths) {
					try {
						const r = await fetch(baseUrl + p, {
							headers: {
								Cookie: cookie,
								"User-Agent":
									"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
							},
							redirect: "manual",
						});
						const body = await r.text();
						const trCount = (body.match(/<tr[\s>]/gi) || []).length;
						const pageNums = (body.match(/[?&]page=(\d+)/g) || []).map((x) => parseInt(x.split("=")[1], 10));
						const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
						results.push({
							url: baseUrl + p,
							status: r.status,
							location: r.headers.get("location"),
							len: body.length,
							trCount,
							maxPage,
							loginPage: /entered_login|vb_login_md5password|silakan login|please login/i.test(body),
							hasPeriode: /name=["']?periode["']?[^>]*value=["'](\d+)["']/i.test(body),
							snippet: (() => {
								const find = url.searchParams.get("find");
								if (find) {
									const i = body.toLowerCase().indexOf(find.toLowerCase());
									return i < 0 ? "[not found: " + find + "]" : body.slice(Math.max(0, i - 200), i + 1400);
								}
								return url.searchParams.get("full") ? body.slice(0, 4000) : body.slice(0, 300);
							})(),
						});
					} catch (e) {
						results.push({ url: baseUrl + p, error: e instanceof Error ? e.message : String(e) });
					}
				}
				return json({ ok: true, baseUrl, cookiePreview: cookie.slice(0, 20) + "…", results });
			}

			const out: Record<string, unknown> = { ok: true, job, ts: Date.now() };
			try {
				if (job === "autopost" || job === "all") {
					out.autopost = await runAutoPostRouter(env);
					out.pruned = await dailyPrune(env);
				}
				if (job === "invest" || job === "all") {
					await investPump(env);
					out.invest = "pumped";
				}
				if (job === "news" || job === "all") {
					out.news = await botNewsRun(env);
				}
				// Job KHUSUS tarik RSS -- SENGAJA TIDAK ikut "all"/"news" lagi (lihat
				// komentar di botNewsRun): gabung pull+proses dalam 1 invocation kena
				// "Too many subrequests" berulang kali. Dipanggil cron eksternal
				// TERPISAH (mis. tiap 10-15 menit), aman sendiri (~10 subrequest).
				if (job === "pullnews") {
					out.pull = await newsPullSources(env);
				}
				// Job TERPISAH sengaja TIDAK ikut "all" -- dipanggil cron sendiri tiap
				// 10 menit (1 artikel/panggilan), independen dari jadwal Blogger.
				if (job === "fbdirect") {
					out.fbdirect = await fbDirectRun(env);
				}
				// One-shot: suntik 8 sumber RSS per-kategori Liputan6. Idempotent (aman
				// dipanggil berkali²) -- TIDAK ikut "all", dipanggil manual sekali saja.
				if (job === "seednews") {
					out.seed = await seedCategorySources(env);
				}
				if (job === "disablegnews") {
					out.disabled = await disableGnewsSources(env);
				}
				// One-shot: sumber Liputan6 Bola sempat disuntik dgn category='olahraga'
				// sebelum "bola" jadi kategori tersendiri -- perbaiki jadi 'bola'.
				if (job === "fixbolacat") {
					const r = await getTurso(env).prepare(`UPDATE news_source SET category='bola' WHERE url LIKE '%rss/bola%'`).run();
					out.fixed = r.meta.changes;
				}
				// Diagnosa sementara: lihat semua sumber terdaftar (nama/kind/url asli)
				// supaya tahu persis kenapa filter "kompas" di job disablegnews tidak
				// menemukan apa pun.
				if (job === "listsources") {
					out.sources = (await getTurso(env).prepare(`SELECT id, name, kind, url, active, category FROM news_source ORDER BY id`).all()).results;
				}
				// One-shot: sumber Kompas sudah nonaktif duluan, TAPI ratusan artikel
				// yang sudah kelanjur ditarik sebelumnya (status='new') tetap akan terus
				// diproses selama belum dibersihkan -- nonaktifkan source cuma menghentikan
				// TARIKAN BARU, tidak menyentuh backlog yang sudah ada.
				if (job === "skipkompasqueue") {
					const r1 = await getTurso(env)
						.prepare(`UPDATE news_article SET status='skipped' WHERE status='new' AND source LIKE '%ompas%'`)
						.run();
					// Template FB (fbTemplateGenerate) TIDAK dibatasi status='new' -- dia
					// jalan lewat kolom terpisah fb_direct_posted_at='' yg mencakup
					// SEMUA artikel lama (termasuk yg sudah lama posting ke Blogger),
					// jadi backlog Kompas juga harus dibersihkan dari SINI supaya tidak
					// terus muncul di antrean Template FB.
					const r2 = await getTurso(env)
						.prepare(`UPDATE news_article SET fb_direct_posted_at='skip' WHERE fb_direct_posted_at='' AND source LIKE '%ompas%'`)
						.run();
					out.skippedMain = r1.meta.changes;
					out.skippedFbTemplate = r2.meta.changes;
				}
			} catch (e) {
				out.ok = false;
				out.error = e instanceof Error ? e.message : String(e);
			}
			return json(out);
		}

		// selain /api dan /health -> serahkan ke static assets (Index.html panel).
		return env.ASSETS.fetch(request);
	},

	// Cron Triggers:
	//   "*/5 * * * *" -> router auto-post prediksi
	//   "* * * * *"   -> pump scan INVEST (lanjutkan user yang state-nya 'running')
	async scheduled(event, env, _ctx): Promise<void> {
		try {
			await env.DB.prepare(
				`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
				.bind(new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " | cron=" + event.cron)
				.run();
		} catch (e) {
			console.error("cron heartbeat error", e);
		}

		if (event.cron === "*/5 * * * *") {
			await runAutoPostRouter(env).catch((e) => console.error("auto-post router error", e));
			await dailyPrune(env).catch((e) => console.error("prune error", e));
		} else {
			await investPump(env).catch((e) => console.error("invest pump error", e));
		}
	},
} satisfies ExportedHandler<Env>;
