// Menu "PGA PENDING" -- daftar withdraw berstatus "PGA Pending" di
// motionv2.com/withdraw-request, disinkron LIVE dari skrip Console yang jalan
// di tab Motion (pola sama seperti Lap Motion: server-side fetch langsung ke
// motionv2.com sering diblokir WAF / ditolak kalau tidak dipanggil dari
// halamannya sendiri, jadi datanya didorong DARI browser asli, bukan ditarik
// server -- lihat pgaPendingConsoleScript di Scripts.html).
//
// Disimpan di KV (env.SESS), BUKAN Turso -- sengaja: kalau skrip Console
// berhenti (tab ditutup / dipause), baris yang sudah tidak dikonfirmasi lagi
// HARUS otomatis hilang dari panel dalam hitungan detik ("kalau sudah hilang
// jangan tampil lagi di List"). TTL KV pas buat itu tanpa job pembersih
// terpisah -- tiap sync menimpa TOTAL snapshot (bukan merge), jadi baris yang
// sudah tidak ada di kiriman terbaru otomatis tersapu juga tanpa menunggu TTL.

export interface PgaPendingRow {
	website: string;
	idTrans: string;
	tanggal: string;
	idUser: string;
	jumlah: number;
	statusText: string; // teks badge apa adanya (mis. "Grabbed PGA PGA Pending 000")
	pgaRefNo: string;
	vendorName: string;
}

export interface PgaPendingSnapshot {
	rows: PgaPendingRow[];
	updatedAt: number;
}

// Interval sinkron skrip Console = 5 detik. TTL dibuat 20 detik (4x lipat) --
// cukup toleran terhadap 1-2 sinkron yang telat/gagal (jaringan admin sendat
// dsb) tanpa membuat List berkedip kosong, tapi tetap "hilang" dalam hitungan
// detik begitu skrip benar-benar berhenti (tab ditutup).
const TTL_SECONDS = 20;
const MAX_ROWS = 200; // batas wajar -- skrip yang bertingkah tidak boleh menulis blob raksasa ke KV

const key = (user: string) => "pga_pending:" + user;

function cleanRow(r: Record<string, unknown>): PgaPendingRow {
	return {
		website: String(r.website ?? "").slice(0, 60),
		idTrans: String(r.idTrans ?? "").slice(0, 60),
		tanggal: String(r.tanggal ?? "").slice(0, 40),
		idUser: String(r.idUser ?? "").slice(0, 60),
		jumlah: Number(r.jumlah) || 0,
		statusText: String(r.statusText ?? "").slice(0, 160),
		pgaRefNo: String(r.pgaRefNo ?? "").slice(0, 80),
		vendorName: String(r.vendorName ?? "").slice(0, 60),
	};
}

export async function pgaPendingSave(env: Env, user: string, rows: Record<string, unknown>[]): Promise<PgaPendingSnapshot> {
	const clean = rows.slice(0, MAX_ROWS).map(cleanRow);
	const snap: PgaPendingSnapshot = { rows: clean, updatedAt: Date.now() };
	await env.SESS.put(key(user), JSON.stringify(snap), { expirationTtl: TTL_SECONDS });
	return snap;
}

export async function pgaPendingLoad(env: Env, user: string): Promise<PgaPendingSnapshot> {
	const raw = await env.SESS.get(key(user));
	if (!raw) return { rows: [], updatedAt: 0 };
	try {
		const j = JSON.parse(raw) as Partial<PgaPendingSnapshot>;
		return { rows: Array.isArray(j.rows) ? j.rows : [], updatedAt: Number(j.updatedAt) || 0 };
	} catch {
		return { rows: [], updatedAt: 0 };
	}
}
