---
name: laporan-harian-architecture
description: "Arsitektur \"Laporan Harian\" di panel-worker — engine per modul & kendala Cloudflare"
metadata: 
  node_type: memory
  pinned: false
  originSessionId: e25bb91f-1271-4c1d-8610-18c5c58b8ef7
  modified: 2026-09-10T21:39:24.973Z
---

Menu **"Laporan Harian"** di `panel-worker` (Cloudflare Worker) menggabungkan
scraper PANEL AUTO Apps Script lama. Login ikut login panel utama.

## Pembagian engine per modul (sudah jadi, deployed)

| Modul | Engine | Kenapa |
|---|---|---|
| **Setting** | Worker + D1 (`lap_credentials`) | CRUD biasa |
| **Lap Motion** | Worker langsung (`fetch` API JSON) | motionv2.com TIDAK diblokir |
| **Lap Admin** (Register/Report Agent/Check Koin/WD PGA-IDF) | **GitHub Actions** repo publik `projectbykd-jpg/daygroup-scraper` (`scrape.mjs`) | 300-400 halaman, nol batas subrequest. Worker trigger via GitHub API (`GH_TOKEN` secret, `GH_REPO` var), Actions ambil kredensial via callback `lapJobStart` (token sekali-pakai di `lap_job.params`), hasil balik via `lapJobResult` -> `lap_result`. Panel poll `lapAdminStatus`. |
| **Lap Mozart** | **Bookmarklet di browser CS** -> `/api` action `lapMozartImport` | `limatogel.makintajir.com` di belakang Cloudflare yang **memblokir SEMUA IP datacenter**: Cloudflare Workers, GitHub Actions/Azure, DAN Google Apps Script semuanya kena 403 "Attention Required! | Cloudflare". Situs ini TIDAK pakai cf_clearance sama sekali (browser user lolos tanpa itu) -> murni blok IP non-residensial. Jadi Apps Script pun gagal. Bookmarklet juga GAGAL: CSP situs Mozart memblok `javascript:` -> Chrome buka `about:blank#blocked`. Solusi final yang jalan: **skrip yang di-paste di DevTools Console tab Mozart** (Console bypass CSP halaman). Menu Lap Mozart meng-generate skrip (token sesi + URL panel di-embed) -> user Salin Skrip -> F12 Console di tab Mozart (`allow pasting` sekali) -> paste -> isi tanggal -> `fetch` same-origin paginasi `/api/transactions/fetchTransaction` + `/api/wd/fetchWithdrawal` (`credentials:'include'`) -> POST cross-origin ke panel `/api` action `lapMozartImport`. Butuh CORS `*` + handler `OPTIONS` di Worker `/api` (`src/lib/respond.ts` `CORS_HEADERS`). File `daygroup-mozart-appsscript.gs` DITINGGALKAN. |

## Pelajaran umum

- Cloudflare Workers TIDAK bisa menjangkau situs ber-Cloudflare yang blok bot /
  datacenter IP. GitHub Actions (Azure) juga kena blok keras untuk situs yang
  agresif. Jalur andalan untuk situs macam itu = Apps Script (IP Google).
- Server agen (`ag.suksesbogil.com`) MENGABAIKAN param `bts` di `his_coin.php`
  (~100 baris/halaman). Paginasi harus "fetch sampai halaman kosong"
  (`pagesUntilEmpty` di scrape.mjs), jangan andalkan link `page=N` di halaman 1.
- his_coin: baris PGA/reject/create-master DIKECUALIKAN dari perhitungan
  running-balance/selisih (flag `excluded`), tapi tetap ditampilkan.

## Invest / AUTOCHECK: ADA BANYAK VARIAN PANEL AGEN

Pemilik menegaskan grup ini memakai **beberapa instalasi panel agen berbeda**:
`ag.suksesbogil.com`, `agwl4`, `agwl5`, `agwl12` (`.suksesbogil.com`). Tiap
instalasi punya struktur berbeda — scraper Invest awalnya cuma cocok untuk
`ag.suksesbogil.com`. Perbedaan yang sudah terlihat pada `agwl12`:
- `<option>` pasaran: `value="ARIZONA,p7023"` (bukan `value="p33190"` seperti `ag`).
  Kode pasaran tetap `pXXXX`; `admin_invoice13.php?psr=p7023` bekerja.
- Nomor periode kecil & berurutan per pasaran (mis. `36`), bukan ~2266.
- Tabel total beda format: `Kombinasi : 0  50_50 : 0  4D : 0  3D : 0  2D : 0 …`
  (bukan `value ="2D">&nbsp;:&nbsp;N`).
- Ada link `(Buy)` di judul "Invoice Transaksi TOTO Periode : 36 - ARIZONA".

Fakta penting: **halaman invoice `agwlXX` FORMAT-nya identik dgn `ag`** —
`<input name="periode" value="N">`, total `value ="2D">&nbsp;:&nbsp;N`,
`<iframe src='admin_invoice_frame.php'>`. Jadi `parsePeriode`/`parseTotals`/
parser baris LAMA sudah cocok. Yang beda **cuma kode pasaran** (`p6586` vs
`p33190`) DAN **dropdown pasaran di `agwlXX` di-render JavaScript** — `fetch`
server-side atas `agentoverview.php` dapat shell 44 KB tanpa satu pun `<option>`
pasaran. Jadi auto-discovery `<select>` GAGAL untuk agwlXX.

**PENTING — `INVEST_PASARAN` hardcoded SUDAH USANG untuk semua panel.** Kode
`pXXXX` berubah dari waktu ke waktu DAN beda tiap agen (ARIZONA dulu `p33190`,
sekarang `p33182` di `ag.suksesbogil.com`, `p7023` di `agwl12`). Gejala: sesi
valid tapi `admin_invoice13.php?psr=<kode lama>` balas periode KOSONG utk semua
pasaran. Sumber daftar pasaran yang benar: **`agent_bt.php`** (frame menu; ada
di SEMUA panel suksesbogil) — `<select onchange="gantipasar()">` dgn
`<option value="NAMA,pXXXX">`. `investScanUser` sekarang coba `agent_bt.php`
paling dulu. Jadi jangan pernah andalkan `INVEST_PASARAN`; itu fallback darurat.

Solusi tambahan (deployed): kolom **`invest_config.pasaran_json`** +
textarea "Daftar pasaran panel" di Setting Invest. Operator tempel blok
`<select>…</select>` (dari Inspect Element) SEKALI; `investSaveConfig` parse
via `parsePasaranOptionsHtml` (dukung `value="NAMA,pXXXX"` & `value="pXXXX"`) →
simpan `[["p7023","ARIZONA"],…]`. `investScanUser` urutan sumber daftar pasaran:
1) `pasaran_json` tersimpan → 2) auto-discovery `<select>` beberapa halaman →
3) `INVEST_PASARAN` bawaan. Ketik `-` di textarea = kosongkan. Diag scan
menampilkan `list=tersimpan(N)` / `list=agentoverview(N)` / `list=default`.
agwl12 (Hugo/fery) sudah di-seed 62 pasaran lewat script.

Kendala kedua agwlXX: zona-nya pakai **Cloudflare Bot Fight Mode**. Subrequest
Worker yang cuma kirim `User-Agent` + `Cookie` di-challenge → balas 200 halaman
kosong tanpa `periode` (scan dapat 1/62 padahal fetch dari browser/mesin lokal
100% jalan). Fix: `investBrowserHeaders()` di `invest.ts` — kirim `Accept`,
`Accept-Language`, `Sec-Fetch-*`, `sec-ch-ua`, `Referer` layaknya browser.
Dipakai `investFetch` + `investBatchGet`. Panel `ag.suksesbogil.com` TIDAK kena
ini (Bot Fight Mode off di zona itu).

## Database: Turso, bukan D1 (sejak migrasi usage)

Tabel BERAT sudah dipindah dari Cloudflare D1 ke **Turso (libSQL)** karena D1
Free cuma 5 juta rows-read/hari. Turso Free = 1 miliar/bulan.
- Di Turso: `lap_credentials`, `lap_result` (username+module PK, data JSON),
  `lap_job`, `invest_config`, `invest_state`, `invest_result`, `invest_raw`.
- Tetap di D1: `users`, `sessions`, `activity_log`, `settings`, `site_accounts`,
  `prediction_*`, `sent_registry`.
- `src/lib/turso.ts` = shim antarmuka D1 (`prepare/bind/run/all/first/batch`)
  + `getTurso(env)`. Kode lap/invest cuma ganti `env.DB` -> `getTurso(env)`.
- Secret `TURSO_URL` + `TURSO_TOKEN` (wrangler secret). `scrub()` buang BOM
  yang terbawa saat set secret lewat pipe PowerShell.
- Skema: `migration/turso_001_schema.sql`. Cek koneksi: `/__cron?job=tursoping`.
- Migrasi data: `panel-worker/scripts/migrate-to-turso.mjs`.

## PENDING setup oleh user (projectbykd@gmail.com)

- `wrangler secret put GH_TOKEN` (fine-grained PAT, repo daygroup-scraper, Actions R/W)
- Deploy Apps Script `daygroup-mozart` -> `wrangler secret put MOZART_GAS_URL` + `MOZART_GAS_KEY`
- Isi kredensial di menu Laporan Harian -> Setting
