-- Role BOT / modul NEWS: scalping berita -> rewrite Gemini -> post Blogger.
-- Semua di Turso (bukan D1) supaya tidak makan kuota D1.

-- Konfigurasi bot (key-value biar fleksibel tanpa migrasi tiap tambah aturan).
CREATE TABLE IF NOT EXISTS bot_kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- Sumber berita.
CREATE TABLE IF NOT EXISTS news_source (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'rss',   -- rss | gnews | scrape
  url     TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT ''
);

-- Artikel yang ditemukan / diproses.
CREATE TABLE IF NOT EXISTS news_article (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  url_hash      TEXT NOT NULL,               -- sha256 url -> anti dobel
  title         TEXT NOT NULL DEFAULT '',
  excerpt       TEXT NOT NULL DEFAULT '',
  image_url     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new', -- new | rewritten | posted | skipped | error
  rewritten_html TEXT NOT NULL DEFAULT '',
  post_url      TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  found_at      TEXT NOT NULL DEFAULT '',
  posted_at     TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_news_article_hash ON news_article(url_hash);
CREATE INDEX IF NOT EXISTS ix_news_article_status ON news_article(status, id);
