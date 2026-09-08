// Port endpoint publik Invest.gs (investGetConfig / investSaveConfig / investTestSession /
// investStartScan / investContinueScan / investResetScan / investGetStatus / investGetWarnings).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";
import {
	INVEST_PASARAN,
	InvestSessionExpired,
	investConfigForClient,
	investFetch,
	investGetState,
	investGetWarningsList,
	investLoadConfig,
	investSaveConfig as investSaveConfigDb,
	investSetState,
	investWarningCount,
} from "../lib/invest";

async function investUser(env: Env, token: string): Promise<string> {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	return s.username;
}

export async function investGetConfig(env: Env, token: string) {
	const user = await investUser(env, token);
	const cfg = await investLoadConfig(env, user);
	return {
		success: true,
		config: investConfigForClient(cfg),
		state: await investGetState(env, user),
		warningCount: await investWarningCount(env, user),
	};
}

export async function investSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const user = await investUser(env, token);
	const cfg = await investSaveConfigDb(env, user, data ?? {});
	try {
		await logActivity(
			env,
			user,
			"INVEST SIMPAN SETTING",
			`BASE_URL: ${cfg.BASE_URL} | PHPSESSID ${cfg.PHPSESSID ? "terisi (" + cfg.PHPSESSID.length + " char)" : "kosong"}` +
				` | limit 2D/3D/4D: ${cfg.LIMIT_2D}/${cfg.LIMIT_3D}/${cfg.LIMIT_4D}`,
			"BERHASIL",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, config: investConfigForClient(cfg) };
}

export async function investTestSession(env: Env, token: string) {
	const user = await investUser(env, token);
	try {
		const html = await investFetch(await investLoadConfig(env, user), "agentoverview.php");
		return { success: true, message: `Session valid (${html.length} bytes diterima).` };
	} catch (e) {
		const expired = e instanceof InvestSessionExpired;
		return {
			success: false,
			message: expired
				? "Session sudah tidak valid / expired. Ambil PHPSESSID baru dari browser lalu simpan."
				: e instanceof Error
					? e.message
					: String(e),
		};
	}
}

export async function investStartScan(env: Env, token: string) {
	const user = await investUser(env, token);
	const cfg = await investLoadConfig(env, user);
	if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) {
		return { success: false, message: "PHPSESSID belum diisi. Simpan dulu sesinya." };
	}
	const cur = await investGetState(env, user);
	if (cur.state === "running") {
		return { success: false, message: "Scan kamu sedang berjalan. Tunggu selesai atau klik RESET." };
	}
	const state = await investSetState(env, user, {
		state: "running",
		cursor: 0,
		total: INVEST_PASARAN.length,
		startedAt: tsNow(),
		finishedAt: "",
		warningCount: 0,
		message: "Scan dijadwalkan…",
	});
	try {
		await logActivity(
			env,
			user,
			"INVEST SCAN MULAI",
			`Scan invest dijadwalkan (${INVEST_PASARAN.length} pasaran).`,
			"INFO",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan dijadwalkan — worker akan memprosesnya di latar belakang.", state };
}

export async function investContinueScan(env: Env, token: string) {
	const user = await investUser(env, token);
	const cur = await investGetState(env, user);
	if (cur.state === "running") return { success: false, message: "Scan kamu sedang berjalan." };
	const state = await investSetState(env, user, { state: "running", message: "Melanjutkan scan…" });
	try {
		await logActivity(
			env,
			user,
			"INVEST SCAN LANJUT",
			cur.cursor != null ? `Lanjut dari pasaran ${cur.cursor}` : "Lanjut scan",
			"INFO",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan dilanjutkan — worker akan memprosesnya di latar belakang.", state };
}

export async function investResetScan(env: Env, token: string) {
	const user = await investUser(env, token);
	await investSetState(env, user, {
		state: "idle",
		cursor: 0,
		message: "Scan di-reset. Hasil lama tetap ada sampai scan berikutnya.",
	});
	try {
		await logActivity(env, user, "INVEST SCAN RESET", "Scan invest di-reset", "INFO", "");
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan di-reset." };
}

export async function investGetStatus(env: Env, token: string) {
	const user = await investUser(env, token);
	const st = await investGetState(env, user);
	return { ...st, success: true, warningCount: await investWarningCount(env, user) };
}

export async function investGetWarnings(env: Env, token: string) {
	const user = await investUser(env, token);
	const users = await investGetWarningsList(env, user);
	return { success: true, users, state: await investGetState(env, user), warningCount: users.length };
}
