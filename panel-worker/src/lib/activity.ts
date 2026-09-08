// Port logActivity_ -> INSERT ke tabel activity_log. Tidak pernah melempar error.
import { tsNow } from "./time";

export async function logActivity(
	env: Env,
	username: string,
	action: string,
	detail: string,
	status = "INFO",
	content = "",
): Promise<void> {
	try {
		await env.DB.prepare(
			`INSERT INTO activity_log (ts, username, action, status, detail, content)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				tsNow(),
				username || "UNKNOWN",
				action || "AKTIVITAS",
				status || "INFO",
				detail || "",
				content || "",
			)
			.run();
	} catch {
		// swallow — logging tidak boleh menggagalkan aksi utama
	}
}
