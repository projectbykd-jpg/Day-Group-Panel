// Menu "PGA PENDING" -- daftar withdraw berstatus "PGA Pending" di
// motionv2.com/withdraw-request, disinkron LIVE dari skrip Console yang jalan
// di tab Motion (pola sama seperti Lap Motion: server-side fetch langsung ke
// motionv2.com sering diblokir WAF / ditolak kalau tidak dipanggil dari
// halamannya sendiri, jadi datanya didorong DARI browser asli, bukan ditarik
// server -- lihat pgaPendingConsoleScript di Scripts.html).
//
// PERNAH disimpan di KV (env.SESS) -- SALAH, jangan diulang: sync tiap 2
// detik = ribuan tulisan/jam, jauh melebihi jatah gratis Cloudflare KV
// (1000 put()/hari PER AKUN, bukan per fitur), jadi bukan cuma PGA Pending
// yang berhenti tapi SEMUA fitur lain yang nulis KV ikut error "limit
// exceeded" (sesi login dll, sama-sama pakai env.SESS). Pindah ke Turso
// (satu baris per user, di-UPSERT) -- jatah tulisnya jauh lebih longgar dan
// memang sudah dipakai fitur lain yang sering ditulis (invest_state dll).
//
// "Hilang dalam hitungan detik" begitu skrip/tab berhenti TETAP terpenuhi
// tanpa TTL: pgaPendingLoad menganggap baris BASI (balas kosong) kalau
// updated_at sudah lebih tua dari STALE_MS, walau baris di database-nya
// sendiri belum dihapus (baris lama ditimpa otomatis oleh sync berikutnya
// kalau skrip jalan lagi, jadi tidak perlu job pembersih terpisah).
import { getTurso } from "./turso";

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

const MAX_ROWS = 200; // batas wajar -- skrip yang bertingkah tidak boleh menulis blob raksasa
// Interval sinkron skrip Console = 2 detik. Basi kalau sudah 10x lipat itu
// tanpa sync baru (tab ditutup/di-pause) -- cukup toleran thd 1-2 sinkron yg
// telat (jaringan admin sendat) tanpa List berkedip kosong.
const STALE_MS = 20000;

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

let ensured = false;
async function ensureTable(env: Env): Promise<void> {
	if (ensured) return;
	await getTurso(env)
		.prepare(
			`CREATE TABLE IF NOT EXISTS pga_pending_state (
				username TEXT PRIMARY KEY,
				rows_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
		)
		.run();
	ensured = true;
}

export async function pgaPendingSave(env: Env, user: string, rows: Record<string, unknown>[]): Promise<PgaPendingSnapshot> {
	await ensureTable(env);
	const clean = rows.slice(0, MAX_ROWS).map(cleanRow);
	const snap: PgaPendingSnapshot = { rows: clean, updatedAt: Date.now() };
	await getTurso(env)
		.prepare(
			`INSERT INTO pga_pending_state (username, rows_json, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(username) DO UPDATE SET rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
		)
		.bind(user, JSON.stringify(clean), snap.updatedAt)
		.run();
	return snap;
}

export async function pgaPendingLoad(env: Env, user: string): Promise<PgaPendingSnapshot> {
	await ensureTable(env);
	const row = await getTurso(env)
		.prepare(`SELECT rows_json, updated_at FROM pga_pending_state WHERE username = ?`)
		.bind(user)
		.first<{ rows_json: string; updated_at: number }>();
	if (!row) return { rows: [], updatedAt: 0 };
	const updatedAt = Number(row.updated_at) || 0;
	if (Date.now() - updatedAt > STALE_MS) return { rows: [], updatedAt: 0 };
	try {
		const rows = JSON.parse(row.rows_json);
		return { rows: Array.isArray(rows) ? rows : [], updatedAt };
	} catch {
		return { rows: [], updatedAt: 0 };
	}
}
