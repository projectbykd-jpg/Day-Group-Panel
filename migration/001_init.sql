-- ============================================================================
-- Day-Group Panel — skema awal D1 (SQLite)
-- Jalankan di: Cloudflare dashboard > D1 > day_database > tab "Console"
-- Setelah Run: "Number of Tables" harus jadi 10.
--
-- Konvensi:
--   * checkbox TRUE/FALSE  -> INTEGER 0/1
--   * tanggal              -> TEXT ISO "yyyy-MM-dd HH:mm:ss" (GMT+7, disimpan apa adanya)
--   * date_key             -> TEXT "yyyy-MM-dd" (GMT+7)
--   * hash                 -> TEXT hex SHA-256
--   * daftar (websites)    -> TEXT JSON array, mis. '["HUGO","FOLA"]'
-- Sesi login TIDAK di sini -> disimpan di Cloudflare KV (sess:<token>).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. users  (dari sheet "Users")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,
  username_lc    TEXT NOT NULL,                       
  password_hash  TEXT NOT NULL DEFAULT '',            
  websites       TEXT NOT NULL DEFAULT '[]',          
  perm_telegram  INTEGER NOT NULL DEFAULT 0,
  perm_linktree  INTEGER NOT NULL DEFAULT 0,
  perm_panelz    INTEGER NOT NULL DEFAULT 0,
  role           TEXT NOT NULL DEFAULT 'OPERATOR',   
  status         TEXT NOT NULL DEFAULT 'AKTIF',       
  display_name   TEXT NOT NULL DEFAULT '',
  last_login_at  TEXT,
  failed_login   INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username_lc ON users(username_lc);

-- ---------------------------------------------------------------------------
-- 2. site_accounts  (dari sheet "Sosmed" — 1 baris per situs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_accounts (
  website           TEXT PRIMARY KEY,                 -- kode situs, UPPERCASE (HUGO, FOLA, ...)
  display_name      TEXT NOT NULL DEFAULT '',
  tg_token          TEXT NOT NULL DEFAULT '',         -- Telegram result
  tg_chat_id        TEXT NOT NULL DEFAULT '',
  tg_pred_token     TEXT NOT NULL DEFAULT '',         -- Telegram Prediksi
  tg_pred_chat_id   TEXT NOT NULL DEFAULT '',
  lt_email          TEXT NOT NULL DEFAULT '',         -- LinkTree
  lt_pass           TEXT NOT NULL DEFAULT '',
  pz_user           TEXT NOT NULL DEFAULT '',         -- Panel-Z basic auth
  pz_pass           TEXT NOT NULL DEFAULT '',
  pz_user2          TEXT NOT NULL DEFAULT '',         -- Panel-Z form login
  pz_pass2          TEXT NOT NULL DEFAULT '',
  pz_url            TEXT NOT NULL DEFAULT ''          -- base URL Panel-Z situs
);

-- ---------------------------------------------------------------------------
-- 3. sent_registry  (dari sheet "Sent Registry") — anti-duplikat kirim result
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sent_registry (
  hash       TEXT NOT NULL,                           -- SHA-256 dari kunci hasil (market|prize1|prize2|prize3)
  website    TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  username   TEXT NOT NULL DEFAULT '',
  market     TEXT NOT NULL DEFAULT '',
  telegram   INTEGER NOT NULL DEFAULT 0,
  linktree   INTEGER NOT NULL DEFAULT 0,
  panelz     INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hash, website)
);
CREATE INDEX IF NOT EXISTS ix_sent_registry_sent_at ON sent_registry(sent_at);

-- ---------------------------------------------------------------------------
-- 4. prediction_registry  (dari sheet "Prediction Send Registry") — Smart Lock
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prediction_registry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key        TEXT NOT NULL,                      -- yyyy-MM-dd (GMT+7)
  schedule_id     TEXT NOT NULL,                      -- PRED-1..7 | CLOSING-0615 | CLOSING-1600
  prediction_name TEXT NOT NULL DEFAULT '',
  website         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING | BERHASIL | GAGAL
  username        TEXT NOT NULL DEFAULT '',
  sent_at         TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  request_id      TEXT NOT NULL DEFAULT '',
  detail          TEXT NOT NULL DEFAULT '',
  content_hash    TEXT NOT NULL DEFAULT '',
  unique_key      TEXT NOT NULL                       -- date_key || schedule_id || website
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pred_reg_unique_key ON prediction_registry(unique_key);
CREATE INDEX IF NOT EXISTS ix_pred_reg_date ON prediction_registry(date_key);

-- ---------------------------------------------------------------------------
-- 5. prediction_content  (dari sheet "Prediction Daily Content")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prediction_content (
  date_key        TEXT NOT NULL,
  schedule_id     TEXT NOT NULL,
  website         TEXT NOT NULL,
  prediction_name TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  PRIMARY KEY (date_key, schedule_id, website)
);

-- ---------------------------------------------------------------------------
-- 6. activity_log  (dari sheet "Activity Log" + "BackUp Activity Log")
--    Tidak ada lagi rollover/sheet backup -> retensi = DELETE lewat cron.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  username  TEXT NOT NULL DEFAULT 'UNKNOWN',
  action    TEXT NOT NULL DEFAULT 'AKTIVITAS',
  status    TEXT NOT NULL DEFAULT 'INFO',
  detail    TEXT NOT NULL DEFAULT '',
  content   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_activity_ts ON activity_log(ts);
CREATE INDEX IF NOT EXISTS ix_activity_user ON activity_log(username);
CREATE INDEX IF NOT EXISTS ix_activity_action ON activity_log(action);

-- ---------------------------------------------------------------------------
-- 7. settings  (dari sheet "Settings") — key/value
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('maintenance', 'FALSE'),
  ('maintenance_message', 'Panel sedang dalam pemeliharaan. Silakan coba kembali nanti.'),
  ('autopost_enabled', 'TRUE'),
  ('updated_by', 'SYSTEM'),
  ('updated_at', datetime('now','+7 hours'));

-- ---------------------------------------------------------------------------
-- 8. invest_config  (dari Script Properties INVEST_CFG::<user>::*) — per operator
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invest_config (
  username      TEXT PRIMARY KEY,
  base_url      TEXT NOT NULL DEFAULT 'https://ag.suksesbogil.com/',
  phpsessid     TEXT NOT NULL DEFAULT '',
  koderedis     TEXT NOT NULL DEFAULT '',
  cookie_extra  TEXT NOT NULL DEFAULT '',
  limit_2d      INTEGER NOT NULL DEFAULT 20,
  limit_3d      INTEGER NOT NULL DEFAULT 250,
  limit_4d      INTEGER NOT NULL DEFAULT 1296,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);

-- ---------------------------------------------------------------------------
-- 9. invest_state  (dari INVEST_STATE::<user>) — progres scan per operator
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invest_state (
  username    TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'idle',           -- idle|running|paused|session_expired|done|error
  cursor      INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  message     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);

-- ---------------------------------------------------------------------------
-- 10. invest_result  (dari sheet "INVEST <username>") — 1 baris per bettor
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invest_result (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,                           -- operator pemilik scan
  bettor     TEXT NOT NULL DEFAULT '',                -- username downline yang lewat batas
  dates      TEXT NOT NULL DEFAULT '',                -- "2026-09-06, 2026-09-07"
  markets    TEXT NOT NULL DEFAULT '',
  excess     INTEGER NOT NULL DEFAULT 0,              -- total line lewat batas
  hits       TEXT NOT NULL DEFAULT '[]',              -- JSON rincian per pasaran
  created_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);
CREATE INDEX IF NOT EXISTS ix_invest_result_owner ON invest_result(owner);

-- ============================================================================
-- selesai — cek: SELECT name FROM sqlite_master WHERE type='table';
-- ============================================================================
