-- Cegah baris kembar di invest_raw (pump sempat jalan dobel -> hit & excess
-- ke-hitung berkali-kali). invest_raw isinya buffer sementara & selalu di-clear
-- tiap scan baru, jadi aman dikosongkan sekarang.
DELETE FROM invest_raw;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invest_raw_dedup
  ON invest_raw(owner, tanggal, bettor, pasaran, periode, game);
