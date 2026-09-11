---
name: dont-break-working-logic
description: "Saat menambah fitur/desain di Day-Group Panel, jangan ubah perilaku bagian yang sudah benar"
metadata: 
  node_type: memory
  pinned: true
  originSessionId: e25bb91f-1271-4c1d-8610-18c5c58b8ef7
  modified: 2026-09-09T20:20:23.465Z
---

Pemilik Day-Group Panel (`panel-worker`) menekankan: **saat mengerjakan
peningkatan desain atau fitur baru, bagian yang sebelumnya sudah benar
JANGAN sampai rusak logikanya.** Dia menyebut ini setelah sebuah polish
"count-up angka" (anime.js) diam-diam merusak tampilan kartu statistik
`lapStatCard` yang nilainya berupa string gabungan seperti
`"2 (2,632,014,000)"` — transformasi generik (strip semua non-digit lalu
format ulang) menabrak input yang bentuknya tidak seragam.

Pelajaran yang berlaku ke depan:
- Perubahan "pemanis" (animasi, styling, helper generik) harus **aditif** dan
  tidak boleh mengubah nilai/among-output yang sudah tampil benar.
- Sebelum menerapkan transinformasi generik ke banyak call-site, cek semua
  bentuk argumen yang mungkin masuk (angka murni vs string gabungan vs teks).
- Kalau ragu, batasi dengan guard ketat (regex/whitelist) sehingga hanya
  kasus yang jelas aman yang kena efek baru; sisanya render apa adanya.
- Setelah deploy perubahan luas, sanity-check menu-menu inti, bukan cuma yang
  diedit.
