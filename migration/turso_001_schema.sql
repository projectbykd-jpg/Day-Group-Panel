-- Skema Turso (libSQL) — tabel "berat" yang dipindah dari Cloudflare D1.
-- Modul Laporan Harian + Invest. Sisanya (users, sessions, activity_log,
-- settings, prediction_*, site_accounts, sent_registry) tetap di D1.

CREATE TABLE IF NOT EXISTS lap_credentials (
  username        TEXT PRIMARY KEY,
  link_admin      TEXT NOT NULL DEFAULT '',
  cookie_admin    TEXT NOT NULL DEFAULT '',
  link_motion     TEXT NOT NULL DEFAULT '',
  token_motion    TEXT NOT NULL DEFAULT '',
  link_mozart     TEXT NOT NULL DEFAULT '',
  cookie_mozart   TEXT NOT NULL DEFAULT '',
  mozart_accounts TEXT DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);

CREATE TABLE IF NOT EXISTS lap_result (
  username   TEXT NOT NULL,
  module     TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  PRIMARY KEY (username, module)
);

CREATE TABLE IF NOT EXISTS lap_job (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  params     TEXT NOT NULL DEFAULT '{}',
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);
CREATE INDEX IF NOT EXISTS ix_lap_job_user ON lap_job(username, created_at);

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

CREATE TABLE IF NOT EXISTS invest_state (
  username    TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'idle',
  cursor      INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  message     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);

CREATE TABLE IF NOT EXISTS invest_result (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,
  bettor     TEXT NOT NULL DEFAULT '',
  dates      TEXT NOT NULL DEFAULT '',
  markets    TEXT NOT NULL DEFAULT '',
  excess     INTEGER NOT NULL DEFAULT 0,
  hits       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);
CREATE INDEX IF NOT EXISTS ix_invest_result_owner ON invest_result(owner);

CREATE TABLE IF NOT EXISTS invest_raw (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  owner     TEXT NOT NULL,
  tanggal   TEXT NOT NULL DEFAULT '',
  bettor    TEXT NOT NULL DEFAULT '',
  pasaran   TEXT NOT NULL DEFAULT '',
  periode   TEXT NOT NULL DEFAULT '',
  game      TEXT NOT NULL DEFAULT '',
  line      INTEGER NOT NULL DEFAULT 0,
  limit_val INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_invest_raw_owner ON invest_raw(owner);
