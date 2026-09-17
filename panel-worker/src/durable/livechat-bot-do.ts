// Durable Object "otak" bot Live Chat Auto-Reply: satu-satunya tempat yang
// boleh memegang koneksi Socket.IO ke DayLiveChat (harus hidup terus-menerus
// -- Worker biasa tidak bisa, tiap request/isolate-nya berumur pendek).
//
// DayLiveChat tidak punya API publik/terdokumentasi -- semua di bawah ini
// hasil membongkar /js/cs-dashboard.js & /shared.js situsnya sendiri (fetch
// langsung, dibaca manual): login JWT lewat POST /api/auth/login, daftar
// chat lewat GET /api/chats/inbox, real-time lewat Socket.IO biasa (event
// 'chat:new_message' dari server, kirim balasan lewat emit 'cs:message').
// Karena Cloudflare Workers tidak bisa pakai library socket.io-client (perlu
// API Node yang tidak ada di Workers), protokol Socket.IO v4 di-implementasi
// manual & MINIMAL di sini (cukup utk connect+auth+dengar 1 event+emit 1
// event pakai ack) lewat WebSocket bawaan Workers (fetch dgn header Upgrade).
import { getTurso } from "../lib/turso";
import {
	getCredential,
	isSessionBotEnabled,
	listActiveTemplates,
	logAutoReply,
	pickRandomTemplate,
	upsertSessionSeen,
} from "../lib/livechat-bot";

const DLC_ORIGIN = "https://daylivechat.com";
// DayLiveChat menolak (403) request tanpa header "browser wajar" -- terbukti
// lewat log: login LANGSUNG sukses dari sesi curl biasa tapi ditolak dari
// outbound fetch Workers polos (cuma content-type). Kemungkinan WAF/anti-bot
// di depan situsnya menyaring berdasar User-Agent/Origin/Referer, bukan IP
// per-se -- makanya SEMUA request ke DayLiveChat (login, inbox, upgrade
// websocket) di bawah ini SELALU menyertakan header ini, meniru persis apa
// yang dikirim browser CS asli waktu buka /cs/chat.
const DLC_BROWSER_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
	Origin: DLC_ORIGIN,
	Referer: DLC_ORIGIN + "/cs/chat",
	Accept: "application/json, text/plain, */*",
};
// Toleransi sebelum membalas member yang BARU chat 1x (belum dianggap spam).
const GRACE_MS = 30_000;
// Jarak MINIMAL antar balasan otomatis selama member masih spam (>=2 pesan).
const SPAM_INTERVAL_MS = 15_000;
// Jeda tanpa pesan baru dari member sebelum burst dianggap selesai -- pesan
// berikutnya (kalau ada) dihitung ulang dari "1x" (toleransi 30 detik lagi),
// bukan tetap dianggap sambungan spam yang sama.
const BURST_RESET_MS = 90_000;

interface BurstState {
	count: number;
	lastMsgAt: number;
	lastReplyAt: number;
}
interface AuthState {
	token: string;
	exp: number; // epoch ms
}
interface InboxRow {
	id: number;
	queue_code?: string;
	visitor_display_name?: string;
	division_name?: string;
}

export class LivechatBotDO implements DurableObject {
	private ws: WebSocket | null = null;
	private socketReady = false;
	private connecting = false;
	private pendingToken = "";
	private ackSeq = 1;
	private pendingAcks = new Map<number, (v: unknown) => void>();
	private auth: AuthState | null = null;
	private inboxCache = new Map<string, InboxRow>();
	private lastInboxRefresh = 0;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/wake") {
			await this.ensureConnected();
			await this.rearmAlarm();
			return new Response(JSON.stringify({ ok: true, connected: this.socketReady }));
		}
		if (url.pathname === "/status") {
			return new Response(JSON.stringify({ ok: true, connected: this.socketReady, inboxCached: this.inboxCache.size }));
		}
		return new Response("not found", { status: 404 });
	}

	async alarm(): Promise<void> {
		await this.ensureConnected();
		if (Date.now() - this.lastInboxRefresh > 60_000) await this.refreshInbox().catch((e) => console.error("livechat inbox refresh", e));
		await this.firePendingReplies();
	}

	// ===================== Auth (login JWT ke DayLiveChat) =====================
	private async getToken(): Promise<string | null> {
		const now = Date.now();
		if (this.auth && this.auth.exp > now + 60_000) return this.auth.token;
		const stored = await this.ctx.storage.get<AuthState>("auth");
		if (stored && stored.exp > now + 60_000) {
			this.auth = stored;
			return stored.token;
		}
		const cred = await getCredential(this.env);
		if (!cred) return null;
		const resp = await fetch(DLC_ORIGIN + "/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json", ...DLC_BROWSER_HEADERS },
			body: JSON.stringify({ email: cred.email, password: cred.password }),
		});
		if (!resp.ok) {
			console.error("livechat login gagal", resp.status, await resp.text().catch(() => ""));
			return null;
		}
		const data = (await resp.json()) as { token?: string };
		if (!data.token) return null;
		let exp = now + 20 * 3600 * 1000;
		try {
			const payloadB64 = data.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
			const payload = JSON.parse(atob(payloadB64)) as { exp?: number };
			if (payload.exp) exp = payload.exp * 1000;
		} catch {
			/* pakai fallback 20 jam kalau payload JWT tidak terbaca */
		}
		this.auth = { token: data.token, exp };
		await this.ctx.storage.put("auth", this.auth);
		return data.token;
	}

	// ===================== Socket.IO v4 minimal di atas WebSocket Workers =====================
	private async ensureConnected(): Promise<void> {
		if (this.socketReady || this.connecting) return;
		this.connecting = true;
		try {
			const token = await this.getToken();
			if (!token) return; // belum ada kredensial CS tersimpan -- diam, tunggu di-set lewat panel
			this.pendingToken = token;
			const resp = await fetch(DLC_ORIGIN + "/socket.io/?EIO=4&transport=websocket", {
				headers: { Upgrade: "websocket", ...DLC_BROWSER_HEADERS },
			});
			const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
			if (!ws) throw new Error("Server tidak meng-upgrade koneksi ke WebSocket");
			ws.accept();
			this.ws = ws;
			ws.addEventListener("message", (ev: MessageEvent) => this.onSocketMessage(String(ev.data)));
			ws.addEventListener("close", () => this.onSocketClosed());
			ws.addEventListener("error", () => this.onSocketClosed());
		} catch (e) {
			console.error("livechat DO connect error", e instanceof Error ? e.message : e);
			await this.scheduleAt("__reconnect", Date.now() + 5000);
		} finally {
			this.connecting = false;
		}
	}

	private onSocketClosed(): void {
		this.socketReady = false;
		this.ws = null;
		this.scheduleAt("__reconnect", Date.now() + 5000).catch(() => {});
	}

	private onSocketMessage(data: string): void {
		if (data === "2") {
			// Engine.IO PING dari server -- WAJIB dibalas PONG cepat, kalau tidak
			// server anggap koneksi mati (pingTimeout) & putuskan.
			this.ws?.send("3");
			return;
		}
		if (data[0] === "0") {
			// Engine.IO OPEN (handshake baru terbentuk) -- lanjut kirim paket
			// Socket.IO CONNECT berisi auth token (format v4: auth dikirim di
			// paket CONNECT, bukan di query string).
			this.ws?.send("40" + JSON.stringify({ token: this.pendingToken }));
			return;
		}
		if (data.startsWith("44")) {
			// CONNECT_ERROR (biasanya auth token ditolak) -- paksa login ulang.
			console.error("livechat DO socket connect_error", data);
			this.socketReady = false;
			this.auth = null;
			this.ws?.close();
			return;
		}
		if (data.startsWith("40")) {
			this.socketReady = true;
			this.refreshInbox().catch((e) => console.error("livechat inbox refresh awal", e));
			return;
		}
		if (data.startsWith("43")) {
			const m = data.slice(2).match(/^(\d+)(\[.*\])$/s);
			if (!m) return;
			const id = Number(m[1]);
			const resolver = this.pendingAcks.get(id);
			if (resolver) {
				resolver(JSON.parse(m[2]));
				this.pendingAcks.delete(id);
			}
			return;
		}
		if (data.startsWith("42")) {
			const m = data.slice(2).match(/^(\d+)?(\[.*\])$/s);
			if (!m) return;
			try {
				const [eventName, payload] = JSON.parse(m[2]) as [string, unknown];
				this.handleEvent(eventName, payload).catch((e) => console.error("livechat handleEvent error", e));
			} catch {
				/* payload event tidak valid -- abaikan */
			}
		}
	}

	private emit(event: string, payload: unknown): Promise<any> {
		return new Promise((resolve) => {
			if (!this.ws || !this.socketReady) {
				resolve(null);
				return;
			}
			const id = this.ackSeq++;
			this.pendingAcks.set(id, resolve);
			this.ws.send("42" + id + JSON.stringify([event, payload]));
			setTimeout(() => {
				if (this.pendingAcks.has(id)) {
					this.pendingAcks.delete(id);
					resolve(null);
				}
			}, 8000);
		});
	}

	// ===================== Data chat (REST, dipakai buat lengkapi tampilan panel) =====================
	private async refreshInbox(): Promise<void> {
		const token = await this.getToken();
		if (!token) return;
		const resp = await fetch(DLC_ORIGIN + "/api/chats/inbox", { headers: { Authorization: "Bearer " + token, ...DLC_BROWSER_HEADERS } });
		if (!resp.ok) {
			console.error("livechat inbox gagal", resp.status);
			return;
		}
		const rows = (await resp.json()) as InboxRow[];
		this.lastInboxRefresh = Date.now();
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			const key = String(row.id);
			this.inboxCache.set(key, row);
			await upsertSessionSeen(this.env, {
				sessionKey: key,
				queueCode: row.queue_code || "",
				customerName: row.visitor_display_name || row.queue_code || key,
				divisi: row.division_name || "",
			});
		}
	}

	// ===================== Event masuk dari DayLiveChat =====================
	private async handleEvent(eventName: string, payload: unknown): Promise<void> {
		if (eventName !== "chat:new_message") return;
		const msg = payload as { chat_id?: number; sender_type?: string; content?: string };
		if (msg.chat_id == null) return;
		const chatId = String(msg.chat_id);
		const cached = this.inboxCache.get(chatId);
		await upsertSessionSeen(this.env, {
			sessionKey: chatId,
			queueCode: cached?.queue_code || "",
			customerName: cached?.visitor_display_name || cached?.queue_code || chatId,
			divisi: cached?.division_name || "",
			lastMessage: String(msg.content || "").slice(0, 500),
			lastSender: msg.sender_type || "",
		});
		// Bot ini KHUSUS membalas pesan dari MEMBER (visitor), dan HANYA untuk
		// sesi yang operator sudah nyalakan switch-nya di panel -- sesi lain
		// tetap 100% dibalas manual oleh CS.
		if (msg.sender_type !== "member") return;
		if (!(await isSessionBotEnabled(this.env, chatId))) return;
		await this.registerVisitorMessage(chatId);
	}

	// ===================== Logika toleransi 30 detik / spam 15 detik =====================
	private async registerVisitorMessage(chatId: string): Promise<void> {
		const now = Date.now();
		const key = "burst:" + chatId;
		const b: BurstState = (await this.ctx.storage.get<BurstState>(key)) || { count: 0, lastMsgAt: 0, lastReplyAt: 0 };
		if (b.lastMsgAt && now - b.lastMsgAt > BURST_RESET_MS) b.count = 0;
		b.count += 1;
		b.lastMsgAt = now;
		await this.ctx.storage.put(key, b);

		if (b.count >= 2) {
			const nextAllowed = b.lastReplyAt ? b.lastReplyAt + SPAM_INTERVAL_MS : now;
			await this.scheduleAt(chatId, Math.max(now, nextAllowed));
		} else {
			await this.scheduleAt(chatId, now + GRACE_MS);
		}
	}

	private async scheduleAt(tag: string, when: number): Promise<void> {
		const pending = (await this.ctx.storage.get<Record<string, number>>("pending")) || {};
		const existing = pending[tag];
		if (existing == null || when < existing) {
			pending[tag] = when;
			await this.ctx.storage.put("pending", pending);
		}
		await this.rearmAlarm();
	}

	private async rearmAlarm(): Promise<void> {
		const pending = (await this.ctx.storage.get<Record<string, number>>("pending")) || {};
		const times = Object.values(pending);
		if (!times.length) return;
		const min = Math.min(...times);
		const current = await this.ctx.storage.getAlarm();
		if (current == null || min < current) await this.ctx.storage.setAlarm(min);
	}

	/** Dipanggil dari alarm(): proses semua sesi yang sudah waktunya dicek/dibalas. */
	private async firePendingReplies(): Promise<void> {
		const now = Date.now();
		const pending = (await this.ctx.storage.get<Record<string, number>>("pending")) || {};
		const due = Object.keys(pending).filter((k) => pending[k] <= now);
		for (const tag of due) {
			delete pending[tag];
			if (tag === "__reconnect") continue; // sudah ditangani ensureConnected() di awal alarm()
			const enabled = await isSessionBotEnabled(this.env, tag);
			if (!enabled) continue;
			const b: BurstState = (await this.ctx.storage.get<BurstState>("burst:" + tag)) || { count: 0, lastMsgAt: 0, lastReplyAt: 0 };
			if (b.count >= 2) {
				const nextAllowed = b.lastReplyAt ? b.lastReplyAt + SPAM_INTERVAL_MS : now;
				if (now >= nextAllowed) {
					await this.sendAutoReply(tag);
				} else {
					pending[tag] = nextAllowed; // dijadwalkan ulang tanpa mengubah state lain
				}
			} else if (b.count === 1) {
				await this.sendAutoReply(tag);
			}
		}
		await this.ctx.storage.put("pending", pending);
		await this.rearmAlarm();
	}

	private async sendAutoReply(chatId: string): Promise<void> {
		const templates = await listActiveTemplates(this.env);
		const tpl = pickRandomTemplate(templates);
		if (!tpl) return; // tidak ada template aktif tersimpan -- diam, jangan kirim apa pun
		await this.ensureConnected();
		if (!this.socketReady) return; // akan dicoba lagi siklus berikutnya (scheduleAt tetap ada)
		const ack = await this.emit("cs:message", { chat_id: Number(chatId), content: tpl.reply_text });
		if (Array.isArray(ack) && ack[0] && (ack[0] as { error?: string }).error) {
			console.error("livechat DO gagal kirim balasan", ack[0]);
			return;
		}
		const now = Date.now();
		const key = "burst:" + chatId;
		const b: BurstState = (await this.ctx.storage.get<BurstState>(key)) || { count: 0, lastMsgAt: 0, lastReplyAt: 0 };
		b.lastReplyAt = now;
		await this.ctx.storage.put(key, b);
		await logAutoReply(this.env, chatId, "", tpl.id, tpl.reply_text);
		await getTurso(this.env)
			.prepare(`UPDATE livechat_session SET last_message = ?, last_sender = 'bot' WHERE session_key = ?`)
			.bind(tpl.reply_text.slice(0, 500), chatId)
			.run();
	}
}
