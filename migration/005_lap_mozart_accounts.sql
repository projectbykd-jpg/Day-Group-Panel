-- Pemetaan manual nomor rekening / id m-banking Mozart -> nama pemilik,
-- diisi user di menu Setting. Format tiap baris: "<identifier> = <Nama>".
-- Dipakai untuk melabeli tabel Bank Deposit / Bank Withdraw.
ALTER TABLE lap_credentials ADD COLUMN mozart_accounts TEXT DEFAULT '';
