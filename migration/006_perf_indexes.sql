-- Index performa yang ditambahkan setelah 001_init.sql & 004_sessions_fallback.sql
-- terlanjur jalan di database produksi.
--
-- TIDAK WAJIB dijalankan manual: ensurePerfIndexes() di src/lib/db.ts membuat
-- index yang sama otomatis dari cron (sekali per cold-start). File ini ada
-- supaya install baru/dokumentasi skema tetap lengkap di satu tempat.

-- Dashboard & halaman Aktivitas untuk non-admin selalu menyaring
-- "username = ? AND ts (rentang hari ini)". ix_activity_user yang lama hanya
-- bisa melayani bagian username-nya; sisanya tetap dipindai satu per satu.
CREATE INDEX IF NOT EXISTS ix_activity_user_ts ON activity_log(username, ts);

-- capUserSessions() (src/lib/session.ts) jalan tiap login:
-- "WHERE username = ? ORDER BY created_at DESC".
CREATE INDEX IF NOT EXISTS ix_sessions_username ON sessions(username, created_at);
