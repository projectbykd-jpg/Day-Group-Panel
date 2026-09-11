// Build panel-worker/public/index.html from the legacy Apps Script HTML files.
// - Index.html  : page shell, contains <?!= include('Styles') ?> and <?!= include('Scripts') ?>
// - Styles.html : <style>...</style>
// - Scripts.html: <script>...</script>  (uses google.script.run)
//
// We inline Styles + Scripts and prepend a google.script.run -> fetch('/api') shim.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = (name) => readFileSync(resolve(root, "ui-src", name), "utf8");

const indexHtml = src("Index.html");
const stylesHtml = src("Styles.html");
const scriptsHtml = src("Scripts.html");

// Positional-arg -> /api body-field mapping, keyed by function name.
const ARG_MAP = {
	checkLogin: ["username", "password"],
	resumeSession: ["token"],
	logout: ["token"],
	logoutSession: ["token"],
	getBootstrapData: ["token"],
	getDashboardData: ["token", "options"],
	getLivePanelData: ["token", "opts"],
	getCurrentUserProfile: ["token"],
	logClientActivity: ["token", "act", "detail", "status", "content"],
	smartAutoSendFast: ["rawText", "token"],
	retryFailedSystem: ["rawText", "token", "systemName", "website"],
	sendToPanelZOnly: ["market", "angka", "token"],
	adminListUsers: ["token"],
	adminSaveUser: ["token", "data"],
	adminDeleteUser: ["token", "targetUsername"],
	adminResetUserLock: ["token", "targetUsername"],
	adminListActiveSessions: ["token"],
	setMaintenance: ["token", "enabled", "message"],
	adminListSites: ["token"],
	adminSaveSite: ["token", "data"],
	adminDeleteSite: ["token", "website"],
	// --- belum di-port ke Worker (prediksi & invest) — dipetakan supaya siap dipakai nanti
	getPredictionStatusData: ["token"],
	generateClosingPredictionCopy: ["token", "slot"],
	sendClosingPredictionAuto: ["token", "websites", "slot"],
	generatePredictionCopyBundle: ["index", "token"],
	sendPredictionAuto: ["index", "token", "websites"],
	adminRunActivityBackup: ["token"],
	setupAutoPostTriggers: ["token"],
	adminGetAutoPostWebhook: ["token"],
	adminSetAutoPost: ["token", "enabled"],
	adminRunAutoPostNow: ["token"],
	setupActivityBackupTrigger: ["token"],
	investGetConfig: ["token"],
	investSaveConfig: ["token", "payload"],
	investTestSession: ["token"],
	investStartScan: ["token"],
	investContinueScan: ["token"],
	investResetScan: ["token"],
	investGetStatus: ["token"],
	investGetWarnings: ["token"],
	lapGetConfig: ["token"],
	lapSaveConfig: ["token", "data"],
	lapRunMotion: ["token", "startDate", "endDate"],
	lapRunMozart: ["token", "startDate", "endDate", "opts"],
	lapRunAdmin: ["token", "startDate", "endDate"],
	lapMozartImport: ["token", "startDate", "endDate", "depositRows", "withdrawRows", "accountsRaw", "panelsRaw"],
	lapAdminStatus: ["token", "jobId"],
	botNewsStatus: ["token"],
	botNewsSaveConfig: ["token", "data"],
	botNewsAddSource: ["token", "data"],
	botNewsToggleSource: ["token", "data"],
	botNewsDeleteSource: ["token", "data"],
	botNewsRunNow: ["token", "count"],
	botNewsSkip: ["token", "data"],
};

const shim = `<script>
/* ==== google.script.run -> fetch('/api') shim (panel-worker) ==== */
(function () {
  var API = "/api";
  var ARG_MAP = ${JSON.stringify(ARG_MAP)};
  function call(fn, args, onOk, onErr) {
    var body = { action: fn };
    var names = ARG_MAP[fn];
    if (names) {
      for (var i = 0; i < names.length; i++) body[names[i]] = args[i];
    } else {
      body._args = Array.prototype.slice.call(args);
    }
    fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var data;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        (onOk || function () {})(data);
      })
      .catch(function (e) {
        (onErr || function () {})(e instanceof Error ? e : new Error(String(e)));
      });
  }
  function makeRunner(onOk, onErr) {
    return new Proxy(Object.create(null), {
      get: function (_t, prop) {
        if (prop === "withSuccessHandler") return function (cb) { return makeRunner(cb, onErr); };
        if (prop === "withFailureHandler") return function (cb) { return makeRunner(onOk, cb); };
        if (prop === "withUserObject") return function () { return makeRunner(onOk, onErr); };
        return function () { call(String(prop), arguments, onOk, onErr); };
      },
    });
  }
  var noop = function () {};
  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null),
    history: { push: noop, replace: noop, setChangeHandler: noop },
    host: { close: noop, setHeight: noop, origin: "", editor: { focus: noop } },
    url: { getLocation: function (cb) { cb && cb({ parameter: {}, parameters: {}, hash: "" }); } },
  };
})();
</script>`;

// --- Tailwind: compile sekali di sini -> CSS statis di-inline.
// Play CDN (cdn.tailwindcss.com) meng-compile ulang di browser tiap kali DOM
// berubah (panel ini sering rebuild innerHTML) -> berat & lag. Versi statis
// tidak punya MutationObserver / runtime compiler.
function buildTailwind() {
	const cli = resolve(root, "node_modules", "tailwindcss", "lib", "cli.js");
	if (!existsSync(cli)) {
		console.warn("WARNING: tailwindcss belum ter-install -> pakai Play CDN (lebih lambat). Jalankan `npm install`.");
		return null;
	}
	const outCss = resolve(root, "public", "_tw.css");
	mkdirSync(dirname(outCss), { recursive: true });
	execFileSync(
		process.execPath,
		[cli, "-c", resolve(root, "tailwind.config.js"), "-i", resolve(root, "ui-src", "tw.css"), "-o", outCss, "--minify"],
		{ cwd: root, stdio: ["ignore", "ignore", "inherit"] },
	);
	return readFileSync(outCss, "utf8");
}
const tailwindCss = buildTailwind();

let out = indexHtml;
if (tailwindCss) {
	// buang Play CDN + preconnect-nya, ganti dengan <style> hasil compile
	out = out.replace(/\s*<link rel="preconnect" href="https:\/\/cdn\.tailwindcss\.com">/, "");
	out = out.replace(/\s*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, "");
	// PENTING: Tailwind di-inline SESUDAH Styles.html (custom CSS), meniru urutan
	// Play CDN yang meng-inject <style>-nya paling akhir. Kalau ditaruh sebelum
	// Styles.html, rule custom dengan specificity sama menang atas utility Tailwind
	// -> layout header/dll berantakan.
	out = out.replace(
		/<\?!?=?\s*include\(\s*['"]Styles['"]\s*\)\s*;?\s*\?>/,
		stylesHtml + `\n<style id="tw-base">\n${tailwindCss}\n</style>`,
	);
} else {
	out = out.replace(/<\?!?=?\s*include\(\s*['"]Styles['"]\s*\)\s*;?\s*\?>/, stylesHtml);
}
out = out.replace(/<\?!?=?\s*include\(\s*['"]Scripts['"]\s*\)\s*;?\s*\?>/, shim + "\n" + scriptsHtml);

// safety: buang scriptlet Apps Script lain kalau ada
out = out.replace(/<\?!?=?[\s\S]*?\?>/g, "");

if (/<\?/.test(out) || /include\(/.test(out)) {
	console.warn("WARNING: sisa scriptlet Apps Script masih ada di output.");
}

const outDir = resolve(root, "public");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), out, "utf8");
console.log("OK -> public/index.html (" + out.length + " bytes)");
