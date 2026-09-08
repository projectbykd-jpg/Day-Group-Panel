# Day-Group Panel

Panel manajemen result & prediksi togel untuk operator CS Day-Group.

## Struktur

| Path | Isi |
|---|---|
| `panel-worker/` | **Aplikasi aktif** — Cloudflare Worker (TypeScript) + D1 + KV. Ini yang di-deploy. |
| `migration/` | Skema & migrasi database D1 (`day_database`). |
| `*.gs`, `*.html` | **Arsip** — kode Google Apps Script lama (sumber port). Tidak dipakai lagi. |

## Deploy

```bash
cd panel-worker
npm install
npm run deploy        # build UI + wrangler deploy
```

URL produksi: https://panel-worker.projectbykd.workers.dev

### Penjadwalan (auto-post prediksi + pump scan INVEST)

Cron Trigger bawaan Cloudflare **tidak jalan** di akun Free ini, jadi dipakai
**cron eksternal** yang memanggil endpoint HTTP:

```
GET /__cron?key=<CRON_KEY>&job=autopost   # router auto-post prediksi + kata penutup
GET /__cron?key=<CRON_KEY>&job=invest     # pump scan INVEST (resume via cursor)
GET /__cron?key=<CRON_KEY>&job=all        # keduanya
```

`CRON_KEY` ada di `panel-worker/wrangler.jsonc` (`vars.CRON_KEY`).

**Setup di [cron-job.org](https://cron-job.org) (gratis, tiap 1 menit):**
1. Buat 2 cronjob, interval *every 1 minute*:
   - `https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=autopost`
   - `https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=invest`

Cadangan: GitHub Actions `.github/workflows/cron.yml` (tiap 5 menit) — butuh
repo secret `CRON_KEY`. Cron Trigger Cloudflare tetap didaftarkan kalau nanti aktif.

> Auto-post prediksi hanya jalan kalau **minimal 1 operator sedang login**.

### Bindings (lihat `panel-worker/wrangler.jsonc`)
- `DB` → D1 `day_database`
- `SESS` → KV (sesi login + guard)
- `ASSETS` → static `panel-worker/public/` (di-generate dari `ui-src/`)

## Migrasi DB

```bash
cd panel-worker
npx wrangler d1 execute day_database --remote --file ../migration/001_init.sql
npx wrangler d1 execute day_database --remote --file ../migration/002_invest_raw.sql
```
