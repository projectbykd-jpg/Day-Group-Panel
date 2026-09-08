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
