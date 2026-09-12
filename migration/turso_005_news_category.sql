-- Kategori artikel BOT NEWS, untuk halaman "Berita Terkini" per-kategori di
-- LapakStore88 (situs publik terpisah). Diterapkan lewat migrasi malas (lazy
-- ALTER TABLE, lihat ensureNewsCategoryColumns() di src/lib/bot-news.ts) --
-- file ini murni dokumentasi skema, TIDAK perlu dijalankan manual.
ALTER TABLE news_source ADD COLUMN category TEXT NOT NULL DEFAULT 'umum';
ALTER TABLE news_article ADD COLUMN category TEXT NOT NULL DEFAULT 'umum';
