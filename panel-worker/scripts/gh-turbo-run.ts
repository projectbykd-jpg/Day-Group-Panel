// Dijalankan lewat GitHub Actions (BUKAN Cloudflare Worker) -- panggil ULANG
// botNewsRun() ASLI dari src/lib/bot-news.ts, TIDAK ADA logic yang
// diduplikasi/ditulis ulang di sini sama sekali (biar tidak pernah ketinggalan
// kalau bot-news.ts diubah lagi nanti). Alasan file ini ada: Cloudflare Worker
// Free plan cuma boleh 50 subrequest/invocation, jadi satu kali panggil
// botNewsRun() dibatasi ketat. GitHub Actions TIDAK punya limit semacam itu --
// jadi di sini botNewsRun() dipanggil BERULANG KALI dalam 1 kali jalan job.
//
// Dua mode:
// 1. Terjadwal (RUN_COUNT kosong, tiap 10 menit) -- loop sampai antrean 'new'
//    habis / daily_cap Blogger kena, pakai per_run/site_per_run dari
//    Konfigurasi Lanjutan (panel) persis seperti yang pemilik atur.
// 2. Dipicu tombol panel dengan angka custom (RUN_COUNT terisi) -- proses
//    TEPAT sejumlah itu (Blogger & Situs Sendiri masing-masing), lalu
//    berhenti, TIDAK peduli per_run/site_per_run tersimpan.
//
// Cara pakai: `npx tsx scripts/gh-turbo-run.ts` dengan env TURSO_URL &
// TURSO_TOKEN ter-set (lihat .github/workflows/news-turbo.yml).
import { botCfg, botCfgSet, botNewsRun } from "../src/lib/bot-news";

const env = {
	TURSO_URL: process.env.TURSO_URL,
	TURSO_TOKEN: process.env.TURSO_TOKEN,
} as any;

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);
const runCountRaw = String(process.env.RUN_COUNT || "").trim();
const runCount = runCountRaw ? Math.max(1, Math.floor(Number(runCountRaw))) : 0;
// "Send ke" dropdown di panel -- both (default) = Blogger + Situs Sendiri,
// atau salah satu saja. Dispatch terjadwal tiap 10 menit TIDAK pernah
// mengisi ini (selalu "both").
const runTarget = String(process.env.RUN_TARGET || "both").trim().toLowerCase();

/**
 * botNewsRun() SENGAJA mengunci opts.count ke maksimal 5/panggilan
 * (MAX_RUN_COUNT, lihat bot-news.ts) -- itu batas keamanan utk invocation
 * Cloudflare sinkron, TIDAK diubah di sini (jangan lemahkan pagar itu, masih
 * dipakai tombol manual "PROSES KE BLOGGER"/"PROSES KE SITUS SENDIRI" yang
 * lama). Jadi target custom besar (mis. 50) tetap harus dicicil per 5 --
 * di GitHub Actions ini AMAN diulang banyak kali (tidak ada limit
 * subrequest), beda dgn di Cloudflare.
 */
async function runLoop(mode: "blogger" | "site"): Promise<number> {
	const target = runCount || null; // null = tanpa batas total, ikut cfg + MAX_ROUNDS
	let total = 0;
	for (let i = 1; i <= MAX_ROUNDS; i++) {
		const remaining = target != null ? target - total : null;
		if (remaining != null && remaining <= 0) break;
		const opts: Parameters<typeof botNewsRun>[1] = { force: true, mode };
		if (remaining != null) opts.count = Math.min(5, remaining);
		const r = await botNewsRun(env, opts);
		const got = mode === "blogger" ? r.posted : r.siteOnly;
		const tag = target != null ? `custom target=${target}` : `${i}/${MAX_ROUNDS}`;
		console.log(`[${mode} ${tag}] got=${got} capped=${r.capped} :: ${r.message}`);
		total += got;
		if (mode === "blogger" && r.capped) break; // daily_cap Blogger tercapai
		if (got === 0) break; // antrean 'new' habis ATAU macet di error yang sama terus
	}
	return total;
}

async function main() {
	const url = String(process.env.TURSO_URL ?? "").trim();
	const token = String(process.env.TURSO_TOKEN ?? "").trim();
	if (!url || !token) {
		throw new Error("TURSO_URL / TURSO_TOKEN belum di-set sbg GitHub Actions secret (Settings > Secrets and variables > Actions).");
	}
	// Diagnostik AMAN (tidak membocorkan isi TURSO_TOKEN sama sekali, cuma
	// panjangnya) -- kejadian sebelumnya: TURSO_URL & TURSO_TOKEN kebalik atau
	// ikut ke-paste tanda kutip/spasi, dan pesan error Turso aslinya ("URL_INVALID")
	// tidak bilang secret MANA yang salah -- baris di bawah ini bikin ketahuan
	// dari log run mana yang keliru tanpa perlu buka nilai secret di GitHub.
	console.log(`[diag] TURSO_URL = "${url}" (harus diawali libsql:// atau https://)`);
	console.log(`[diag] TURSO_TOKEN panjang = ${token.length} karakter (JWT asli biasanya 150+)`);
	if (!/^(libsql|https?):\/\//i.test(url)) {
		throw new Error(`TURSO_URL sepertinya bukan URL Turso yang valid: "${url}". Cek lagi -- mungkin isinya kebalik/ketuker dengan TURSO_TOKEN.`);
	}
	if (token.length < 50) {
		throw new Error(`TURSO_TOKEN kependekan (${token.length} karakter) utk sebuah JWT asli -- cek lagi, mungkin ketuker dengan TURSO_URL atau ke-potong pas paste.`);
	}
	if (runCount) console.log(`[diag] RUN_COUNT custom = ${runCount} (dipicu tombol panel, bukan jadwal otomatis)`);
	if (runTarget !== "both") console.log(`[diag] RUN_TARGET custom = ${runTarget} (dipicu tombol panel, bukan jadwal otomatis)`);

	// PACING: workflow_dispatch (tombol panel / "Run workflow" manual) SELALU
	// jalan langsung, kapan pun diklik. Tapi trigger "schedule" (cron GitHub,
	// lihat news-turbo.yml -- di-set tiap 5 menit, granularitas terkecil yang
	// GitHub izinkan) HANYA benar-benar memproses kalau sudah lewat
	// "auto_interval_minutes" (field "Interval auto-post" di Setting, default
	// 10 menit) sejak proses OTOMATIS terakhir -- supaya jarak antar-posting
	// otomatis bisa diatur pemilik dari panel TANPA perlu ubah file workflow.
	const isSchedule = process.env.GITHUB_EVENT_NAME === "schedule";
	if (isSchedule) {
		const cfg = await botCfg(env);
		const intervalMin = Math.max(1, Number(cfg.auto_interval_minutes || "10"));
		const lastRunAt = Number(cfg.auto_last_run_ts || "0");
		const elapsedMin = (Date.now() - lastRunAt) / 60000;
		if (lastRunAt && elapsedMin < intervalMin) {
			console.log(`[diag] Lewat jadwal (interval ${intervalMin} menit), baru ${elapsedMin.toFixed(1)} menit sejak proses otomatis terakhir -- lewati run ini.`);
			return;
		}
		await botCfgSet(env, { auto_last_run_ts: String(Date.now()) });
		console.log(`[diag] Proses otomatis (interval ${intervalMin} menit) -- lanjut.`);
	}

	const posted = runTarget === "site" ? 0 : await runLoop("blogger");
	const siteOnly = runTarget === "blogger" ? 0 : await runLoop("site");
	console.log(`\n=== SELESAI: ${posted} artikel ke Blogger, ${siteOnly} artikel ke situs sendiri ===`);
}

main().catch((e) => {
	console.error("GAGAL:", e instanceof Error ? e.stack || e.message : e);
	process.exit(1);
});
