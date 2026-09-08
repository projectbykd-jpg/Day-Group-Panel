// ============================================================================
// ActivityLog.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// Activity Log: sheet, format, rollover harian, BackUp, retensi, prune registry.
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================


// ==========================================================
// LOGIN & ACTIVITY LOG TERPUSAT
// Sheet dibuat otomatis: Activity Log
// Kolom: Waktu | Username | Aksi | Status | Detail | Isi / Data
// ==========================================================
const ACTIVITY_LOG_SHEET = "Activity Log";
const ACTIVITY_BACKUP_SHEET = "BackUp Activity Log";
const ACTIVITY_LOG_HEADERS = ["Tanggal / Waktu", "Username", "Aksi", "Status", "Detail", "Isi / Data"];
const ACTIVITY_BACKUP_HEADERS = ACTIVITY_LOG_HEADERS.concat(["Backup ID", "Dipindahkan Pada"]);
const ACTIVITY_LOG_COLS = 6;
const ACTIVITY_BACKUP_COLS = 8;
const ACTIVITY_LOG_SPARE_ROWS = 25;
const ACTIVITY_SCHEMA_VERSION_ = "SMART-ACTIVITY-V6";
const ACTIVITY_DASHBOARD_MAX_SCAN_ = 1500;

// RETENSI RIWAYAT AKTIVITAS
// Semua log hanya disimpan di file utama ini: "Activity Log" (hari ini) +
// "BackUp Activity Log" (riwayat). Tidak ada lagi spreadsheet arsip terpisah.
// Baris di "BackUp Activity Log" yang lebih tua dari ACTIVITY_RETENTION_DAYS_ hari
// (dihitung dari hari ini, GMT+7) DIHAPUS PERMANEN saat hari berganti / backup manual.
const ACTIVITY_RETENTION_DAYS_ = 7;
const DASHBOARD_CACHE_SECONDS_ = 20; // cache singkat biar ganti tab/klik-klik cepat tidak scan ulang sheet

function checkLoginLegacy_(username, password) {
  const cleanUser = String(username || "").trim();
  try {
    const profile = getUserProfile_(cleanUser);
    if (!profile) {
      logActivity_(cleanUser || "UNKNOWN", "LOGIN", "Username tidak ditemukan", "GAGAL", "");
      return { success: false, message: "Username atau Password Salah!" };
    }
    if (profile.status !== "AKTIF") {
      logActivity_(cleanUser, "LOGIN", "Akun tidak aktif: " + profile.status, "GAGAL", "");
      return { success:false, message:"Akun sedang " + profile.status.toLowerCase() + ". Hubungi admin." };
    }
    if (profile.lockedUntil && new Date(profile.lockedUntil).getTime() > Date.now()) {
      return { success:false, message:"Akun terkunci sementara. Coba lagi nanti." };
    }
    if (String(profile.password) !== String(password)) {
      registerFailedLogin_(profile);
      logActivity_(cleanUser, "LOGIN", "Password salah", "GAGAL", "");
      return { success:false, message:"Username atau Password Salah!" };
    }
    resetFailedLogin_(profile);
    updateLastLogin_(profile);
    const maintenance = getMaintenanceSettings_();
    if (maintenance.enabled && profile.role !== "ADMIN") {
      // Tidak menolak login: member masuk lalu panel menampilkan overlay maintenance.
      logActivity_(cleanUser, "LOGIN", "Login saat mode maintenance (pengiriman dikunci)", "INFO", maintenance.message);
    }
    logActivity_(cleanUser, "LOGIN", "Login berhasil ke Day-Group Panel", "BERHASIL", "");
    return {
      success:true, user:cleanUser, role:profile.role, displayName:profile.displayName,
      timeout:profile.timeout, permissions:profile.permissions, websites:profile.websites,
      maintenance:maintenance
    };
  } catch (err) {
    logActivity_(cleanUser || "UNKNOWN", "LOGIN", "Kesalahan validasi login: " + err.message, "ERROR", "");
    return { success:false, message:"Terjadi kesalahan saat login." };
  }
}

/**
 * Mencatat aktivitas ke satu sheet pusat.
 * @param {string} username
 * @param {string} action
 * @param {string} detail
 * @param {string=} status
 * @param {string=} content
 */
function activitySafeSheetText_(value) {
  const text = String(value == null ? "" : value);
  // Google Sheets menganggap teks yang diawali =, +, -, atau @ sebagai formula.
  // Apostrof membuatnya tetap menjadi teks biasa dan tidak terlihat di tampilan sel.
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function logActivityLegacy_(username, action, detail, status, content) {
  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(20000);
    const sheet = getOrCreateActivityLogSheet_();

    // Pergantian hari diproses otomatis sebelum baris baru ditulis.
    // Dengan cara ini backup tetap berjalan walau trigger belum dipasang.
    rolloverActivityLogIfNeeded_(sheet, false);

    const targetRow = getFirstEmptyLogRow_(sheet);
    const waktuLokal = Utilities.formatDate(new Date(), PREDICTION_TIMEZONE_ || "GMT+7", "dd/MM/yyyy HH:mm:ss");

    sheet.getRange(targetRow, 1, 1, ACTIVITY_LOG_COLS).setValues([[
      activitySafeSheetText_(waktuLokal),
      activitySafeSheetText_(String(username || "UNKNOWN").trim() || "UNKNOWN"),
      activitySafeSheetText_(String(action || "AKTIVITAS").trim()),
      activitySafeSheetText_(String(status || "INFO").trim().toUpperCase()),
      activitySafeSheetText_(String(detail || "").trim()),
      activitySafeSheetText_(String(content || ""))
    ]]);

    formatActivityLogRow_(sheet, targetRow);
    ensureActivityLogSize_(sheet, targetRow);
    return true;
  } catch (err) {
    console.error("Gagal mencatat Activity Log: " + err.message);
    return false;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function getOrCreateActivityLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVITY_LOG_SHEET);
  if (!sheet) sheet = ss.insertSheet(ACTIVITY_LOG_SHEET, 0);

  if (sheet.getMaxColumns() < ACTIVITY_LOG_COLS) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), ACTIVITY_LOG_COLS - sheet.getMaxColumns());
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "activity-schema-" + sheet.getSheetId() + "-" + ACTIVITY_SCHEMA_VERSION_;
  if (cache.get(cacheKey)) return sheet;

  const headerRange = sheet.getRange(1, 1, 1, ACTIVITY_LOG_COLS);
  const currentHeaders = headerRange.getDisplayValues()[0];
  if (currentHeaders.join("|") !== ACTIVITY_LOG_HEADERS.join("|")) {
    headerRange.setValues([ACTIVITY_LOG_HEADERS]);
  }

  styleActivitySheet_(sheet, ACTIVITY_LOG_COLS, "#0f766e", [160, 130, 205, 110, 430, 470], [2, 4]);

  // Memperbaiki log lama yang terlanjur dibaca sebagai formula (teks gabungan
  // COPY lama yang diawali =====). Ini pembersihan SEKALI SEUMUR HIDUP — dulu
  // jalan tiap cache-miss 6 jam dan getFormulas() 1.500 baris bikin buka menu
  // Aktivitas kadang lemot. Sekarang ditandai property permanen.
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty("DG_ACTIVITY_FORMULA_REPAIRED_V1")) {
      repairActivityFormulaCells_(sheet);
      props.setProperty("DG_ACTIVITY_FORMULA_REPAIRED_V1", "1");
    }
  } catch (e) {}

  sheet.setTabColor("#14b8a6");
  cache.put(cacheKey, "1", 21600);
  return sheet;
}

function getFirstEmptyLogRow_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const nextRow = Math.max(lastRow + 1, 2);
  if (nextRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(ACTIVITY_LOG_SPARE_ROWS, nextRow - sheet.getMaxRows()));
  }
  return nextRow;
}

function formatActivityLogRow_(sheet, row) {
  // Baris belang diurus oleh row-banding (styleActivitySheet_). Di sini cukup
  // rapikan perataan + beri warna semantik pada sel Status saja.
  sheet.getRange(row, 1, 1, ACTIVITY_LOG_COLS)
    .setFontFamily("Roboto Mono")
    .setFontSize(10)
    .setVerticalAlignment("middle")
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(row, 2).setHorizontalAlignment("center");

  const statusCell = sheet.getRange(row, 4);
  const status = String(statusCell.getDisplayValue()).toUpperCase();
  let color = "#e0f2fe";
  let fontColor = "#075985";

  if (status === "BERHASIL" || status === "TERKIRIM") {
    color = "#dcfce7";
    fontColor = "#166534";
  } else if (status === "GAGAL" || status === "ERROR") {
    color = "#fee2e2";
    fontColor = "#991b1b";
  } else if (status === "DIBLOKIR" || status === "SEBAGIAN") {
    color = "#fef3c7";
    fontColor = "#92400e";
  }

  statusCell
    .setBackground(color)
    .setFontColor(fontColor)
    .setFontWeight("bold")
    .setHorizontalAlignment("center");
}

function ensureActivityLogSize_(sheet, lastWrittenRow) {
  const requiredRows = Math.max(lastWrittenRow + ACTIVITY_LOG_SPARE_ROWS, 50);
  const maxRows = sheet.getMaxRows();
  if (maxRows < requiredRows) {
    sheet.insertRowsAfter(maxRows, requiredRows - maxRows);
  }
}


function repairActivityFormulaCells_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;

  const rowCount = Math.min(sheet.getLastRow() - 1, 1500);
  const startRow = Math.max(2, sheet.getLastRow() - rowCount + 1);
  const range = sheet.getRange(startRow, 1, rowCount, ACTIVITY_LOG_COLS);
  const values = range.getValues();
  const formulas = range.getFormulas();
  let repaired = 0;

  for (let r = 0; r < formulas.length; r++) {
    for (let c = 0; c < formulas[r].length; c++) {
      const formula = String(formulas[r][c] || "");
      if (!formula) continue;
      values[r][c] = activitySafeSheetText_(formula);
      repaired++;
    }
  }

  if (repaired) {
    range.setValues(values);
    SpreadsheetApp.flush();
  }
  return repaired;
}

function repairActivityLogTextErrorsInternal_(adminUsername) {
  if (adminUsername) requireAdmin_(adminUsername);
  const current = getOrCreateActivityLogSheet_();
  const backup = getOrCreateActivityBackupSheet_();
  const currentFixed = repairActivityFormulaCells_(current);
  const backupFixed = repairActivityFormulaCells_(backup);
  return {
    success: true,
    repaired: currentFixed + backupFixed,
    current: currentFixed,
    backup: backupFixed,
    message: (currentFixed + backupFixed) + " sel log berhasil diperbaiki menjadi teks biasa."
  };
}


function getOrCreateActivityBackupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVITY_BACKUP_SHEET);
  if (!sheet) sheet = ss.insertSheet(ACTIVITY_BACKUP_SHEET);

  if (sheet.getMaxColumns() < ACTIVITY_BACKUP_COLS) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), ACTIVITY_BACKUP_COLS - sheet.getMaxColumns());
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "activity-backup-schema-" + sheet.getSheetId() + "-" + ACTIVITY_SCHEMA_VERSION_;
  if (cache.get(cacheKey)) return sheet;

  const headers = sheet.getRange(1, 1, 1, ACTIVITY_BACKUP_COLS).getDisplayValues()[0];
  if (headers.join("|") !== ACTIVITY_BACKUP_HEADERS.join("|")) {
    sheet.getRange(1, 1, 1, ACTIVITY_BACKUP_COLS).setValues([ACTIVITY_BACKUP_HEADERS]);
  }

  styleActivitySheet_(sheet, ACTIVITY_BACKUP_COLS, "#4338ca", [160, 130, 205, 110, 430, 470, 250, 170], [2, 4, 7, 8]);
  sheet.setTabColor("#6366f1");

  cache.put(cacheKey, "1", 21600);
  return sheet;
}

// Tata letak seragam untuk "Activity Log" & "BackUp Activity Log":
// header tebal berwarna, baris 1 + kolom Waktu dibekukan, lebar kolom pas,
// baris belang (banding) abu-abu lembut, dan filter siap pakai.
// centerCols = daftar nomor kolom (1-based) yang diratakan ke tengah.
function styleActivitySheet_(sheet, cols, headerBg, widths, centerCols) {
  const maxRows = Math.max(sheet.getMaxRows(), 2);

  sheet.getRange(1, 1, 1, cols)
    .setFontFamily("Roboto Mono")
    .setFontWeight("bold")
    .setFontSize(10)
    .setFontColor("#ffffff")
    .setBackground(headerBg)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.setRowHeight(1, 38);
  (widths || []).forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });

  const dataArea = sheet.getRange(2, 1, maxRows - 1, cols);
  dataArea
    .setFontFamily("Roboto Mono")
    .setFontSize(10)
    .setVerticalAlignment("middle")
    .setHorizontalAlignment("left")
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  (centerCols || []).forEach(function (col) {
    sheet.getRange(2, col, maxRows - 1, 1).setHorizontalAlignment("center");
  });

  // Baris belang di area DATA saja (baris 2 ke bawah) — header tetap warna sendiri.
  sheet.getBandings().forEach(function (banding) { try { banding.remove(); } catch (e) {} });
  try {
    sheet.getRange(2, 1, maxRows - 1, cols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  } catch (e) {}

  if (!sheet.getFilter()) {
    sheet.getRange(1, 1, maxRows, cols).createFilter();
  }
}

function activityBackupId_(row) {
  return contentHash_((row || []).slice(0, ACTIVITY_LOG_COLS).map(function (value) {
    return String(value == null ? "" : value);
  }).join("\u001f"));
}

// Tanggal batas retensi (ISO "yyyy-MM-dd"): hari ini dikurangi ACTIVITY_RETENTION_DAYS_.
// Baris backup dengan tanggal < batas ini akan dihapus permanen.
function activityRetentionCutoffIso_() {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ACTIVITY_RETENTION_DAYS_);
  return Utilities.formatDate(cutoff, "GMT+7", "yyyy-MM-dd");
}

// Pangkas "BackUp Activity Log": buang baris yang lebih tua dari batas retensi.
// Baris yang tanggalnya tidak terbaca sengaja DIPERTAHANKAN agar tidak ada data
// yang hilang gara-gara format sel aneh.
function pruneActivityBackupOldRows_() {
  const backup = getOrCreateActivityBackupSheet_();
  const lastRow = backup.getLastRow();
  if (lastRow < 2) return { removed: 0, kept: 0 };

  const cutoffIso = activityRetentionCutoffIso_();
  const values = backup.getRange(2, 1, lastRow - 1, ACTIVITY_BACKUP_COLS).getValues();
  const keep = [];
  values.forEach(function (row) {
    const hasData = row.some(function (v) { return String(v == null ? "" : v).trim() !== ""; });
    if (!hasData) return;
    const iso = activityIsoDate_(row[0]);
    if (!iso || iso >= cutoffIso) keep.push(row);
  });

  const removed = (lastRow - 1) - keep.length;
  if (removed <= 0) return { removed: 0, kept: keep.length, cutoff: cutoffIso };

  backup.getRange(2, 1, lastRow - 1, ACTIVITY_BACKUP_COLS).clearContent().clearFormat();
  if (keep.length) {
    backup.getRange(2, 1, keep.length, ACTIVITY_BACKUP_COLS).setValues(keep);
    backup.getRange(2, 8, keep.length, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  }
  // Terapkan ulang tata letak (banding + perataan) supaya tetap rapi setelah dipangkas.
  try {
    CacheService.getScriptCache().remove(
      "activity-backup-schema-" + backup.getSheetId() + "-" + ACTIVITY_SCHEMA_VERSION_
    );
    styleActivitySheet_(backup, ACTIVITY_BACKUP_COLS, "#4338ca", [160, 130, 205, 110, 430, 470, 250, 170], [2, 4, 7, 8]);
  } catch (e) {}
  SpreadsheetApp.flush();
  return { removed: removed, kept: keep.length, cutoff: cutoffIso };
}

// ==========================================================
// RETENSI SHEET REGISTRY — jaga sheet tetap kecil supaya baca/tulis cepat.
// Sheet ini hanya butuh data beberapa hari terakhir:
//   - "Sent Registry"            : penjaga anti-duplikat kiriman utama
//   - "Prediction Send Registry" : Smart Lock prediksi
//   - "Prediction Daily Content" : isi prediksi harian per website
// Baris yang lebih tua dari batas retensi dihapus permanen tiap hari berganti.
// ==========================================================
const REGISTRY_RETENTION_DAYS_ = 3;
const PREDICTION_CONTENT_RETENTION_DAYS_ = 2;

// Ambil tanggal ISO "yyyy-MM-dd" dari sel apa pun: objek Date, teks "yyyy-MM-dd..",
// atau teks "dd/MM/yyyy..". Kembalikan "" kalau tidak terbaca (baris dipertahankan).
function registryRowIso_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, "GMT+7", "yyyy-MM-dd");
  }
  const s = String(value || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] + "-" + m[2] + "-" + m[1];
  return "";
}

function pruneSheetOldRowsByDate_(sheetName, dateCol, retentionDays) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { sheet: sheetName, removed: 0, kept: 0, skipped: true };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sheet: sheetName, removed: 0, kept: 0 };

  const now = new Date();
  const cutoffIso = Utilities.formatDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays),
    "GMT+7", "yyyy-MM-dd"
  );

  const colValues = sheet.getRange(2, dateCol, lastRow - 1, 1).getValues();
  const drop = [];
  for (let i = 0; i < colValues.length; i++) {
    const iso = registryRowIso_(colValues[i][0]);
    if (iso && iso < cutoffIso) drop.push(i + 2);
  }
  if (!drop.length) return { sheet: sheetName, removed: 0, kept: lastRow - 1, cutoff: cutoffIso };

  // Gabungkan nomor baris jadi rentang kontigu lalu hapus dari bawah ke atas
  // (menghapus dari atas akan menggeser nomor baris di bawahnya).
  const ranges = [];
  let start = drop[0], prev = drop[0];
  for (let i = 1; i < drop.length; i++) {
    if (drop[i] === prev + 1) { prev = drop[i]; continue; }
    ranges.push([start, prev]); start = drop[i]; prev = drop[i];
  }
  ranges.push([start, prev]);
  for (let i = ranges.length - 1; i >= 0; i--) {
    sheet.deleteRows(ranges[i][0], ranges[i][1] - ranges[i][0] + 1);
  }
  SpreadsheetApp.flush();
  return { sheet: sheetName, removed: drop.length, kept: (lastRow - 1) - drop.length, cutoff: cutoffIso };
}

function pruneRegistrySheets_() {
  const out = [];
  try { out.push(pruneSheetOldRowsByDate_(SENT_REGISTRY_SHEET, 2, REGISTRY_RETENTION_DAYS_)); } catch (e) {}
  try { out.push(pruneSheetOldRowsByDate_(PREDICTION_REGISTRY_SHEET_, 1, REGISTRY_RETENTION_DAYS_)); } catch (e) {}
  try { out.push(pruneSheetOldRowsByDate_(PREDICTION_CONTENT_SHEET_, 1, PREDICTION_CONTENT_RETENTION_DAYS_)); } catch (e) {}
  return out;
}

function rolloverActivityLogIfNeeded_(activitySheet, force) {
  const sheet = activitySheet || getOrCreateActivityLogSheet_();
  const today = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = "DAYGROUP_ACTIVITY_ACTIVE_DATE";
  const activeDate = properties.getProperty(propertyKey);

  if (!force && activeDate === today) {
    return { moved: 0, kept: Math.max(sheet.getLastRow() - 1, 0) };
  }

  // Hari berganti (atau backup manual dipaksa) -> ini momen yang tepat untuk
  // memangkas riwayat lama. Karena guard di atas, ini jalan paling banyak 1x/hari.
  let prunedInfo = null;
  try { prunedInfo = pruneActivityBackupOldRows_(); } catch (pruneErr) {}
  // Pangkas juga sheet registry (Sent Registry / Prediction Send Registry /
  // Prediction Daily Content) supaya baca/tulis saat posting tetap ringan.
  try { pruneRegistrySheets_(); } catch (regErr) {}

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    properties.setProperty(propertyKey, today);
    return { moved: 0, kept: 0, pruned: prunedInfo };
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, ACTIVITY_LOG_COLS).getValues();
  const keepRows = [];
  const oldRows = [];

  rows.forEach(function (row, index) {
    const hasData = row.some(function (value) {
      return String(value == null ? "" : value).trim() !== "";
    });
    if (!hasData) return;

    const timestamp = String(row[0] || "").trim();
    if (timestamp.indexOf(today) === 0) {
      keepRows.push(row);
    } else {
      oldRows.push({ row: row, originalRow: index + 2 });
    }
  });

  if (!oldRows.length) {
    properties.setProperty(propertyKey, today);
    return { moved: 0, kept: keepRows.length, pruned: prunedInfo };
  }

  const backup = getOrCreateActivityBackupSheet_();
  const backupLast = backup.getLastRow();
  const existingIds = new Set();

  if (backupLast >= 2) {
    const count = Math.min(backupLast - 1, 10000);
    const start = backupLast - count + 1;
    backup.getRange(start, 7, count, 1).getDisplayValues().forEach(function (row) {
      if (row[0]) existingIds.add(String(row[0]));
    });
  }

  const movedAt = new Date();
  const appendRows = oldRows.map(function (item) {
    const id = contentHash_(
      activityBackupId_(item.row) + "|" + item.originalRow
    );
    return { id: id, values: item.row.concat([id, movedAt]) };
  }).filter(function (item) {
    return !existingIds.has(item.id);
  }).map(function (item) {
    return item.values;
  });

  if (appendRows.length) {
    const startRow = backup.getLastRow() + 1;
    backup.getRange(startRow, 1, appendRows.length, ACTIVITY_BACKUP_COLS).setValues(appendRows);
    backup.getRange(startRow, 8, appendRows.length, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
    backup.getRange(startRow, 1, appendRows.length, ACTIVITY_BACKUP_COLS)
      .setVerticalAlignment("middle")
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }

  sheet.getRange(2, 1, Math.max(lastRow - 1, 1), ACTIVITY_LOG_COLS).clearContent().clearFormat();
  if (keepRows.length) {
    sheet.getRange(2, 1, keepRows.length, ACTIVITY_LOG_COLS).setValues(keepRows);
    for (let i = 0; i < keepRows.length; i++) {
      formatActivityLogRow_(sheet, i + 2);
    }
  }

  properties.setProperty(propertyKey, today);
  SpreadsheetApp.flush();
  return { moved: oldRows.length, appended: appendRows.length, kept: keepRows.length, pruned: prunedInfo };
}

function runDailyActivityBackup() {
  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(30000);
    // rolloverActivityLogIfNeeded_ (force) sudah sekalian memangkas "BackUp Activity
    // Log" ke retensi ACTIVITY_RETENTION_DAYS_ hari (lihat result.pruned).
    const result = rolloverActivityLogIfNeeded_(getOrCreateActivityLogSheet_(), true);
    if (!result.pruned) {
      try { result.pruned = pruneActivityBackupOldRows_(); } catch (error) {}
    }
    return result;
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

// ==========================================================
// ARSIP KE SPREADSHEET TERPISAH — DINONAKTIFKAN
// Dulu isi "BackUp Activity Log" dipindahkan ke file "Day-Group Arsip Activity
// Log <tahun>" saat tembus ambang. Sekarang TIDAK dipakai lagi: seluruh riwayat
// hidup di file utama saja dan dibatasi ACTIVITY_RETENTION_DAYS_ hari terakhir
// (pruneActivityBackupOldRows_). Fungsi di bawah dibiarkan sebagai no-op supaya
// pemanggil lama / trigger lama tidak error, dan file arsip lama tetap bisa
// dibuka manual di Google Drive kalau sewaktu-waktu dibutuhkan.
// ==========================================================
const ACTIVITY_ARCHIVE_FILE_PREFIX_ = "Day-Group Arsip Activity Log";

function rotateActivityBackupIfLarge_() {
  return { rotated: false, disabled: true, rows: 0 };
}

function setupActivityBackupTriggerInternal_(adminUsername) {
  if (adminUsername) requireAdmin_(adminUsername);

  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === "runDailyActivityBackup";
  });

  if (!existing.length) {
    ScriptApp.newTrigger("runDailyActivityBackup")
      .timeBased()
      .everyDays(1)
      .atHour(0)
      .nearMinute(5)
      .create();
  }

  if (adminUsername) {
    logActivity_(
      adminUsername,
      "SETUP AUTO BACKUP",
      "Trigger backup harian Activity Log aktif sekitar 00:05 GMT+7",
      "BERHASIL",
      ""
    );
  }

  return {
    success: true,
    installed: true,
    message: existing.length
      ? "Auto Backup sudah aktif."
      : "Auto Backup berhasil diaktifkan sekitar pukul 00:05 setiap hari."
  };
}

function adminRunActivityBackupInternal_(adminUsername) {
  requireAdmin_(adminUsername);
  const result = runDailyActivityBackup();
  logActivity_(
    adminUsername,
    "BACKUP ACTIVITY LOG",
    "Backup manual selesai. Dipindahkan: " + Number(result.moved || 0) + " baris.",
    "BERHASIL",
    ""
  );
  const pruned = result.pruned && Number(result.pruned.removed || 0) > 0
    ? " Retensi: " + result.pruned.removed + " baris lebih lama dari " + ACTIVITY_RETENTION_DAYS_ +
      " hari dihapus (sisa " + result.pruned.kept + " baris di " + ACTIVITY_BACKUP_SHEET + ")."
    : "";

  return {
    success: true,
    moved: Number(result.moved || 0),
    pruned: result.pruned ? Number(result.pruned.removed || 0) : 0,
    retentionDays: ACTIVITY_RETENTION_DAYS_,
    message: (Number(result.moved || 0)
      ? result.moved + " baris lama berhasil dipindahkan ke " + ACTIVITY_BACKUP_SHEET + "."
      : "Tidak ada aktivitas hari sebelumnya yang perlu dipindahkan.") + pruned
  };
}

function logLogout_(username) {
  return logActivity_(username, "LOGOUT", "User keluar dari panel", "BERHASIL", "");
}