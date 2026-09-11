---
name: bot-role-news-feature
description: Role BOT terisolasi di Day-Group Panel — wadah fitur NEWS (scalping berita -> auto-post Blogger)
metadata: 
  node_type: memory
  pinned: false
  originSessionId: e25bb91f-1271-4c1d-8610-18c5c58b8ef7
  modified: 2026-09-10T23:04:22.496Z
---

Pemilik Day-Group Panel meminta **Role baru `BOT`** yang **terisolasi total**:
akun ber-role BOT hanya boleh mengakses fitur BOT, tidak bisa membuka menu lain
(Result / Prediksi / Invest / Laporan / Admin). Role BOT ini akan menampung
fitur **NEWS**: bot melakukan *scalping* artikel ke situs berita lalu
mem-posting otomatis ke **situs Blogger milik sendiri**. Struktur data NEWS
belum ditentukan ("belum tahu") — dibangun bertahap.

## Kerangka yang sudah terpasang (commit f596825, langkah 1)

- **Default-deny di `requireSession` (`src/api/auth.ts`)**: kalau `profile.role
  === "BOT"` dan handler TIDAK meneruskan `opts.allowBot`, langsung throw
  "Akun BOT hanya bisa mengakses fitur BOT." Jadi SEMUA endpoint lama otomatis
  menolak BOT; endpoint fitur BOT nanti tinggal `requireSession(env, token,
  { allowBot: true })`. Yang sudah di-allowBot: `resumeSession`,
  `logClientActivity` (biar reload sesi & log tidak error).
- `ROLES` di `src/api/admin.ts` + dropdown `#editRole` + `#userRoleFilter` di
  `ui-src/Index.html`: tambah opsi `BOT`.
- Frontend `applyProfileUI()` (`ui-src/Scripts.html`): kalau role BOT →
  sembunyikan semua `.sidebar-nav`, tampilkan hanya yang ber-class `.bot-only`,
  paksa `switchPage('bot')`, live-polling dimatikan. Untuk non-BOT, elemen
  `.bot-only` disembunyikan.
- Halaman `#bot-page` + nav `#nav-bot` (class `bot-only`, `data-page` via
  `switchPage('bot')`) — placeholder, kicker "DAY-GROUP PANEL · BOT".
- `NAV_KEYS`, `HEADER_KICKER`, peta `pages` di `switchPage` sudah memuat `bot`.

## Detail fitur NEWS dari pemilik

- **Sumber berita**: kompas.com, liputan6.com, news.detik.com.
  - detik RSS OK: `https://news.detik.com/rss` (RSS 2.0 + `content:encoded`).
  - liputan6 RSS OK: `https://feed.liputan6.com/rss/news`.
  - kompas TIDAK punya RSS publik (403/404) → perlu scrape `indeks.kompas.com`
    atau proxy lewat Google News RSS (`news.google.com/rss/search?q=site:kompas.com`).
- **AI rewrite**: Gemini API, model `gemini-flash-latest`, endpoint
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`
  header `X-goog-api-key`. Key milik pemilik SUDAH DITES jalan (jangan simpan
  key di repo — taruh di `bot_config` Turso / wrangler secret).
- **Blog tujuan**: Blogger, blog ID **8778418113588221802**.

## Modul NEWS — SUDAH DIBANGUN & DITES (commit 76bbb25)

- **Turso**: `bot_kv` (config key-value), `news_source`, `news_article`
  (dedup lewat `url_hash` = sha256 url).
- **`src/lib/bot-news.ts`**: `parseRss` + `resolveGnews`, `geminiRewrite`
  (fallback model `gemini-2.5-flash`/`gemini-flash-lite-latest` kalau 503/429;
  `responseMimeType: application/json`), Blogger v3 (`bloggerAccessToken`
  cache in-memory, `bloggerCreatePost`), `newsPullSources`/`newsProcessOne`/
  `botNewsRun` (entry cron).
- **`src/api/bot.ts`**: `botNewsStatus/SaveConfig/AddSource/ToggleSource/
  DeleteSource/RunNow/Skip` — `gate()` izinkan role BOT & ADMIN.
- **`index.ts`**: ROUTES + `/__cron?job=news` (juga `job=all`).
- **Frontend** `#bot-page`: kartu statistik + form konfigurasi + kelola sumber
  + log artikel; JS `loadBotNews/applyBotNews/...` di Scripts.html.
- **E2E sudah lulus**: Detik/Liputan6 → Gemini rewrite → post ke
  `lokalstore88.blogspot.com` (post uji sudah dihapus).
- `bot_kv.enabled` default `0` (pemilik nyalakan dari panel). `per_run`=2,
  `daily_cap`=8, `attribution`=1 (sumber + backlink wajib).
- Sesi BOT saat refresh: `getBootstrapData` + `resumeSession` +
  `logClientActivity` di-`allowBot`, `getBootstrapData` balikin profil saja
  (tanpa dashboard) untuk role BOT — kalau tidak, BOT ke-logout tiap reload.

## Blogger OAuth — kredensial tersimpan di `bot_kv`

Client ID/secret (Desktop app, project `lapakstore88-f6d56`) + refresh_token +
blog_id `8778418113588221802` sudah di `bot_kv`. Scope
`https://www.googleapis.com/auth/blogger`.

### ⚠️ Refresh token kedaluwarsa 7 HARI (app masih "Testing")
`refresh_token_expires_in` ~604800 dtk. Supaya permanen: pemilik set
**Publishing status = In production** di Google Auth Platform, lalu authorize
ULANG (link sama) → kirim `code` baru → tukar jadi refresh token permanen →
update `bot_kv.blogger_refresh_token`. Kalau tidak, bot berhenti posting
~7 hari setelah 2026-09-11.

## Catatan hak cipta (sudah disampaikan ke pemilik)

Republish artikel penuh dari kompas/detik/liputan6 (walau di-rewrite AI) =
pelanggaran hak cipta + ToS situs; blog scraper/spun sering di-takedown Google.
Rancang dgn: rewrite substansial + **atribusi sumber + backlink** wajib, atau
mode kutipan-pendek + link. Bangun dgn atribusi sebagai default.
