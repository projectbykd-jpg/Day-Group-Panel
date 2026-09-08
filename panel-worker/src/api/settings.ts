// Port setMaintenanceInternal_ dari PanelCore.gs.
import { requireSession } from "./auth";
import { getMaintenance } from "../lib/db";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";

export async function setMaintenance(env: Env, token: string, enabled: boolean, message: string) {
	const session = await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const msg = String(message || "Panel sedang dalam pemeliharaan.");
	await env.DB.batch([
		env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'maintenance'`).bind(enabled ? "TRUE" : "FALSE"),
		env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'maintenance_message'`).bind(msg),
		env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'updated_by'`).bind(session.username),
		env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'updated_at'`).bind(tsNow()),
	]);
	await logActivity(
		env,
		session.username,
		"MODE MAINTENANCE",
		enabled ? "Diaktifkan" : "Dinonaktifkan",
		"BERHASIL",
		msg,
	);
	return getMaintenance(env);
}
