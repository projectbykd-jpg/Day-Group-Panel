// Port getLivePanelData / getCurrentUserProfile dari V6Core.gs.
import { publicProfile, requireSession } from "./auth";
import { getDashboardData, normalizeDashOptions } from "../lib/dash";
import { adminListActiveSessions } from "./admin";

export async function getCurrentUserProfile(env: Env, token: string) {
	const session = await requireSession(env, token);
	return publicProfile(session.profile, String(token ?? ""), session.maintenance);
}

export async function getLivePanelData(
	env: Env,
	token: string,
	opts: { activity?: unknown; sessions?: boolean },
) {
	let session;
	try {
		session = await requireSession(env, token, { ignoreMaintenance: true });
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
	opts = opts ?? {};

	const out: {
		success: true;
		ts: number;
		maintenance: typeof session.maintenance;
		activity?: unknown;
		summary?: { stats: unknown; role: string };
		sessions?: unknown;
		errors: Record<string, string>;
	} = {
		success: true,
		ts: Date.now(),
		maintenance: session.maintenance,
		errors: {},
	};

	if (opts.activity) {
		try {
			out.activity = await getDashboardData(env, session.profile, normalizeDashOptions(opts.activity));
		} catch (e) {
			out.errors.activity = e instanceof Error ? e.message : String(e);
		}
	}

	if (out.activity && (out.activity as { stats?: unknown }).stats) {
		const a = out.activity as { stats: unknown; role?: string };
		out.summary = { stats: a.stats, role: a.role ?? "" };
	} else {
		try {
			const head = await getDashboardData(
				env,
				session.profile,
				normalizeDashOptions({ page: 1, pageSize: 1 }),
			);
			out.summary = { stats: head.stats, role: head.role };
		} catch (e) {
			out.errors.summary = e instanceof Error ? e.message : String(e);
		}
	}

	if (opts.sessions) {
		try {
			out.sessions = await adminListActiveSessions(env, token);
		} catch (e) {
			out.errors.sessions = e instanceof Error ? e.message : String(e);
		}
	}

	return out;
}
