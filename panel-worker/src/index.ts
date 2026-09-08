// Day-Group Panel — Cloudflare Worker (port dari Apps Script).
// Semua panggilan frontend lama google.script.run.<fn>(...) dipetakan ke
// POST /api  body: { "action": "<fn>", ...args }
import { json } from "./lib/respond";
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
import { investPump } from "./lib/invest-scan";

type Handler = (env: Env, body: Record<string, unknown>) => Promise<unknown>;
const s = (v: unknown) => String(v ?? "");

// Pangkas Activity Log sekali per hari WIB (dikunci lewat KV).
async function dailyPrune(env: Env): Promise<number | "skip"> {
	const dayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
	const guard = "retention:" + dayKey;
	try {
		if (await env.SESS.get(guard)) return "skip";
		await env.SESS.put(guard, "1", { expirationTtl: 172800 });
	} catch {
		/* lanjut */
	}
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
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

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
				return json(await handler(env, body));
			} catch (e) {
				return json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		if (url.pathname === "/health") {
			return new Response("panel-worker OK", { headers: { "content-type": "text/plain" } });
		}

		// Endpoint cron eksternal (fallback kalau Cron Trigger Cloudflare tidak jalan).
		// Panggil tiap menit dari cron-job.org / GitHub Actions / UptimeRobot:
		//   https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=all
		if (url.pathname === "/__cron") {
			if (!env.CRON_KEY || url.searchParams.get("key") !== env.CRON_KEY) {
				return json({ ok: false, message: "unauthorized" }, 401);
			}
			const job = url.searchParams.get("job") || "all";

			// Diagnosa sementara: /__cron?key=...&job=debug&user=<username>&path=<path>
			if (job === "debug") {
				const dbgUser = url.searchParams.get("user") || "Admin";
				const cfgRow = await env.DB.prepare(`SELECT base_url, phpsessid, koderedis, cookie_extra FROM invest_config WHERE username = ?`)
					.bind(dbgUser)
					.first<Record<string, string>>();
				if (!cfgRow) return json({ ok: false, message: "no invest_config for " + dbgUser });
				let baseUrl = String(cfgRow.base_url || "");
				if (!baseUrl.endsWith("/")) baseUrl += "/";
				const cookie = cfgRow.cookie_extra
					? cfgRow.cookie_extra
					: "PHPSESSID=" + cfgRow.phpsessid + (cfgRow.koderedis ? "; koderedis=" + cfgRow.koderedis : "");
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
						results.push({
							url: baseUrl + p,
							status: r.status,
							location: r.headers.get("location"),
							len: body.length,
							hasPeriode: /name=["']?periode["']?[^>]*value=["'](\d+)["']/i.test(body),
							snippet: body.slice(0, 600),
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
