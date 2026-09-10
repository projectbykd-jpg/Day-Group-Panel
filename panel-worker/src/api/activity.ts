// Port logClientActivity — log aktivitas dari frontend (mis. COPY TELEGRAM, dll).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";

export async function logClientActivity(
	env: Env,
	token: string,
	action: string,
	detail: string,
	status: string,
	content: string,
) {
	try {
		const session = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
		await logActivity(
			env,
			session.username,
			String(action ?? "AKTIVITAS"),
			String(detail ?? ""),
			String(status ?? "INFO"),
			String(content ?? ""),
		);
		return { success: true };
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}
