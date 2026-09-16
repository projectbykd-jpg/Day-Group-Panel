// ==UserScript==
// @name         DayLiveChat Auto-Reply Bot (Day-Group Panel)
// @namespace    daygroup-panel
// @version      1.0.0
// @description  Balas otomatis sesi chat DayLiveChat yang DIPILIH lewat Day-Group Panel (Live Chat > Sesi Chat). Sesi yang tidak diaktifkan tetap 100% manual.
// @author       Day-Group Panel
// @match        https://daylivechat.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      workers.dev
// @connect      daylivechat.com
// ==/UserScript==

(function () {
	"use strict";

	// ===================== Konfigurasi (disimpan lokal lewat Tampermonkey) =====================
	const CFG_KEY = "dgpanel_livechat_cfg_v1";
	const REPLIED_KEY = "dgpanel_livechat_replied_v1";

	function loadCfg() {
		let cfg = {};
		try {
			cfg = JSON.parse(GM_getValue(CFG_KEY, "{}")) || {};
		} catch (e) {
			cfg = {};
		}
		return Object.assign(
			{
				panelUrl: "https://panel-worker.projectbykd.workers.dev",
				botKey: "",
				masterOn: false,
				sel: { list: "", msgBox: "", customerBubble: "", input: "", sendBtn: "" },
			},
			cfg,
		);
	}
	function saveCfg(cfg) {
		GM_setValue(CFG_KEY, JSON.stringify(cfg));
	}
	let CFG = loadCfg();

	function loadRepliedMap() {
		try {
			return JSON.parse(GM_getValue(REPLIED_KEY, "{}")) || {};
		} catch (e) {
			return {};
		}
	}
	function saveRepliedMap(m) {
		// buang entri > 500 supaya storage tidak numpuk selamanya
		const keys = Object.keys(m);
		if (keys.length > 500) {
			keys
				.sort((a, b) => (m[a] || 0) - (m[b] || 0))
				.slice(0, keys.length - 500)
				.forEach((k) => delete m[k]);
		}
		GM_setValue(REPLIED_KEY, JSON.stringify(m));
	}
	let REPLIED = loadRepliedMap();

	function isCalibrated() {
		return !!(CFG.sel.list && CFG.sel.msgBox && CFG.sel.customerBubble && CFG.sel.input && CFG.sel.sendBtn);
	}

	// ===================== Panggilan ke Day-Group Panel (worker) =====================
	function apiCall(action, body) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: "POST",
				url: CFG.panelUrl.replace(/\/+$/, "") + "/api",
				headers: { "content-type": "application/json" },
				data: JSON.stringify(Object.assign({ action, key: CFG.botKey }, body || {})),
				timeout: 15000,
				onload: (r) => {
					try {
						resolve(JSON.parse(r.responseText));
					} catch (e) {
						reject(new Error("Respons panel tidak valid"));
					}
				},
				onerror: () => reject(new Error("Gagal menghubungi panel")),
				ontimeout: () => reject(new Error("Panel timeout")),
			});
		});
	}

	// ===================== Util: hash ringan (bukan kriptografi) buat dedupe pesan =====================
	function hashText(s) {
		let h = 0;
		s = String(s || "");
		for (let i = 0; i < s.length; i++) {
			h = (h * 31 + s.charCodeAt(i)) | 0;
		}
		return String(h);
	}
	function normText(s) {
		return String(s || "").replace(/\s+/g, " ").trim();
	}

	// ===================== Selector generator (dipakai mode kalibrasi) =====================
	// Menghasilkan selector CSS yang cukup stabil dari elemen yang diklik user --
	// diutamakan class asli elemen (Tailwind/utility class DayLiveChat tetap sama
	// antar reload, tidak di-hash random per sesi seperti CSS-module), fallback ke
	// jalur nth-child kalau class-nya tidak unik/tidak ada.
	function classSelector(el) {
		const cls = Array.from(el.classList || []).filter((c) => c && !/^(hover|focus|active|dark):/.test(c));
		if (!cls.length) return el.tagName.toLowerCase();
		return el.tagName.toLowerCase() + "." + cls.map((c) => CSS.escape(c)).join(".");
	}
	function buildSelector(el) {
		if (el.id) return "#" + CSS.escape(el.id);
		let sel = classSelector(el);
		try {
			if (document.querySelectorAll(sel).length === 1) return sel;
		} catch (e) {
			/* selector tidak valid (jarang) -> lanjut fallback path */
		}
		// fallback: jalur nth-child dari root sampai elemen (maks 6 level ke atas)
		const path = [];
		let node = el;
		for (let depth = 0; depth < 6 && node && node.nodeType === 1; depth++) {
			const parent = node.parentElement;
			if (!parent) {
				path.unshift(node.tagName.toLowerCase());
				break;
			}
			const idx = Array.from(parent.children).indexOf(node) + 1;
			path.unshift(node.tagName.toLowerCase() + ":nth-child(" + idx + ")");
			node = parent;
		}
		return path.join(" > ");
	}

	// ===================== Mode kalibrasi (picker) =====================
	let pickerActive = false;
	let pickerCallback = null;
	let pickerHighlight = null;

	function ensureHighlightEl() {
		if (pickerHighlight) return pickerHighlight;
		pickerHighlight = document.createElement("div");
		pickerHighlight.style.cssText =
			"position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #22d3ee;background:rgba(34,211,238,.15);border-radius:6px;transition:all .05s linear;display:none;";
		document.documentElement.appendChild(pickerHighlight);
		return pickerHighlight;
	}
	function onPickerMove(e) {
		const hl = ensureHighlightEl();
		const r = e.target.getBoundingClientRect();
		hl.style.display = "block";
		hl.style.left = r.left + "px";
		hl.style.top = r.top + "px";
		hl.style.width = r.width + "px";
		hl.style.height = r.height + "px";
	}
	function onPickerClick(e) {
		e.preventDefault();
		e.stopPropagation();
		stopPicker();
		if (pickerCallback) pickerCallback(e.target);
	}
	function startPicker(cb) {
		pickerActive = true;
		pickerCallback = cb;
		document.addEventListener("mousemove", onPickerMove, true);
		document.addEventListener("click", onPickerClick, true);
		document.body.style.cursor = "crosshair";
	}
	function stopPicker() {
		pickerActive = false;
		document.removeEventListener("mousemove", onPickerMove, true);
		document.removeEventListener("click", onPickerClick, true);
		document.body.style.cursor = "";
		if (pickerHighlight) pickerHighlight.style.display = "none";
	}

	// ===================== Widget mengambang (UI) =====================
	const style = document.createElement("style");
	style.textContent = `
		#dgb-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:56px;height:56px;border-radius:50%;
			background:linear-gradient(135deg,#22d3ee,#2563eb);display:flex;align-items:center;justify-content:center;
			box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer;font-size:24px;user-select:none;}
		#dgb-fab.on{background:linear-gradient(135deg,#34d399,#10b981);}
		#dgb-panel{position:fixed;right:18px;bottom:84px;z-index:2147483000;width:340px;max-height:70vh;overflow-y:auto;
			background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:14px;
			font:12px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);display:none;}
		#dgb-panel.open{display:block;}
		#dgb-panel h4{margin:0 0 8px;font-size:13px;font-weight:800;color:#67e8f9;}
		#dgb-panel label{display:block;margin:8px 0 3px;font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
		#dgb-panel input[type=text],#dgb-panel input[type=password]{width:100%;box-sizing:border-box;background:#1e293b;
			border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:7px 9px;color:#fff;font-size:12px;}
		#dgb-panel .row{display:flex;gap:6px;align-items:center;margin:4px 0;}
		#dgb-panel button{background:#1e293b;border:1px solid rgba(255,255,255,.1);color:#e2e8f0;border-radius:8px;
			padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;}
		#dgb-panel button.ok{color:#34d399;border-color:rgba(52,211,153,.3);}
		#dgb-panel button.primary{background:linear-gradient(135deg,#22d3ee,#2563eb);color:#04121f;border:none;width:100%;padding:9px;margin-top:10px;}
		#dgb-panel .dot{width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block;margin-right:5px;}
		#dgb-panel .dot.ok{background:#34d399;}
		#dgb-log{margin-top:8px;max-height:120px;overflow-y:auto;font-size:10px;color:#94a3b8;border-top:1px solid rgba(255,255,255,.08);padding-top:6px;}
		#dgb-log div{margin-bottom:3px;}
	`;
	document.documentElement.appendChild(style);

	const fab = document.createElement("div");
	fab.id = "dgb-fab";
	fab.title = "Auto-Reply Bot (Day-Group Panel)";
	fab.textContent = "🤖";
	document.documentElement.appendChild(fab);

	const panel = document.createElement("div");
	panel.id = "dgb-panel";
	panel.innerHTML = `
		<h4>🤖 Auto-Reply Bot</h4>
		<label>URL Panel</label>
		<input type="text" id="dgb-url" placeholder="https://panel-worker.projectbykd.workers.dev">
		<label>Kunci Bot (LIVECHAT_BOT_KEY)</label>
		<input type="password" id="dgb-key" placeholder="minta ke admin">
		<div class="row" style="margin-top:10px;">
			<span class="dot" id="dgb-dot-master"></span><b id="dgb-master-label">NONAKTIF</b>
			<button id="dgb-toggle-master" style="margin-left:auto;">Nyalakan</button>
		</div>
		<label>Kalibrasi elemen halaman</label>
		<div class="row"><span class="dot" id="dgb-dot-list"></span>Daftar sesi (Kotak Masuk)<button data-pick="list" style="margin-left:auto;">Pilih</button></div>
		<div class="row"><span class="dot" id="dgb-dot-msgBox"></span>Kotak pesan chat<button data-pick="msgBox" style="margin-left:auto;">Pilih</button></div>
		<div class="row"><span class="dot" id="dgb-dot-customerBubble"></span>Contoh bubble pesan CUSTOMER<button data-pick="customerBubble" style="margin-left:auto;">Pilih</button></div>
		<div class="row"><span class="dot" id="dgb-dot-input"></span>Kotak ketik balasan<button data-pick="input" style="margin-left:auto;">Pilih</button></div>
		<div class="row"><span class="dot" id="dgb-dot-sendBtn"></span>Tombol Kirim<button data-pick="sendBtn" style="margin-left:auto;">Pilih</button></div>
		<button class="primary" id="dgb-save">Simpan Pengaturan</button>
		<div id="dgb-status" style="margin-top:8px;color:#94a3b8;"></div>
		<div id="dgb-log"></div>
	`;
	document.documentElement.appendChild(panel);

	function log(msg) {
		const box = document.getElementById("dgb-log");
		if (!box) return;
		const line = document.createElement("div");
		line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
		box.prepend(line);
		while (box.children.length > 30) box.removeChild(box.lastChild);
	}

	function refreshPanelUI() {
		document.getElementById("dgb-url").value = CFG.panelUrl || "";
		document.getElementById("dgb-key").value = CFG.botKey || "";
		["list", "msgBox", "customerBubble", "input", "sendBtn"].forEach((k) => {
			const dot = document.getElementById("dgb-dot-" + k);
			if (dot) dot.classList.toggle("ok", !!CFG.sel[k]);
		});
		const masterDot = document.getElementById("dgb-dot-master");
		const masterLabel = document.getElementById("dgb-master-label");
		const masterBtn = document.getElementById("dgb-toggle-master");
		if (masterDot) masterDot.classList.toggle("ok", !!CFG.masterOn);
		if (masterLabel) masterLabel.textContent = CFG.masterOn ? "AKTIF" : "NONAKTIF";
		if (masterBtn) masterBtn.textContent = CFG.masterOn ? "Matikan" : "Nyalakan";
		fab.classList.toggle("on", !!CFG.masterOn);
		const statusEl = document.getElementById("dgb-status");
		if (statusEl) statusEl.textContent = isCalibrated() ? "Kalibrasi lengkap." : "Kalibrasi belum lengkap -- lengkapi 5 langkah di atas dulu.";
	}

	fab.addEventListener("click", () => {
		panel.classList.toggle("open");
		if (panel.classList.contains("open")) refreshPanelUI();
	});

	panel.querySelectorAll("button[data-pick]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const key = btn.getAttribute("data-pick");
			panel.classList.remove("open");
			log("Kalibrasi: klik elemen '" + key + "' di halaman...");
			startPicker((el) => {
				CFG.sel[key] = buildSelector(el);
				saveCfg(CFG);
				panel.classList.add("open");
				refreshPanelUI();
				log("Kalibrasi '" + key + "' tersimpan: " + CFG.sel[key]);
			});
		});
	});

	document.getElementById("dgb-save").addEventListener("click", () => {
		CFG.panelUrl = document.getElementById("dgb-url").value.trim() || CFG.panelUrl;
		CFG.botKey = document.getElementById("dgb-key").value.trim();
		saveCfg(CFG);
		refreshPanelUI();
		log("Pengaturan disimpan.");
	});

	document.getElementById("dgb-toggle-master").addEventListener("click", () => {
		if (!isCalibrated()) {
			log("Lengkapi kalibrasi dulu sebelum menyalakan bot.");
			return;
		}
		CFG.masterOn = !CFG.masterOn;
		saveCfg(CFG);
		refreshPanelUI();
		log(CFG.masterOn ? "Bot dinyalakan." : "Bot dimatikan.");
	});

	// ===================== Ekstraksi sesi & pesan dari DOM =====================
	function getRowIdentity(row) {
		// Coba beberapa atribut umum dulu (dipakai kalau framework halaman
		// menaruh id sesi di data-attribute) -- kalau tidak ada, teks baris ini
		// (nama + kode tiket, mis. "HUGO-20260916-111") sudah cukup unik & stabil.
		const attrCandidates = ["data-id", "data-session-id", "data-chat-id", "data-key", "data-session"];
		for (const a of attrCandidates) {
			const v = row.getAttribute && row.getAttribute(a);
			if (v) return "attr:" + a + ":" + v;
			const inner = row.querySelector && row.querySelector("[" + a + "]");
			if (inner) return "attr:" + a + ":" + inner.getAttribute(a);
		}
		return "text:" + normText(row.textContent).slice(0, 80);
	}

	function scanSessions() {
		if (!CFG.sel.list) return [];
		const listEl = document.querySelector(CFG.sel.list);
		if (!listEl) return [];
		// listEl bisa jadi hasil kalibrasi berupa SATU BARIS (bukan wadahnya) --
		// kalau begitu, ambil parent-nya & pakai signature class listEl sendiri
		// utk menemukan baris-baris sejenis.
		const container = listEl.parentElement || listEl;
		const sig = classSelector(listEl);
		let rows = [];
		try {
			rows = Array.from(container.querySelectorAll(":scope > " + sig));
		} catch (e) {
			rows = [];
		}
		if (!rows.length) rows = [listEl];
		return rows.map((row) => ({
			row,
			key: getRowIdentity(row),
			label: normText(row.textContent).slice(0, 200),
		}));
	}

	function isCustomerBubble(bubble) {
		if (!CFG.sel.customerBubble) return false;
		const sampleSig = classSelector(document.querySelector(CFG.sel.customerBubble) || bubble);
		const sampleClasses = new Set(sampleSig.split(".").slice(1));
		const bubbleClasses = new Set(Array.from(bubble.classList || []));
		if (!sampleClasses.size) return false;
		let overlap = 0;
		sampleClasses.forEach((c) => {
			if (bubbleClasses.has(c)) overlap++;
		});
		return overlap / sampleClasses.size >= 0.6;
	}

	// Pesan yang PALING BAWAH di kotak chat menentukan apakah masih perlu
	// dibalas: kalau paling bawah sudah bubble AGENT (CS), berarti sudah
	// terjawab -> tidak ada yang perlu di-auto-reply. Kalau paling bawah masih
	// bubble CUSTOMER, itulah pesan yang harus dibalas bot.
	function readLastCustomerMessage() {
		if (!CFG.sel.msgBox) return null;
		const box = document.querySelector(CFG.sel.msgBox);
		if (!box) return null;
		const bubbles = Array.from(box.querySelectorAll("*")).filter((el) => el.children.length <= 3 && normText(el.textContent));
		if (!bubbles.length) return null;
		const last = bubbles[bubbles.length - 1];
		return isCustomerBubble(last) ? normText(last.textContent) : null;
	}

	function setNativeValue(el, value) {
		const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
		const desc = Object.getOwnPropertyDescriptor(proto, "value");
		if (desc && desc.set) desc.set.call(el, value);
		else el.value = value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}

	function sendReply(text) {
		const input = document.querySelector(CFG.sel.input);
		const btn = document.querySelector(CFG.sel.sendBtn);
		if (!input || !btn) return false;
		input.focus();
		setNativeValue(input, text);
		btn.click();
		return true;
	}

	// ===================== Pencocokan template =====================
	function matchTemplate(category, text, templates) {
		const t = String(text || "").toLowerCase();
		const cat = String(category || "").toLowerCase();
		let fallback = null;
		for (const tpl of templates) {
			const tplCat = String(tpl.category || "").toLowerCase();
			const tplKeywords = String(tpl.keyword || "")
				.split(",")
				.map((k) => k.trim().toLowerCase())
				.filter(Boolean);
			if (!tplKeywords.length && !tplCat) {
				if (!fallback) fallback = tpl;
				continue;
			}
			if (tplCat && cat && tplCat !== cat) continue;
			if (tplKeywords.length && !tplKeywords.some((k) => t.includes(k))) continue;
			if (tplKeywords.length || tplCat) return tpl;
		}
		return fallback;
	}

	// ===================== Loop utama =====================
	let enabledKeys = [];
	let templates = [];
	let currentOpenKey = null;
	let robinIndex = 0;
	let busy = false;

	async function syncTick() {
		try {
			const sessions = scanSessions();
			if (sessions.length) {
				await apiCall("livechatBotSync", {
					rows: sessions.map((s) => ({ sessionKey: s.key, customerName: s.label, unread: false })),
				});
			}
			const pull = await apiCall("livechatBotPull", {});
			if (pull && pull.success) {
				enabledKeys = pull.enabledKeys || [];
				templates = pull.templates || [];
			}
		} catch (e) {
			log("Sync gagal: " + (e && e.message ? e.message : e));
		}
	}

	async function actionTick() {
		if (busy || !CFG.masterOn || !isCalibrated() || !enabledKeys.length) return;
		busy = true;
		try {
			const sessions = scanSessions();
			if (!sessions.length) return;
			robinIndex = (robinIndex + 1) % sessions.length;
			// cari sesi bot_enabled berikutnya secara round-robin supaya semua
			// sesi aktif kebagian giliran dicek, bukan cuma sesi pertama terus.
			let target = null;
			for (let i = 0; i < sessions.length; i++) {
				const s = sessions[(robinIndex + i) % sessions.length];
				if (enabledKeys.includes(s.key)) {
					target = s;
					robinIndex = (robinIndex + i) % sessions.length;
					break;
				}
			}
			if (!target) return;
			if (currentOpenKey !== target.key) {
				target.row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				currentOpenKey = target.key;
				await new Promise((r) => setTimeout(r, 700));
			}
			const lastMsg = readLastCustomerMessage();
			if (!lastMsg) return;
			const msgHash = target.key + "::" + hashText(lastMsg);
			if (REPLIED[msgHash]) return;
			const tpl = matchTemplate("", lastMsg, templates);
			if (!tpl) {
				log("Sesi '" + target.label.slice(0, 40) + "': tidak ada template cocok, dilewati (tetap manual).");
				REPLIED[msgHash] = Date.now();
				saveRepliedMap(REPLIED);
				return;
			}
			const ok = sendReply(tpl.reply_text);
			if (ok) {
				REPLIED[msgHash] = Date.now();
				saveRepliedMap(REPLIED);
				log("Auto-balas terkirim ke '" + target.label.slice(0, 40) + "'.");
				apiCall("livechatBotReport", {
					sessionKey: target.key,
					customerMessage: lastMsg,
					matchedTemplateId: tpl.id || null,
					replyText: tpl.reply_text,
				}).catch(() => {});
			}
		} catch (e) {
			log("Aksi gagal: " + (e && e.message ? e.message : e));
		} finally {
			busy = false;
		}
	}

	refreshPanelUI();
	setInterval(syncTick, 8000);
	setInterval(actionTick, 4000);
	syncTick();
})();
