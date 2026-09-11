---
name: prediction-double-external-source
description: "Auto-post prediksi 'double' di Day-Group Panel — sisi Worker sudah bersih, sumbernya EKSTERNAL"
metadata: 
  node_type: memory
  pinned: false
  originSessionId: e25bb91f-1271-4c1d-8610-18c5c58b8ef7
  modified: 2026-09-10T23:24:40.811Z
---

Pemilik berulang kali melaporkan **auto-post prediksi terkirim dobel** ke
channel Telegram (mis. pesan 06:14 dan 06:15, isi identik). Setelah beberapa
putaran perbaikan di `runAutoPostRouter` / `sendPredictionJob`
(RUN_LOCK KV, `prediction_registry` D1 Smart Lock, atomic-claim read-back
`request_id`), **sisi Worker terbukti BENAR**:

Bukti (2026-09-11, slot PRED-2 06:15):
- `prediction_registry`: tepat SATU `request_id` per (slot, website), semua
  `BERHASIL`.
- `activity_log`: satu `KIRIM PREDIKSI AUTO BERHASIL` + satu tick barengan yang
  BENAR diblok jadi `SEDANG DIPROSES` (INFO).

Artinya pesan kedua di Telegram **tidak lewat Worker**. Sumber paling mungkin:
**Google Apps Script panel LAMA (V6Core.gs) yang trigger time-based-nya masih
aktif** dan masih pegang token Telegram yang sama. Worker & Apps Script punya
"memori anti-dobel" masing-masing sehingga tidak saling tahu.

**Solusi (bukan perubahan kode):** buka project Apps Script panel lama di
script.google.com → ikon **Triggers** (jam) → **hapus SEMUA trigger** (terutama
yang menjalankan `sendPredictionAuto` / `sendClosingPredictionAuto` / router
auto-post secara time-driven). Selama trigger itu hidup, dobel akan terus
terjadi apa pun yang diperbaiki di Worker.

Kalau setelah trigger Apps Script dihapus masih dobel: cek apakah ada DUA cron
eksternal (cron-job.org) yang sama-sama memanggil `job=autopost`/`job=all`
dengan jarak <60 dtk saat kirim Telegram lambat — itu pun sebetulnya sudah
diblok RUN_LOCK, tapi pastikan hanya ada satu.
