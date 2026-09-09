-- Cadangan sesi di D1. KV (binding SESS) tetap penyimpanan utama, tapi kuota
-- Free hanya 1000 write/hari; kalau jebol, semua SESS.put gagal dan tidak ada
-- yang bisa login. Tabel ini dipakai sebagai fallback saat KV put gagal.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
