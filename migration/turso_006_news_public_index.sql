-- Index untuk query SITUS PUBLIK "Berita Terkini" (publicNewsList /
-- publicNewsPopular / sitemap di src/lib/bot-news.ts): semuanya menyaring
-- `site_posted_at != ''` lalu mengurutkan `site_posted_at DESC, id DESC`,
-- dan versi per-kategori menambah `category = ?`.
--
-- Tanpa index ini tiap pembukaan halaman memindai + mengurutkan SELURUH tabel
-- news_article, dan tabel itu memang tidak pernah dipangkas (artikel yang sudah
-- tayang sengaja disimpan sebagai arsip) -- jadi halaman publik makin lambat
-- seiring artikel bertambah.
--
-- TIDAK WAJIB dijalankan manual: ensureNewsCategoryColumns() di
-- src/lib/bot-news.ts sudah membuat index yang sama otomatis sekali per
-- cold-start, sama seperti ALTER TABLE lazy di fungsi itu.

CREATE INDEX IF NOT EXISTS ix_news_public ON news_article(site_posted_at, id);
CREATE INDEX IF NOT EXISTS ix_news_public_cat ON news_article(category, site_posted_at, id);
