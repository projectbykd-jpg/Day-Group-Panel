// Dijalankan lewat GitHub Actions cron (BUKAN Cloudflare Worker) -- panggil
// ULANG botNewsRun() ASLI dari src/lib/bot-news.ts, TIDAK ADA logic yang
// diduplikasi/ditulis ulang di sini sama sekali (biar tidak pernah ketinggalan
// kalau bot-news.ts diubah lagi nanti). Alasan file ini ada: Cloudflare Worker
// Free plan cuma boleh 50 subrequest/invocation, jadi satu kali panggil
// botNewsRun() dibatasi ketat (count maks 5). GitHub Actions TIDAK punya
// limit semacam itu -- jadi di sini botNewsRun() dipanggil BERULANG KALI
// dalam 1 kali jalan job, sampai antrean 'new' habis atau daily_cap Blogger
// kena, supaya semua backlog bisa kepublish dalam satu run cepat.
//
// Cara pakai: `npx tsx scripts/gh-turbo-run.ts` dengan env TURSO_URL &
// TURSO_TOKEN ter-set (lihat .github/workflows/news-turbo.yml).
import { botNewsRun } from "../src/lib/bot-news";

const env = {
	TURSO_URL: process.env.TURSO_URL,
	TURSO_TOKEN: process.env.TURSO_TOKEN,
} as any;

// MAX_RUN_COUNT di botNewsRun mengunci count per panggilan ke maksimal 5 --
// bukan bug, itu batas per-invocation Cloudflare yang TIDAK relevan di sini,
// tapi kita tetap ikuti angkanya (kirim count>5 percuma, tetap diclamp jadi 5)
// dan cukup panggil ulang berkali-kali (MAX_ROUNDS) utk dapat total lebih besar.
const COUNT_PER_ROUND = 5;
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);

async function runBlogger(): Promise<number> {
	let total = 0;
	for (let i = 1; i <= MAX_ROUNDS; i++) {
		const r = await botNewsRun(env, { force: true, count: COUNT_PER_ROUND, mode: "blogger" });
		console.log(`[blogger ${i}/${MAX_ROUNDS}] posted=${r.posted} capped=${r.capped} :: ${r.message}`);
		total += r.posted;
		// capped = daily_cap Blogger tercapai (bukan error) -> lanjut ke loop situs.
		// posted===0 tanpa capped = antrean 'new' sudah habis ATAU macet di error
		// yang sama terus (tidak ada gunanya diulang lagi di round berikutnya).
		if (r.capped || r.posted === 0) break;
	}
	return total;
}

async function runSite(): Promise<number> {
	let total = 0;
	for (let i = 1; i <= MAX_ROUNDS; i++) {
		const r = await botNewsRun(env, { force: true, count: COUNT_PER_ROUND, mode: "site" });
		console.log(`[situs ${i}/${MAX_ROUNDS}] siteOnly=${r.siteOnly} :: ${r.message}`);
		total += r.siteOnly;
		if (r.siteOnly === 0) break;
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
	const posted = await runBlogger();
	const siteOnly = await runSite();
	console.log(`\n=== SELESAI: ${posted} artikel ke Blogger, ${siteOnly} artikel ke situs sendiri ===`);
}

main().catch((e) => {
	console.error("GAGAL:", e instanceof Error ? e.stack || e.message : e);
	process.exit(1);
});
