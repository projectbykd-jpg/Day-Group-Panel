-- ---------------------------------------------------------------------------
-- Menu "Laporan Harian" (port PANEL AUTO Apps Script -> panel-worker).
-- Kredensial per operator + snapshot hasil scrape + pelacakan job GitHub Actions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lap_credentials (
  username     TEXT PRIMARY KEY,
  link_admin   TEXT NOT NULL DEFAULT '',
  cookie_admin TEXT NOT NULL DEFAULT '',
  link_motion  TEXT NOT NULL DEFAULT '',
  token_motion TEXT NOT NULL DEFAULT '',
  link_mozart  TEXT NOT NULL DEFAULT '',
  cookie_mozart TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);

-- Snapshot hasil per (operator, modul). data = JSON array baris.
CREATE TABLE IF NOT EXISTS lap_result (
  username   TEXT NOT NULL,
  module     TEXT NOT NULL,          -- register | reportAgent | checkCoin | idSelisih | withdrawPgaIdf | motionDpPga | motionPendingError | motionWd | mozartDepo | mozartWd | _meta
  data       TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  PRIMARY KEY (username, module)
);

-- Pelacakan job scrape (dipakai jalur GitHub Actions).
CREATE TABLE IF NOT EXISTS lap_job (
  id         TEXT PRIMARY KEY,       -- uuid
  username   TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- admin | motion | mozart
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  params     TEXT NOT NULL DEFAULT '{}',       -- {startDate,endDate,...}
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+7 hours'))
);
CREATE INDEX IF NOT EXISTS ix_lap_job_user ON lap_job(username, created_at);
