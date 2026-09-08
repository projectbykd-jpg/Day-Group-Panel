// Port getBootstrapData / getDashboardData / getLivePanelData (bagian dashboard).
import { publicProfile, requireSession } from "./auth";
import { getDashboardData, normalizeDashOptions } from "../lib/dash";

export async function getBootstrapData(env: Env, token: string) {
	let session;
	try {
		session = await requireSession(env, token, { ignoreMaintenance: true });
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}

	const out: {
		success: true;
		profile: ReturnType<typeof publicProfile>;
		dashboard: unknown;
		errors: Record<string, string>;
	} = {
		success: true,
		profile: publicProfile(session.profile, String(token ?? ""), session.maintenance),
		dashboard: null,
		errors: {},
	};

	try {
		out.dashboard = await getDashboardData(
			env,
			session.profile,
			normalizeDashOptions({ page: 1, pageSize: 5 }),
		);
	} catch (e) {
		out.errors.dashboard = e instanceof Error ? e.message : String(e);
	}
	return out;
}

export async function getDashboard(env: Env, token: string, options: unknown) {
	const session = await requireSession(env, token, { ignoreMaintenance: true });
	return getDashboardData(env, session.profile, normalizeDashOptions(options));
}
