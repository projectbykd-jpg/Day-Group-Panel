-- ---------------------------------------------------------------------------
-- invest_raw — buffer kerja scan INVEST per operator (pengganti sheet _invest_raw_<user>).
-- Baris mentah "user X lewat batas di pasaran Y periode Z game G" sebelum diagregasi
-- ke invest_result. Dikosongkan tiap kali scan baru dimulai (cursor = 0).
-- ---------------------------------------------------------------------------
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
