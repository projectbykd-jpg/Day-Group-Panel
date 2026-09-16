// Menu "AI Dev" -- ADMIN saja. Asisten coding DI DALAM panel sendiri (bukan
// tool luar spt Cline/Aider) yang bisa BACA file project ini langsung dari
// GitHub (repo Day-Group-Panel, lewat GH_TOKEN yang sudah ada -- sama yang
// dipakai invest-turbo.yml/news-turbo.yml) sbg konteks obrolan, lalu USULKAN
// perubahan file lengkap yang admin REVIEW & APPLY (commit ke GitHub) satu
// per satu lewat tombol -- TIDAK PERNAH commit sendiri tanpa diklik, demi
// keamanan (ini kode PRODUKSI yang lagi jalan, bukan sandbox).
//
// Deploy ke Cloudflare TETAP MANUAL (npm run deploy) sesudah commit -- repo
// ini belum punya GitHub Action auto-deploy (butuh CLOUDFLARE_API_TOKEN sbg
// secret repo, keputusan terpisah, di luar scope v1 ini).
//
// Model AI pakai key yang SAMA dgn menu BOT (groq_key/gemini_key di
// Konfigurasi Lanjutan) -- API provider yang sama, cuma dipakai utk keperluan
// beda (nulis artikel vs ngobrolin kode), tidak perlu key terpisah.

const REPO = "projectbykd-jpg/Day-Group-Panel"; // sama seperti INVEST_TURBO_REPO di lib/invest? -- lihat api/invest.ts

const ghHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"User-Agent": "daygroup-panel-ai-dev",
	"X-GitHub-Api-Version": "2022-11-28",
});

function requireGhToken(env: Env): string {
	const t = env.GH_TOKEN;
	if (!t) throw new Error("GH_TOKEN belum dikonfigurasi di server -- hubungi admin.");
	return t;
}

const b64Encode = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const b64Decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export interface AiDevEntry {
	name: string;
	path: string;
	type: "file" | "dir";
}

export async function aiDevListDir(env: Env, path: string): Promise<AiDevEntry[]> {
	const token = requireGhToken(env);
	const clean = String(path || "").replace(/^\/+|\/+$/g, "");
	const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${clean}`, { headers: ghHeaders(token) });
	if (!resp.ok) throw new Error(`Gagal baca folder "${clean || "/"}" (HTTP ${resp.status}).`);
	const j = (await resp.json()) as unknown;
	if (!Array.isArray(j)) throw new Error(`"${clean}" bukan folder.`);
	return (j as Record<string, unknown>[])
		.map((e) => ({ name: String(e.name ?? ""), path: String(e.path ?? ""), type: (e.type === "dir" ? "dir" : "file") as "file" | "dir" }))
		.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export async function aiDevReadFile(env: Env, path: string): Promise<{ path: string; content: string; sha: string }> {
	const token = requireGhToken(env);
	const clean = String(path || "").replace(/^\/+/, "");
	if (!clean) throw new Error("Path file kosong.");
	const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${clean}`, { headers: ghHeaders(token) });
	if (!resp.ok) throw new Error(`Gagal baca file "${clean}" (HTTP ${resp.status}).`);
	const j = (await resp.json()) as Record<string, unknown>;
	if (Array.isArray(j) || !j.content) throw new Error(`"${clean}" bukan file (mungkin folder).`);
	return { path: clean, content: b64Decode(String(j.content)), sha: String(j.sha ?? "") };
}

export async function aiDevWriteFile(env: Env, path: string, content: string, message: string): Promise<{ commitUrl: string }> {
	const token = requireGhToken(env);
	const clean = String(path || "").replace(/^\/+/, "");
	if (!clean) throw new Error("Path file kosong.");
	// Ambil sha TERBARU tepat sebelum commit (bukan yang dicache sepanjang
	// obrolan) -- supaya tidak menimpa perubahan lain yang terjadi di antara
	// AI membaca file & admin klik Terapkan (mis. Claude Code commit duluan).
	let sha: string | undefined;
	try {
		sha = (await aiDevReadFile(env, clean)).sha;
	} catch {
		/* file baru -- belum ada sha, PUT tanpa sha = bikin file baru */
	}
	const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${clean}`, {
		method: "PUT",
		headers: ghHeaders(token),
		body: JSON.stringify({ message, content: b64Encode(content), sha, branch: "main" }),
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(`Gagal commit "${clean}" (HTTP ${resp.status}): ${body.slice(0, 300)}`);
	}
	const j = (await resp.json()) as Record<string, unknown>;
	const commit = j.commit as Record<string, unknown> | undefined;
	return { commitUrl: String(commit?.html_url ?? "") };
}

// ---------------------------------------------------------------------------
// Chat -- provider Groq (utama) / Gemini (cadangan), key sama dgn Bot News.
// ---------------------------------------------------------------------------
export interface AiDevMessage {
	role: "user" | "assistant";
	text: string;
}
export interface AiDevFileProposal {
	path: string;
	content: string;
}
export interface AiDevReply {
	reply: string;
	proposals: AiDevFileProposal[];
}

const SYSTEM_PROMPT =
	`Kamu asisten coding untuk project "Day-Group-Panel" -- Cloudflare Worker (TypeScript, folder src/) + frontend ` +
	`1 halaman HTML/JS (ui-src/Index.html, Scripts.html, Styles.html, dirakit scripts/build-ui.mjs), dipakai sbg panel admin bisnis ` +
	`(togel/prediksi, laporan harian, bot berita, dll). Jawab berbahasa Indonesia santai (boleh sapa "bro"), jelas, tidak bertele-tele.\n\n` +
	`Kamu TIDAK bisa membaca file sendiri -- HANYA file yang eksplisit dilampirkan user (ditandai "=== FILE: <path> ===" di bawah pesan) ` +
	`yang kamu tahu isinya. Kalau butuh lihat file lain dulu sebelum bisa jawab, BILANG TERUS TERANG minta user lampirkan file itu -- ` +
	`JANGAN PERNAH mengarang/menebak isi file yang belum kamu lihat.\n\n` +
	`Kalau user minta PERUBAHAN KODE dan kamu sudah punya isi file terkait, usulkan isi file BARU LENGKAP (bukan potongan diff/patch) ` +
	`dengan format PERSIS begini (boleh lebih dari satu blok kalau perlu ubah beberapa file sekaligus):\n` +
	`===FILE: <path relatif dari root repo, SAMA PERSIS seperti yang diberikan di lampiran>===\n` +
	`<isi lengkap file baru, dari baris pertama sampai baris terakhir>\n` +
	`===END===\n\n` +
	`Di LUAR blok ===FILE:...===END=== itu, jelaskan SINGKAT apa yang diubah & kenapa (buat manusia baca, bukan JSON/markup). ` +
	`PENTING: kamu TIDAK bisa commit/deploy sendiri -- user yang REVIEW & klik tombol "Terapkan" tiap file yang kamu usulkan, jadi ` +
	`jangan bilang "sudah saya terapkan" -- bilang "sudah aku usulkan, tinggal direview & diterapkan".`;

function parseProposals(text: string): { reply: string; proposals: AiDevFileProposal[] } {
	const proposals: AiDevFileProposal[] = [];
	const re = /===FILE:\s*([^\n=]+?)\s*===\n([\s\S]*?)\n?===END===/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		proposals.push({ path: m[1].trim(), content: m[2] });
	}
	const reply = text.replace(re, "").trim();
	return { reply, proposals };
}

async function callGroq(apiKey: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
	const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, messages, temperature: 0.4 }),
	});
	const body: any = await resp.json().catch(() => ({}));
	if (!resp.ok) throw new Error("Groq HTTP " + resp.status + ": " + JSON.stringify(body?.error || body).slice(0, 200));
	const content = body?.choices?.[0]?.message?.content;
	if (!content) throw new Error("Groq balas kosong.");
	return String(content);
}

async function callGemini(apiKey: string, model: string, systemPrompt: string, messages: { role: string; content: string }[]): Promise<string> {
	const contents = messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
	const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { temperature: 0.4 } }),
	});
	const body: any = await resp.json().catch(() => ({}));
	if (!resp.ok) throw new Error("Gemini HTTP " + resp.status + ": " + JSON.stringify(body?.error || body).slice(0, 200));
	const content = body?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("");
	if (!content) throw new Error("Gemini balas kosong (mungkin diblokir safety filter).");
	return String(content);
}

const GROQ_MODEL_CANDIDATES = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3-32b"];
const GEMINI_MODEL_CANDIDATES = ["gemini-flash-latest", "gemini-2.0-flash"];

export async function aiDevChat(
	env: Env,
	cfg: Record<string, string>,
	history: AiDevMessage[],
	attachedFiles: { path: string; content: string }[],
	userMessage: string,
): Promise<AiDevReply> {
	const groqKeys = String(cfg.groq_key || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
	const geminiKeys = String(cfg.gemini_key || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
	if (!groqKeys.length && !geminiKeys.length) {
		throw new Error("Groq/Gemini key belum diisi -- isi dulu di menu BOT -> Konfigurasi Lanjutan (key yang sama dipakai di sini).");
	}
	// Batasi konteks (percakapan + lampiran) -- terlalu besar boros token &
	// beberapa model punya batas context window ketat di tier gratis.
	const trimmedHistory = history.slice(-16);
	const attachText = attachedFiles.length
		? attachedFiles.map((f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, 20000)}`).join("\n\n")
		: "(tidak ada file dilampirkan pesan ini)";
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		...trimmedHistory.map((m) => ({ role: m.role, content: m.text })),
		{ role: "user", content: `${userMessage}\n\n--- FILE YANG DILAMPIRKAN ---\n${attachText}` },
	];

	let text = "";
	const errs: string[] = [];
	for (const gk of groqKeys) {
		for (const model of GROQ_MODEL_CANDIDATES) {
			try {
				text = await callGroq(gk, model, messages);
				break;
			} catch (e) {
				errs.push("Groq/" + model + ": " + (e instanceof Error ? e.message : String(e)));
			}
		}
		if (text) break;
	}
	if (!text) {
		for (const gemk of geminiKeys) {
			for (const model of GEMINI_MODEL_CANDIDATES) {
				try {
					text = await callGemini(gemk, model, SYSTEM_PROMPT, messages);
					break;
				} catch (e) {
					errs.push("Gemini/" + model + ": " + (e instanceof Error ? e.message : String(e)));
				}
			}
			if (text) break;
		}
	}
	if (!text) throw new Error("Semua provider AI gagal:\n" + errs.join("\n"));

	const { reply, proposals } = parseProposals(text);
	return { reply: reply || "(AI cuma balas usulan file, tanpa penjelasan.)", proposals };
}
