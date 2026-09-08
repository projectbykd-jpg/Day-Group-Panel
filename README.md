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

### Cron Triggers
- `*/5 * * * *` — router auto-post prediksi (butuh minimal 1 operator login)
- `* * * * *` — pump scan INVEST

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
