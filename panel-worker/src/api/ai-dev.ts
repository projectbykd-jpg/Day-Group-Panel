// Endpoint publik menu "AI Dev" -- ADMIN saja (lihat src/lib/ai-dev.ts).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { botCfg } from "../lib/bot-news";
import { aiDevChat, aiDevListDir, aiDevReadFile, aiDevWriteFile, AiDevImage, AiDevMessage } from "../lib/ai-dev";

async function gateAdmin(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	return s;
}

export async function aiDevListDirApi(env: Env, token: string, path: string) {
	await gateAdmin(env, token);
	const entries = await aiDevListDir(env, path || "");
	return { success: true, entries };
}

export async function aiDevReadFileApi(env: Env, token: string, path: string) {
	await gateAdmin(env, token);
	const file = await aiDevReadFile(env, path);
	return { success: true, file };
}

export async function aiDevChatApi(env: Env, token: string, history: unknown, attachedFiles: unknown, message: string, images: unknown) {
	await gateAdmin(env, token);
	const cfg = await botCfg(env);
	const hist = Array.isArray(history)
		? (history as Record<string, unknown>[])
				.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: String(m.text ?? "") }) as AiDevMessage)
				.filter((m) => m.text)
		: [];
	const files = Array.isArray(attachedFiles)
		? (attachedFiles as Record<string, unknown>[]).map((f) => ({ path: String(f.path ?? ""), content: String(f.content ?? "") })).filter((f) => f.path)
		: [];
	// data URL prefix ("data:image/png;base64,") DIBUANG di sini kalau ikut
	// kebawa dari FileReader browser -- Gemini cuma mau base64 murni.
	const imgs: AiDevImage[] = Array.isArray(images)
		? (images as Record<string, unknown>[])
				.map((im) => ({ mimeType: String(im.mimeType ?? "image/png"), data: String(im.data ?? "").replace(/^data:[^;]+;base64,/, "") }))
				.filter((im) => im.data)
				.slice(0, 4)
		: [];
	const out = await aiDevChat(env, cfg, hist, files, String(message ?? ""), imgs);
	return { success: true, ...out };
}

export async function aiDevApplyApi(env: Env, token: string, path: string, content: string) {
	const s = await gateAdmin(env, token);
	const res = await aiDevWriteFile(env, path, content, `AI Dev: ubah ${path} (via panel, oleh ${s.username})`);
	await logActivity(env, s.username, "AI DEV TERAPKAN FILE", `Commit ke GitHub: ${path}`, "BERHASIL", res.commitUrl);
	return { success: true, commitUrl: res.commitUrl };
}
