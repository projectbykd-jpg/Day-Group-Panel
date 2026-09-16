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

import { botCfgSet } from "./bot-news";

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

export async function aiDevSearchCode(env: Env, query: string): Promise<{ path: string }[]> {
	const token = requireGhToken(env);
	const q = String(query || "").trim();
	if (!q) return [];
	const resp = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(q + " repo:" + REPO)}&per_page=15`, { headers: ghHeaders(token) });
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(`Pencarian "${q}" gagal (HTTP ${resp.status}): ${body.slice(0, 200)}`);
	}
	const j = (await resp.json()) as Record<string, unknown>;
	const items = Array.isArray(j.items) ? (j.items as Record<string, unknown>[]) : [];
	return items.map((it) => ({ path: String(it.path ?? "") })).filter((it) => it.path);
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
	readPaths: string[];
}

const SYSTEM_PROMPT =
	`Kamu asisten coding untuk project "Day-Group-Panel" -- Cloudflare Worker (TypeScript) + frontend 1 halaman HTML/JS, dipakai sbg ` +
	`panel admin bisnis (togel/prediksi, laporan harian, bot berita, dll). Jawab berbahasa Indonesia santai (boleh sapa "bro"), jelas, ` +
	`tidak bertele-tele.\n\n` +
	`Struktur repo: backend Cloudflare Worker di "panel-worker/src/" (index.ts = router utama tempat semua action didaftarkan, ` +
	`src/api/*.ts = handler per fitur/menu, src/lib/*.ts = logic inti & akses database). Frontend 1 halaman di "panel-worker/ui-src/" ` +
	`(Index.html = struktur HTML statis, Scripts.html = SEMUA javascript app, Styles.html = CSS custom, ketiganya dirakit jadi ` +
	`1 file "public/index.html" oleh scripts/build-ui.mjs -- kalau ubah UI, edit file2 ui-src/ ini, BUKAN public/index.html langsung). ` +
	`GitHub Actions workflow ada di ".github/workflows/" (root repo, bukan di dalam panel-worker/).\n\n` +
	`Kamu PUNYA TOOLS buat menjelajah repo SENDIRI: list_dir(path) lihat isi folder, read_file(path) baca isi lengkap 1 file, ` +
	`search_code(query) cari keyword/nama fungsi/potongan teks di SELURUH repo. PAKAI tools ini AKTIF buat cari & baca file yang ` +
	`relevan SEBELUM menjawab -- kalau user cerita soal bug/fitur tanpa nyebut nama file, JANGAN nunggu ditanya balik, langsung cari ` +
	`sendiri (mulai dari search_code kalau tau nama fungsi/kata kunci terkait, atau list_dir dari "panel-worker/src" / ` +
	`"panel-worker/ui-src" kalau belum tau harus cari ke mana). JANGAN PERNAH mengarang/menebak isi file yang belum kamu baca via tools ` +
	`atau yang dilampirkan user -- kalau ragu, baca dulu.\n\n` +
	`Kalau user minta PERUBAHAN KODE dan kamu SUDAH baca isi file terkait (via tool read_file atau lampiran), usulkan isi file BARU ` +
	`LENGKAP (bukan potongan diff/patch) dengan format PERSIS begini di jawaban FINAL kamu (boleh lebih dari satu blok kalau perlu ` +
	`ubah beberapa file sekaligus):\n` +
	`===FILE: <path relatif dari root repo, SAMA PERSIS seperti path yang kamu baca>===\n` +
	`<isi lengkap file baru, dari baris pertama sampai baris terakhir>\n` +
	`===END===\n\n` +
	`Di LUAR blok ===FILE:...===END=== itu, jelaskan SINGKAT apa yang diubah & kenapa (buat manusia baca, bukan JSON/markup). ` +
	`PENTING: kamu TIDAK bisa commit/deploy sendiri -- user yang REVIEW & klik tombol "Terapkan" tiap file yang kamu usulkan, jadi ` +
	`jangan bilang "sudah saya terapkan" -- bilang "sudah aku usulkan, tinggal direview & diterapkan".`;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "list_dir",
			description: "Lihat daftar file & folder di dalam suatu direktori repo.",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: 'Path folder relatif dari root repo, kosongkan ("") utk root.' } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Baca isi lengkap 1 file di repo.",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Path file relatif dari root repo." } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_code",
			description: "Cari keyword/nama fungsi/potongan teks di seluruh isi repo, balas daftar path file yang cocok.",
			parameters: {
				type: "object",
				properties: { query: { type: "string", description: "Kata kunci pencarian." } },
				required: ["query"],
			},
		},
	},
];

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

// Loop tool-use (function calling ala OpenAI, format yang dipakai Groq) --
// AI boleh minta jalankan list_dir/read_file/search_code berkali-kali (max
// MAX_STEPS) sebelum balas jawaban FINAL (tanpa tool_calls lagi). Tiap
// panggilan tool dijalankan SERVER-SIDE (bukan browser), hasilnya (isi file/
// daftar folder/hasil cari) dimasukkan balik ke percakapan sbg pesan role
// "tool", supaya AI "melihat" hasilnya sebelum lanjut mikir.
const MAX_TOOL_STEPS = 8;

async function runTool(env: Env, name: string, args: Record<string, unknown>, readPaths: string[]): Promise<string> {
	try {
		if (name === "list_dir") {
			const entries = await aiDevListDir(env, String(args.path ?? ""));
			return entries.length ? entries.map((e) => `${e.type === "dir" ? "[folder]" : "[file]  "} ${e.path}`).join("\n") : "(folder kosong)";
		}
		if (name === "read_file") {
			const file = await aiDevReadFile(env, String(args.path ?? ""));
			readPaths.push(file.path);
			return `=== FILE: ${file.path} ===\n${file.content.slice(0, 24000)}`;
		}
		if (name === "search_code") {
			const hits = await aiDevSearchCode(env, String(args.query ?? ""));
			return hits.length ? hits.map((h) => h.path).join("\n") : "(tidak ada hasil, coba kata kunci lain)";
		}
		return `ERROR: tool "${name}" tidak dikenal.`;
	} catch (e) {
		return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
	}
}

async function callGroqAgentic(
	env: Env,
	apiKey: string,
	model: string,
	initialMessages: Record<string, unknown>[],
): Promise<{ text: string; readPaths: string[] }> {
	const readPaths: string[] = [];
	const messages = initialMessages.slice();
	for (let step = 0; step < MAX_TOOL_STEPS; step++) {
		const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3 }),
		});
		const body: any = await resp.json().catch(() => ({}));
		if (!resp.ok) throw new Error("Groq HTTP " + resp.status + ": " + JSON.stringify(body?.error || body).slice(0, 200));
		const msg = body?.choices?.[0]?.message;
		if (!msg) throw new Error("Groq balas kosong.");
		const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
		if (!toolCalls.length) {
			const content = String(msg.content || "").trim();
			if (!content) throw new Error("Groq balas kosong tanpa tool call.");
			return { text: content, readPaths };
		}
		messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
		for (const tc of toolCalls) {
			const name = String(tc?.function?.name ?? "");
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc?.function?.arguments || "{}");
			} catch {
				/* argumen rusak -- args tetap {} , tool-nya sendiri yg akan gagal & lapor error ke AI */
			}
			const result = await runTool(env, name, args, readPaths);
			messages.push({ role: "tool", tool_call_id: tc?.id, content: result });
		}
	}
	throw new Error(`AI kehabisan langkah pencarian (>${MAX_TOOL_STEPS}x panggil tools) sebelum kasih jawaban final -- coba pertanyaan yang lebih spesifik.`);
}

export interface AiDevImage {
	mimeType: string;
	data: string; // base64, TANPA prefix "data:...;base64,"
}

// Gemini DUKUNG tools (function calling) + gambar (inlineData) SEKALIGUS di
// request yang sama -- beda dari Groq yang model tool-use-nya text-only.
// Jadi kalau pesan ada gambar, jalurnya SELALU lewat sini (bukan Groq), biar
// AI tetap bisa baca file sendiri DAN lihat gambar dalam 1 obrolan yang sama.
// Formatnya: tools -> [{functionDeclarations:[{name,description,parameters}]}],
// balasan tool-call -> parts berisi {functionCall:{name,args}}, dibalas balik
// lewat parts berisi {functionResponse:{name,response}} dgn role "function".
async function callGeminiAgentic(
	env: Env,
	apiKey: string,
	model: string,
	systemPrompt: string,
	history: { role: "user" | "assistant"; text: string }[],
	userText: string,
	images: AiDevImage[],
): Promise<{ text: string; readPaths: string[] }> {
	const readPaths: string[] = [];
	const contents: Record<string, unknown>[] = history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
	const userParts: Record<string, unknown>[] = [{ text: userText }];
	for (const img of images) userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
	contents.push({ role: "user", parts: userParts });

	const tools = [{ functionDeclarations: TOOLS.map((t) => t.function) }];
	for (let step = 0; step < MAX_TOOL_STEPS; step++) {
		const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents, tools, generationConfig: { temperature: 0.3 } }),
		});
		const body: any = await resp.json().catch(() => ({}));
		if (!resp.ok) throw new Error("Gemini HTTP " + resp.status + ": " + JSON.stringify(body?.error || body).slice(0, 200));
		const parts: any[] = body?.candidates?.[0]?.content?.parts || [];
		const calls = parts.filter((p) => p?.functionCall);
		if (!calls.length) {
			const text = parts.map((p) => p?.text || "").join("").trim();
			if (!text) throw new Error("Gemini balas kosong (mungkin diblokir safety filter, atau cuma tool call tanpa teks final).");
			return { text, readPaths };
		}
		contents.push({ role: "model", parts });
		for (const c of calls) {
			const name = String(c.functionCall?.name ?? "");
			const args = (c.functionCall?.args || {}) as Record<string, unknown>;
			const result = await runTool(env, name, args, readPaths);
			contents.push({ role: "function", parts: [{ functionResponse: { name, response: { result } } }] });
		}
	}
	throw new Error(`AI (Gemini) kehabisan langkah pencarian (>${MAX_TOOL_STEPS}x panggil tools) sebelum kasih jawaban final.`);
}

// Groq SERING menghapus/membatasi akses model tanpa peringatan (terbukti lagi
// di sini: llama-3.3-70b-versatile dkk balas 404 "does not exist or you do
// not have access to it" ke key ini) -- daftar hardcoded APAPUN bisa basi
// kapan saja, sama persis masalah yang sudah pernah dibenerin di
// geminiRewrite (bot-news.ts). Solusinya sama: kalau SEMUA kandidat statis
// gagal, tanya LANGSUNG ke Groq (GET /v1/models) model apa yang BENAR-BENAR
// bisa diakses key ini, lalu simpan pilihan yang berhasil supaya panggilan
// berikutnya langsung pakai itu tanpa discovery ulang. Cache-nya TERPISAH
// dari cfg.groq_model milik Bot News (key "ai_dev_groq_model") -- model yang
// cocok utk TOOL-USE (function calling) bisa beda dari yang cocok utk nulis
// artikel panjang, tidak boleh saling menimpa.
const AI_DEV_GROQ_MODEL_KEY = "ai_dev_groq_model";
const GROQ_MODEL_CANDIDATES = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3-32b"];
const GEMINI_MODEL_CANDIDATES = ["gemini-flash-latest", "gemini-2.0-flash"];

async function discoverGroqToolModels(apiKey: string, alreadyTried: Set<string>): Promise<string[]> {
	try {
		const resp = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
		const body: any = await resp.json().catch(() => ({}));
		const ids: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m?.id || "")) : [];
		// Buang model non-chat (whisper/tts/guard/dll) DAN model "compound"
		// (agent/routing bawaan Groq -- eksekusi tool-nya sendiri secara internal,
		// tidak menerima skema `tools` custom kita) -- dahulukan nama model
		// general-purpose yang dikenal (llama/qwen/dst) drpd yang tidak dikenal.
		const isBad = (id: string) => /whisper|tts|guard|moderation|prompt-guard|compound|safety|embed/i.test(id);
		const isKnownGood = (id: string) => /llama|qwen|gpt-oss|kimi|mixtral|gemma/i.test(id);
		const usable = ids.filter((id) => id && !alreadyTried.has(id) && !isBad(id));
		return [...usable.filter(isKnownGood), ...usable.filter((id) => !isKnownGood(id))].slice(0, 3);
	} catch {
		return [];
	}
}

export async function aiDevChat(
	env: Env,
	cfg: Record<string, string>,
	history: AiDevMessage[],
	attachedFiles: { path: string; content: string }[],
	userMessage: string,
	images: AiDevImage[] = [],
): Promise<AiDevReply> {
	const groqKeys = String(cfg.groq_key || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
	const geminiKeys = String(cfg.gemini_key || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
	if (!groqKeys.length && !geminiKeys.length) {
		throw new Error("Groq/Gemini key belum diisi -- isi dulu di menu BOT -> Konfigurasi Lanjutan (key yang sama dipakai di sini).");
	}
	if (images.length && !geminiKeys.length) {
		throw new Error("Kirim gambar butuh gemini_key (Groq di sini text-only) -- isi dulu di menu BOT -> Konfigurasi Lanjutan.");
	}
	// Batasi konteks (percakapan + lampiran) -- terlalu besar boros token &
	// beberapa model punya batas context window ketat di tier gratis.
	const trimmedHistory = history.slice(-16);
	const attachText = attachedFiles.length
		? attachedFiles.map((f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, 20000)}`).join("\n\n")
		: "(tidak ada file dilampirkan pesan ini -- pakai tools kalau perlu baca file)";
	const userContent = `${userMessage}\n\n--- FILE YANG DILAMPIRKAN (opsional, di luar ini pakai tools) ---\n${attachText}`;

	let text = "";
	let readPaths: string[] = [];
	const errs: string[] = [];
	// Ada gambar -> LANGSUNG Gemini (satu2nya yang dukung tools + gambar
	// bareng), Groq dilewati sama sekali (model tool-use-nya di sini text-only).
	if (!images.length) {
		const textMessages = [
			{ role: "system", content: SYSTEM_PROMPT },
			...trimmedHistory.map((m) => ({ role: m.role, content: m.text })),
			{ role: "user", content: userContent },
		];
		const cachedModel = cfg[AI_DEV_GROQ_MODEL_KEY];
		const staticCandidates = [...new Set([cachedModel, ...GROQ_MODEL_CANDIDATES].filter(Boolean))] as string[];
		for (const gk of groqKeys) {
			const tried = new Set<string>();
			for (const model of staticCandidates) {
				tried.add(model);
				try {
					const out = await callGroqAgentic(env, gk, model, textMessages as unknown as Record<string, unknown>[]);
					text = out.text;
					readPaths = out.readPaths;
					if (model !== cachedModel) await botCfgSet(env, { [AI_DEV_GROQ_MODEL_KEY]: model }).catch(() => {});
					break;
				} catch (e) {
					errs.push("Groq/" + model + ": " + (e instanceof Error ? e.message : String(e)));
				}
			}
			if (!text) {
				const discovered = await discoverGroqToolModels(gk, tried);
				for (const model of discovered) {
					try {
						const out = await callGroqAgentic(env, gk, model, textMessages as unknown as Record<string, unknown>[]);
						text = out.text;
						readPaths = out.readPaths;
						await botCfgSet(env, { [AI_DEV_GROQ_MODEL_KEY]: model }).catch(() => {});
						break;
					} catch (e) {
						errs.push("Groq/" + model + " (discovery): " + (e instanceof Error ? e.message : String(e)));
					}
				}
			}
			if (text) break;
		}
	}
	if (!text) {
		for (const gemk of geminiKeys) {
			for (const model of GEMINI_MODEL_CANDIDATES) {
				try {
					const out = await callGeminiAgentic(env, gemk, model, SYSTEM_PROMPT, trimmedHistory, userContent, images);
					text = out.text;
					readPaths = out.readPaths;
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
	return { reply: reply || "(AI cuma balas usulan file, tanpa penjelasan.)", proposals, readPaths };
}
