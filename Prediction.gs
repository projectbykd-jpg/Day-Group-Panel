// ============================================================================
// Prediction.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// Generator prediksi, router auto-posting, Smart Lock registry prediksi, sendPredictionJobLegacy_.
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================


// ==========================================
// CONFIGURASI & GENERATE PREDIKSI AUTO POSTING
// ==========================================

const JADWAL_PREDIKSI_CONFIG = [
  { jam: "02:35", nama: "PREDIKSI CAROLINA EVE s/d OREGON 12", pasaran: ["CAROLINA EVE", "LISBON", "CAIRO", "DALLAS", "KHMER LOTTO", "OREGON 12"] },
  { jam: "06:15", nama: "PREDIKSI BULLSEYE s/d NEW MEXICO", pasaran: ["BULLSEYE", "BAHRAIN", "HK SIANG", "SAPPORO EVE", "TOTOMACAU 4D SIANG", "SYDNEY", "NEW MEXICO"] },
  { jam: "08:40", nama: "PREDIKSI IDAHO s/d THAILAND", pasaran: ["IDAHO", "TIONGKOK 4D", "TOTOMACAU 5D SIANG", "JAKARTA LOTTO", "BRAZIL LOTTO", "MANILA LOTTO", "BALI LOTTO", "TOTOMACAU 4D SORE", "LAOS SIANG", "TURKEY", "KINGKONG 4D SORE", "NIPPON LOTTO", "SINGAPORE", "THAILAND"] },
  { jam: "12:40", nama: "PREDIKSI PANAMA s/d KANSAS", pasaran: ["PANAMA", "MALAYSIA", "BUSAN", "TOTOMACAU 4D MALAM 1", "AUSTRIA", "PARIS", "INDIA", "LISBON NIGHT", "TAIPEI LOTTO", "OSAKA", "KANSAS"] },
  { jam: "16:00", nama: "PREDIKSI TOTOMACAU 5D MALAM s/d RUSIA", pasaran: ["TOTOMACAU 5D MALAM", "TOTOMACAU 4D MALAM", "BERLIN", "PARMA", "ROMA", "HONGKONG", "TOTOMACAU 4D MALAM 3", "KINGKONG 4D MALAM 2", "LAOS MALAM", "MEXICO", "RUSIA"] },
  { jam: "21:20", nama: "PREDIKSI TOTOMACAU 4D PAGI s/d OHIO", pasaran: ["TOTOMACAU 4D PAGI", "NEBRASKA", "KENTUCKY MID", "FLORIDA MID", "MONTANA", "SAPPORO", "NEWYORK MID", "MICHIGAN", "CAROLINA DAY", "OHIO"] },
  { jam: "23:25", nama: "PREDIKSI COLORADO s/d KENTUCKY EVE", pasaran: ["ARIZONA POOLS", "COLORADO", "OREGON 03", "CANADA POOLS", "INDIA MORNING", "ATHENS", "OREGON 06", "CALIFORNIA", "FLORIDA EVE", "OREGON 09", "NEWYORK EVE", "KENTUCKY EVE"] }
];

const DAFTAR_SHIO = [
  "ANJING - KUDA", "KERBAU - AYAM", "ANJING - ANJING", "HARIMAU - AYAM", 
  "BABI - AYAM", "MONYET - HARIMAU", "NAGA - KELINCI", "ULAR - TIKUS", 
  "KAMBING - KUDA", "BABI - TIKUS", "KERBAU - NAGA", "MONYET - AYAM"
];

function generatePrediksiText_(namaPasaran) {
  let tarung1 = Math.floor(1000 + Math.random() * 9000);
  let tarung2 = Math.floor(1000 + Math.random() * 9000);
  let bbfs = Math.floor(10000 + Math.random() * 90000).toString();
  let shioPilihan = DAFTAR_SHIO[Math.floor(Math.random() * DAFTAR_SHIO.length)];

  let b1 = bbfs.charAt(0);
  let b2 = bbfs.charAt(1);
  let b3 = bbfs.charAt(2);
  let b4 = bbfs.charAt(3);

  let line12 = [
    b1 + b2, b1 + b3, b1 + b4, 
    b2 + b2, b2 + b3, b2 + b1, 
    b3 + b4, b3 + b1, b3 + b2, 
    b4 + b1, b4 + b3, b4 + b3
  ].join(" ");

  let hasil = `PREDIKSI <${namaPasaran}> HARI INI\n\n`;
  hasil += `ANGKA TARUNG:\n${tarung1} vs ${tarung2}\n\n`;
  hasil += `BBFS 5 DIGIT : ${bbfs}\n\n`;
  hasil += `TEBAK SHIO : ${shioPilihan}\n\n`;
  hasil += `TOP 2D 12 LINE  🔥\n\n${line12}\n\n`;

  return hasil;
}


function predictionSeededRandom_(seedText) {
  let state = parseInt(contentHash_(String(seedText || "")).substring(0, 8), 16) >>> 0;
  if (!state) state = 0x6d2b79f5;
  return function () {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function predictionRandomInt_(randomFn, min, max) {
  return Math.floor(randomFn() * (max - min + 1)) + min;
}

function generatePrediksiTextForWebsite_(namaPasaran, seedKey) {
  const random = predictionSeededRandom_(seedKey);
  const tarung1 = predictionRandomInt_(random, 1000, 9999);
  let tarung2 = predictionRandomInt_(random, 1000, 9999);
  if (tarung2 === tarung1) tarung2 = tarung2 === 9999 ? 1000 : tarung2 + 1;

  const bbfs = String(predictionRandomInt_(random, 10000, 99999));
  const shioPilihan = DAFTAR_SHIO[predictionRandomInt_(random, 0, DAFTAR_SHIO.length - 1)];

  const b1 = bbfs.charAt(0);
  const b2 = bbfs.charAt(1);
  const b3 = bbfs.charAt(2);
  const b4 = bbfs.charAt(3);
  const line12 = [
    b1 + b2, b1 + b3, b1 + b4,
    b2 + b2, b2 + b3, b2 + b1,
    b3 + b4, b3 + b1, b3 + b2,
    b4 + b1, b4 + b3, b4 + b3
  ].join(" ");

  let hasil = "PREDIKSI <" + namaPasaran + "> HARI INI\n\n";
  hasil += "ANGKA TARUNG:\n" + tarung1 + " vs " + tarung2 + "\n\n";
  hasil += "BBFS 5 DIGIT : " + bbfs + "\n\n";
  hasil += "TEBAK SHIO : " + shioPilihan + "\n\n";
  hasil += "TOP 2D 12 LINE  🔥\n\n" + line12 + "\n\n";
  return hasil;
}

function prosesAutoPostByJadwalInternal_(targetJam, usernameTarget) {
  const index = JADWAL_PREDIKSI_CONFIG.findIndex(function (item) {
    return item.jam === targetJam;
  });
  if (index < 0) {
    return { success: false, message: "Jadwal untuk jam " + targetJam + " tidak ditemukan." };
  }
  return sendPredictionAutoInternal_(index, usernameTarget || "Hugo");
}

function triggerManualPredictionInternal_(index, username) {
  return sendPredictionAutoInternal_(index, username || "Hugo");
}

function getPredictionStatusDataInternal_(username) {
  const profile = getUserProfile_(String(username || "").trim());
  const dateKey = predictionTodayKey_();
  const registry = readPredictionRegistryForDate_(dateKey);
  const websites = profile
    ? Array.from(new Set((profile.websites || []).map(function (site) {
        return String(site || "").trim().toUpperCase();
      }).filter(Boolean)))
    : [];
  const telegramAllowed = !!(profile && profile.permissions && profile.permissions.telegram);

  const schedules = JADWAL_PREDIKSI_CONFIG.map(function (item, index) {
    return buildPredictionScheduleStatus_(
      predictionScheduleId_(index),
      item.nama,
      item.jam,
      websites,
      registry,
      !!profile,
      telegramAllowed
    );
  });

  const activeSlot = getActiveClosingSlot_();
  const closingSlots = CLOSING_PREDICTION_SLOTS_.map(function (slot) {
    const state = buildPredictionScheduleStatus_(
      closingScheduleId_(slot),
      CLOSING_PREDICTION_NAME_,
      slot,
      websites,
      registry,
      !!profile,
      telegramAllowed
    );
    state.slot = slot;
    return state;
  });

  let infoText = "Klik SEND AUTO. Smart Content Akan memeriksa tanggal, sesi, website, dan variasi isi sebelum Telegram dikirim.";
  if (!profile) infoText = "User tidak ditemukan. Silakan login ulang.";
  else if (!telegramAllowed) infoText = "Akses Telegram pada Sheet Users belum diaktifkan untuk akun ini.";
  else if (!websites.length) infoText = "Akun ini belum memiliki akses website pada Sheet Users.";

  return {
    serverVersion: "SMART-CONTENT-V5.1",
    infoText: infoText,
    dateKey: dateKey,
    websites: websites,
    telegramAllowed: telegramAllowed,
    schedules: schedules,
    closing: {
      kind: "closing",
      name: CLOSING_PREDICTION_NAME_,
      time: "06:15 & 16:00",
      activeSlot: activeSlot,
      totalWebsites: websites.length,
      exampleText: buildClosingPredictionMessage_("HUGO", new Date(), activeSlot),
      slots: closingSlots
    }
  };
}

function buildPredictionScheduleStatus_(scheduleId, name, time, websites, registry, hasProfile, telegramAllowed) {
  const siteStatus = websites.map(function (website) {
    const entry = registry[scheduleId + "||" + website] || null;
    const status = entry && entry.status === "PROCESSING" && !entry.processingFresh
      ? "BELUM DIKIRIM"
      : (entry ? entry.status : "BELUM DIKIRIM");
    return {
      website: website,
      status: status,
      username: entry ? entry.username : "",
      time: entry ? entry.timeText : ""
    };
  });

  const sentCount = siteStatus.filter(function (site) {
    return site.status === "BERHASIL";
  }).length;
  const processingCount = siteStatus.filter(function (site) {
    return site.status === "PROCESSING";
  }).length;
  const totalWebsites = websites.length;
  let status = "ACTIVE";

  if (!hasProfile || !telegramAllowed || totalWebsites === 0) status = "NO_ACCESS";
  else if (sentCount === totalWebsites) status = "POSTED";
  else if (sentCount > 0 || processingCount > 0) status = "PARTIAL";

  return {
    name: name,
    time: time,
    status: status,
    sentCount: sentCount,
    processingCount: processingCount,
    totalWebsites: totalWebsites,
    pendingCount: Math.max(totalWebsites - sentCount - processingCount, 0),
    websiteStatus: siteStatus
  };
}

// ==========================================================
// AUTO POSTING PREDIKSI — digerakkan oleh SESI LOGIN
// Selama ada user yang punya sesi aktif, router (cek tiap 5 menit)
// mengirim prediksi tiap sesi jam + kata-kata penutup untuk website milik
// user tersebut. Kalau dua akun berbagi website yang sama, Smart Lock
// registry memblokir kiriman kedua -> jadi hanya salah satu akun yang posting.
// Tidak ada user login = auto posting mati.
// ==========================================================
// Sesi jam yang jamnya sudah lewat sampai <= sekian MENIT TETAP disusulkan selama
// belum lengkap terkirim (mis. trigger baru dipasang, atau sempat tidak ada yang
// login saat jamnya). Melebihi ini dianggap "terlalu basi" dan dilewati.
//
// PENTING: dulu 10 JAM. Itu bikin sesi 16:00 masih "jatuh tempo" sampai 23:59,
// lalu retry-nya menyeberang tengah malam -> sendPredictionJob_ menghitung ulang
// tanggal jadi HARI BERIKUTNYA -> Smart Lock (kunci per tanggal) tidak memblokir
// -> kata-kata penutup / prediksi ikut terkirim jam 00:xx padahal bukan jamnya.
// 90 menit cukup untuk toleransi jitter cron + user yang telat login, dan tidak
// pernah menyentuh tengah malam.
const AUTOPOST_CATCHUP_MINUTES_ = 90;
// Maks percobaan gagal per slot sebelum dikunci (stop spam retry tiap 5 menit).
const AUTOPOST_MAX_FAIL_ATTEMPTS_ = 4;

function setupAutoPostTriggersInternal_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const fn = trigger.getHandlerFunction();
    if (fn === "triggerRouterAutoPost" || fn === "autoPostPredictionRouter") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // everyMinutes(5): Apps Script tidak bisa fire tepat di menit tertentu (mis. 06:15).
  // Trigger fire di offset acak pilihan Google + jitter. Interval 5 menit = delay
  // paling banyak ~5-7 menit dari jam sesi, tanpa memboroskan kuota eksekusi harian.
  ScriptApp.newTrigger("autoPostPredictionRouter")
    .timeBased()
    .everyMinutes(5)
    .create();

  ensureAutoPostSettingRow_();

  // Susulan sesi hari ini dijalankan di latar belakang (tidak menahan respons).
  try { autoPostScheduleRunner_(); } catch (e) {}

  return {
    success: true,
    installed: true,
    message: "Auto Posting Prediksi aktif (router cek tiap 5 menit). Susulan sesi hari ini dijalankan di latar belakang sesaat lagi."
  };
}

// Dipanggil dari tombol admin "JALANKAN SEKARANG" — jalan langsung, susulkan
// semua sesi hari ini yang belum lengkap.
function adminRunAutoPostNowInternal_(adminUsername) {
  requireAdmin_(adminUsername);
  const result = autoPostPredictionRouter({ force: true }) || {};
  logActivity_(adminUsername, "AUTO POST MANUAL",
    result.message || "Router auto posting dijalankan manual.",
    result.failed ? "SEBAGIAN" : "BERHASIL", "");
  return { success: true, message: result.message || "Router dijalankan. Cek menu Aktivitas / Telegram." };
}

// Baris kill-switch di Sheet Settings. Kalau baris belum ada -> dianggap aktif.
function ensureAutoPostSettingRow_() {
  try {
    const sh = getSettingsSheet_();
    const vals = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues();
    const exists = vals.some(function (r) {
      return String(r[0] || "").toLowerCase().trim() === "auto post prediksi";
    });
    if (!exists) {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([["Auto Post Prediksi", "TRUE"]]);
    }
  } catch (e) {}
}

function isAutoPostEnabled_() {
  try {
    const sh = getSettingsSheet_();
    const vals = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || "").toLowerCase().trim() === "auto post prediksi") {
        return String(vals[i][1] || "").toUpperCase().trim() !== "FALSE";
      }
    }
  } catch (e) {}
  return true;
}

// Username unik dari semua sesi yang belum kedaluwarsa.
function getActiveSessionUsernames_() {
  const all = dgProps_().getProperties();
  const now = Date.now();
  const seen = {};
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(DG_SESSION_PREFIX_) !== 0) return;
    try {
      const rec = JSON.parse(all[key]);
      if (rec && rec.username && Number(rec.expiresAt) > now) {
        seen[String(rec.username).toLowerCase()] = rec.username;
      }
    } catch (e) {}
  });
  return Object.keys(seen).map(function (k) { return seen[k]; });
}

function autoPostSlotDue_(nowMinutes, slotMinutes, windowMinutes) {
  const diff = nowMinutes - slotMinutes;
  const maxAfter = (windowMinutes != null && windowMinutes > 0)
    ? windowMinutes
    : AUTOPOST_CATCHUP_MINUTES_;
  // -1: toleransi kalau cron eksternal fire beberapa detik sebelum jam pas.
  // Batas atas 1435: apa pun jangan dianggap "jatuh tempo" di ~15 menit terakhir
  // menjelang tengah malam, supaya retry tidak pernah menyeberang hari.
  return diff >= -1 && diff <= maxAfter && nowMinutes <= 1435;
}

// Gabungan (union) semua website milik user yang sedang login + izin Telegram.
// Tiap website hanya muncul sekali -> 1 pengiriman per sesi jam untuk SEMUA
// website sekaligus (1 batch Telegram fetchAll), bukan per-user.
function autoPostActiveWebsites_(usernames) {
  const set = {};
  usernames.forEach(function (u) {
    const p = getUserProfile_(u);
    if (!p || !p.permissions || !p.permissions.telegram) return;
    (p.websites || []).forEach(function (w) {
      const site = String(w || "").trim().toUpperCase();
      if (site) set[site] = true;
    });
  });
  return Object.keys(set);
}

// Jalankan satu sesi (sekali panggil untuk semua website).
// - Semua beres -> slot dikunci 6 jam (tick berikutnya tidak scan ulang).
// - Masih ada yang gagal/belum -> TIDAK dikunci, dicoba lagi tiap tick.
function autoPostRunSlot_(guardKey, sendFn, force) {
  const out = { attempted: false, sent: 0, already: 0, failed: 0 };
  if (!force) {
    try { if (dgCache_().get(guardKey)) return out; } catch (e) {}
  }
  out.attempted = true;

  let res;
  try { res = sendFn(); } catch (e) { return out; }

  if (res && res.counters) {
    out.sent = Number(res.counters.success || 0);
    out.already = Number(res.counters.already || 0);
    out.failed = Number(res.counters.failed || 0);
  }
  const hadFailure = !res || !res.counters || (res.pendingWebsites || []).length > 0;
  if (!hadFailure) {
    try { dgCache_().put(guardKey, "1", 21600); } catch (e) {}
  } else {
    // Retry tiap 5 menit itu wajar untuk kegagalan sesaat, TAPI kalau terus gagal
    // sampai lewat tengah malam si slot tetap "jatuh tempo" dan bisa keposting di
    // tanggal yang salah. Setelah AUTOPOST_MAX_FAIL_ATTEMPTS_ percobaan gagal,
    // pasang guard supaya berhenti nyoba sampai slot berikutnya.
    try {
      const attemptKey = guardKey + "_ATTEMPTS";
      const attempts = Number(dgCache_().get(attemptKey) || 0) + 1;
      if (attempts >= AUTOPOST_MAX_FAIL_ATTEMPTS_) {
        dgCache_().put(guardKey, "1", 21600);
        dgCache_().remove(attemptKey);
      } else {
        dgCache_().put(attemptKey, String(attempts), 21600);
      }
    } catch (e) {}
  }
  return out;
}

// HANDLER TRIGGER — dipanggil otomatis tiap 5 menit oleh Apps Script,
// dan langsung oleh webhook cron pada jam sesi.
// opts.force = true -> abaikan guard cache.
// opts.windowMinutes -> hanya proses sesi yang jatuh tempo <= N menit lalu.
function autoPostPredictionRouter(opts) {
  opts = opts || {};
  const summary = { ran: false, slots: 0, sent: 0, already: 0, failed: 0, message: "" };

  // Cadangan: tulis antrean Activity Log dari jalur kirim cepat, kalau-kalau tidak
  // ada poll live yang menuliskannya (mis. semua user tab-nya di belakang).
  try { dgFlushActivityQueue_(); } catch (e) {}

  if (!isAutoPostEnabled_()) {
    summary.message = "Auto Posting dimatikan (Settings: Auto Post Prediksi = FALSE).";
    return summary;
  }

  // Single-flight: cegah beberapa router jalan barengan (webhook + trigger 5 menit
  // + tombol manual) yang bikin rebutan lock.
  const RUN_FLAG = "AUTOPOST_ROUTER_RUNNING";
  let holdsFlag = false;
  try {
    if (dgCache_().get(RUN_FLAG)) {
      summary.message = "Router lain sedang berjalan — dilewati.";
      return summary;
    }
    dgCache_().put(RUN_FLAG, "1", 300);
    holdsFlag = true;
  } catch (e) {}

  try {
    const usernames = getActiveSessionUsernames_();
    if (!usernames.length) {
      summary.message = "Tidak ada user yang sedang login, jadi tidak ada yang diposting.";
      return summary;
    }

    const websites = autoPostActiveWebsites_(usernames);
    if (!websites.length) {
      summary.message = "Tidak ada user login yang punya izin Telegram + website.";
      return summary;
    }

    const now = new Date();
    const nowMinutes =
      Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "HH")) * 60 +
      Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "mm"));
    const dateKey = predictionTodayKey_();

    // Prebuild konten untuk sesi yang akan jatuh tempo 1-12 menit lagi, supaya
    // saat webhook nembak tepat di jamnya, tinggal kirim (cepat). Murah kalau
    // konten sudah ada.
    if (opts.windowMinutes == null) {
      JADWAL_PREDIKSI_CONFIG.forEach(function (item, index) {
        const parts = String(item.jam).split(":");
        const lead = (Number(parts[0]) * 60 + Number(parts[1])) - nowMinutes;
        if (lead > 0 && lead <= 12) {
          try { getOrCreateDailyPredictionContents_(index, websites); } catch (e) {}
        }
      });
    }

    const runOne = function (guardKey, sendFn) {
      const res = autoPostRunSlot_(guardKey, sendFn, !!opts.force);
      if (res.attempted) {
        summary.ran = true;
        summary.slots++;
        summary.sent += res.sent;
        summary.already += res.already;
        summary.failed += res.failed;
      }
    };

    JADWAL_PREDIKSI_CONFIG.forEach(function (item, index) {
      const parts = String(item.jam).split(":");
      const slotMinutes = Number(parts[0]) * 60 + Number(parts[1]);
      if (!autoPostSlotDue_(nowMinutes, slotMinutes, opts.windowMinutes)) return;
      runOne(
        "AUTOPOST_" + dateKey + "_" + predictionScheduleId_(index),
        // dateKey DIKUNCI di sini -> job yang mulai sebelum tengah malam tidak
        // "berpindah hari" saat selesai (penyebab post jam 00:xx).
        function () { return sendPredictionAutoSystemInternal_(index, websites, dateKey); }
      );
    });

    CLOSING_PREDICTION_SLOTS_.forEach(function (slot) {
      const parts = String(slot).split(":");
      const slotMinutes = Number(parts[0]) * 60 + Number(parts[1]);
      if (!autoPostSlotDue_(nowMinutes, slotMinutes, opts.windowMinutes)) return;
      runOne(
        "AUTOPOST_" + dateKey + "_" + closingScheduleId_(slot),
        function () { return sendClosingPredictionAutoSystemInternal_(websites, slot, dateKey); }
      );
    });

    summary.message = summary.ran
      ? (summary.slots + " sesi diproses — terkirim " + summary.sent +
         ", sudah ada " + summary.already + ", gagal " + summary.failed)
      : "Belum ada sesi jam yang jatuh tempo untuk disusulkan saat ini.";
    return summary;
  } finally {
    if (holdsFlag) { try { dgCache_().remove(RUN_FLAG); } catch (e) {} }
  }
}

// Ubah "yyyy-MM-dd" jadi Date (siang hari, GMT+7) supaya teks tanggal di pesan
// mengikuti hari sesi, bukan "hari ini" saat job kebetulan selesai lewat tengah malam.
function dateKeyToDate_(dateKey) {
  const m = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

// Auto posting mode SISTEM: kirim 1 sesi ke SEMUA website sekaligus (bukan
// per-user). Smart Lock registry tetap mencegah duplikat.
function sendPredictionAutoSystemInternal_(index, websites, dateKey) {
  const scheduleIndex = Number(index);
  const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
  if (!config) {
    return { success: false, blocked: true, message: "Jadwal prediksi tidak ditemukan.", websiteResults: [], kind: "schedule" };
  }
  const sites = Array.from(new Set((websites || []).map(function (w) {
    return String(w || "").trim().toUpperCase();
  }).filter(Boolean)));
  if (!sites.length) {
    return { success: false, blocked: true, message: "Tidak ada website.", websiteResults: [], kind: "schedule" };
  }

  const contents = getOrCreateDailyPredictionContents_(scheduleIndex, sites);
  return sendPredictionJob_({
    username: "AUTO",
    systemWebsites: sites,
    dateKey: dateKey || predictionTodayKey_(),
    scheduleId: predictionScheduleId_(scheduleIndex),
    predictionName: config.nama,
    predictionIndex: scheduleIndex,
    kind: "schedule",
    logAction: "KIRIM PREDIKSI AUTO",
    messageForWebsite: function (website) {
      return String(contents[String(website || "").trim().toUpperCase()] || "");
    }
  });
}

function sendClosingPredictionAutoSystemInternal_(websites, slot, dateKey) {
  const activeSlot = normalizeClosingSlot_(slot);
  const jobDateKey = dateKey || predictionTodayKey_();
  const jobDate = dateKeyToDate_(jobDateKey);
  const sites = Array.from(new Set((websites || []).map(function (w) {
    return String(w || "").trim().toUpperCase();
  }).filter(Boolean)));
  if (!sites.length) {
    return { success: false, blocked: true, message: "Tidak ada website.", websiteResults: [], kind: "closing" };
  }

  return sendPredictionJob_({
    username: "AUTO",
    systemWebsites: sites,
    dateKey: jobDateKey,
    scheduleId: closingScheduleId_(activeSlot),
    predictionName: CLOSING_PREDICTION_NAME_ + " · " + activeSlot,
    predictionIndex: -1,
    kind: "closing",
    activeSlot: activeSlot,
    logAction: "KIRIM PENUTUP PREDIKSI AUTO",
    messageForWebsite: function (website) {
      return buildClosingPredictionMessage_(website, jobDate, activeSlot);
    }
  });
}

function triggerRouterAutoPostLegacy_() {
  const now = new Date();
  const currentHour = Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "HH"));
  const currentMinute = Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "mm"));
  const currentTotal = currentHour * 60 + currentMinute;

  JADWAL_PREDIKSI_CONFIG.forEach(function (item) {
    const parts = item.jam.split(":");
    const targetTotal = Number(parts[0]) * 60 + Number(parts[1]);
    if (Math.abs(currentTotal - targetTotal) <= 10) {
      prosesAutoPostByJadwalInternal_(item.jam, "Hugo");
    }
  });
}

function generateSinglePredictionInternal_(index, username) {
  if (username) return generatePredictionCopyBundleInternal_(index, username);
  return getOrCreateDailyPredictionContent_(Number(index), "GLOBAL");
}

function generatePredictionCopyBundleInternal_(index, username) {
  const scheduleIndex = Number(index);
  const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
  if (!config) return { success: false, message: "Jadwal prediksi tidak ditemukan.", messages: [] };

  const context = validatePredictionSendContext_(username, null);
  if (context.error) return { success: false, message: context.error, messages: [] };

  const contents = getOrCreateDailyPredictionContents_(scheduleIndex, context.websites);
  const messages = context.websites.map(function (website) {
    return {
      website: website,
      siteName: predictionSiteDisplayName_(website),
      text: String(contents[website] || "")
    };
  }).filter(function (item) { return item.text; });

  return {
    success: messages.length > 0,
    predictionName: config.nama,
    messages: messages,
    copyText: messages.map(function (item) {
      return "【" + item.siteName + "】\n" + item.text;
    }).join("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"),
    serverVersion: "SMART-CONTENT-V5.1"
  };
}

// ==========================================================
// SMART LOCK V4.1 — PREDIKSI TELEGRAM + KATA-KATA PENUTUP
// Kunci permanen: TANGGAL || SESI || WEBSITE
// ==========================================================
const PREDICTION_TIMEZONE_ = "GMT+7";
const PREDICTION_REGISTRY_SHEET_ = "Prediction Send Registry";
const PREDICTION_CONTENT_SHEET_ = "Prediction Daily Content";
const PREDICTION_PROCESSING_TTL_MS_ = 3 * 60 * 1000;
const PREDICTION_REGISTRY_HEADERS_ = [
  "Tanggal", "Jadwal ID", "Nama Prediksi", "Website", "Status",
  "Username", "Waktu", "Request ID", "Detail", "Hash Konten", "Unique Key"
];
const CLOSING_PREDICTION_NAME_ = "KATA-KATA PENUTUP PREDIKSI";
const CLOSING_PREDICTION_SLOTS_ = ["06:15", "16:00"];
const CLOSING_PREDICTION_VARIANTS_ = [
  "Prediksi di atas hanyalah referensi angka hari ini. Tepat atau tidaknya tetap bergantung pada hoki anda bosku.",
  "Gunakan prediksi ini sebagai bahan pertimbangan saja. Hasil akhirnya tetap bergantung pada keberuntungan anda bosku.",
  "Angka di atas merupakan prediksi untuk hari ini, bukan jaminan hasil. Semoga hoki selalu menyertai anda bosku.",
  "Prediksi ini dibuat sebagai referensi hiburan hari ini. Cocok atau tidaknya tetap ditentukan oleh hoki anda bosku.",
  "Silakan gunakan angka di atas dengan bijak. Ketepatan prediksi tetap bergantung pada keberuntungan anda bosku.",
  "Prediksi hari ini tidak menjamin hasil akhir. Semoga pilihan anda membawa hoki terbaik bosku."
];
const PREDICTION_SITE_NAMES_ = {
  "SOHO": "SOHOTOGEL", "SOHOTOGEL": "SOHOTOGEL",
  "LIMA": "LIMATOGEL", "LIMATOGEL": "LIMATOGEL",
  "RETRO": "RETROTOGEL", "RETROTOGEL": "RETROTOGEL",
  "HUGO": "HUGOTOGEL", "HUGOTOGEL": "HUGOTOGEL",
  "XO": "XOTOGEL", "XOTOGEL": "XOTOGEL",
  "SENJA": "SENJATOGEL", "SENJATOGEL": "SENJATOGEL",
  "DODO": "DODOTOGEL", "DODOTOGEL": "DODOTOGEL",
  "AXIS": "AXISTOGEL", "AXISTOGEL": "AXISTOGEL",
  "REMBO": "REMBOTOGEL", "REMBOTOGEL": "REMBOTOGEL",
  "HELEN": "HELENTOGEL", "HELENTOGEL": "HELENTOGEL",
  "FOLA": "FOLATOTO", "FOLATOTO": "FOLATOTO",
  "YEL": "YELTOTO", "YELTOTO": "YELTOTO"
};

function predictionTodayKey_() {
  return Utilities.formatDate(new Date(), PREDICTION_TIMEZONE_, "yyyy-MM-dd");
}

function normalizePredictionDateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, PREDICTION_TIMEZONE_, "yyyy-MM-dd");
  }

  if (typeof value === "number" && isFinite(value) && value > 20000 && value < 100000) {
    const serialDate = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    return Utilities.formatDate(serialDate, "GMT", "yyyy-MM-dd");
  }

  let text = String(value == null ? "" : value).trim().replace(/^'/, "");
  if (!text) return "";
  if (/^\d{5}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    const serialDate = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
    return Utilities.formatDate(serialDate, "GMT", "yyyy-MM-dd");
  }

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return match[1] + "-" + ("0" + match[2]).slice(-2) + "-" + ("0" + match[3]).slice(-2);
  }

  match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (match) {
    return match[3] + "-" + ("0" + match[2]).slice(-2) + "-" + ("0" + match[1]).slice(-2);
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, PREDICTION_TIMEZONE_, "yyyy-MM-dd");
  }
  return text;
}

function predictionScheduleId_(index) {
  return "PRED-" + (Number(index) + 1);
}

function normalizeClosingSlot_(slot) {
  const clean = String(slot || "").trim();
  return CLOSING_PREDICTION_SLOTS_.indexOf(clean) >= 0 ? clean : getActiveClosingSlot_();
}

function getActiveClosingSlot_() {
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "HH"));
  const minute = Number(Utilities.formatDate(now, PREDICTION_TIMEZONE_, "mm"));
  return (hour * 60 + minute) < (16 * 60) ? "06:15" : "16:00";
}

function closingScheduleId_(slot) {
  return "CLOSING-" + normalizeClosingSlot_(slot).replace(":", "");
}

function predictionUniqueKey_(dateKey, scheduleId, website) {
  return [
    normalizePredictionDateKey_(dateKey),
    String(scheduleId || "").trim().toUpperCase(),
    String(website || "").trim().toUpperCase()
  ].join("||");
}

function buildPredictionBundle_(index, website, uniquenessSalt) {
  const config = JADWAL_PREDIKSI_CONFIG[Number(index)];
  if (!config) throw new Error("Jadwal prediksi tidak ditemukan.");

  const cleanWebsite = String(website || "GLOBAL").trim().toUpperCase();
  const dateKey = predictionTodayKey_();
  const scheduleId = predictionScheduleId_(index);
  const salt = String(uniquenessSalt || "0");
  let message = "";

  config.pasaran.forEach(function (pasaran, marketIndex) {
    const seedKey = [
      "SMART-CONTENT-V5.1",
      dateKey,
      scheduleId,
      cleanWebsite,
      String(pasaran || "").toUpperCase(),
      marketIndex,
      salt
    ].join("|");
    message += generatePrediksiTextForWebsite_(pasaran, seedKey) + "----------------------------------\n\n";
  });

  // Tidak ada lagi teks tambahan seperti “PREDIKSI KHUSUS FOLATOTO”.
  // Perbedaan antarwebsite berasal dari angka yang digenerasikan memakai seed website.
  return message.trim();
}

function getPredictionContentSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PREDICTION_CONTENT_SHEET_);
  const headers = ["Tanggal", "Jadwal ID", "Nama Prediksi", "Website", "Isi Prediksi", "Dibuat Pada"];

  if (!sheet) sheet = ss.insertSheet(PREDICTION_CONTENT_SHEET_);

  const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0]
    .map(function (value) { return String(value || "").trim(); });

  const isLegacy = currentHeaders.indexOf("Website") < 0 || currentHeaders.indexOf("Isi Prediksi") === 3;
  if (isLegacy && sheet.getLastRow() >= 2) {
    const legacyRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(Math.max(sheet.getLastColumn(), 5), 5)).getValues();
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const migrated = legacyRows.filter(function (row) {
      return String(row[0] || "").trim() || String(row[3] || "").trim();
    }).map(function (row) {
      return [row[0], row[1], row[2], "LEGACY", row[3], row[4]];
    });
    if (migrated.length) sheet.getRange(2, 1, migrated.length, headers.length).setValues(migrated);
  } else {
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#0e7490")
    .setFontColor("#ffffff");
  sheet.setFrozenRows(1);
  try { sheet.hideSheet(); } catch (error) {}
  return sheet;
}

function getOrCreateDailyPredictionContent_(index, website) {
  const map = getOrCreateDailyPredictionContents_(index, [website || "GLOBAL"]);
  return map[String(website || "GLOBAL").trim().toUpperCase()] || "";
}

function getOrCreateDailyPredictionContents_(index, websites) {
  const config = JADWAL_PREDIKSI_CONFIG[Number(index)];
  if (!config) return {};

  const cleanWebsites = Array.from(new Set((websites || []).map(function (website) {
    return String(website || "").trim().toUpperCase();
  }).filter(Boolean)));
  if (!cleanWebsites.length) return {};

  const dateKey = predictionTodayKey_();
  const scheduleId = predictionScheduleId_(index);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const sheet = getPredictionContentSheet_();
    const result = {};
    const recordRows = {};
    const lastRow = sheet.getLastRow();

    if (lastRow >= 2) {
      const scanCount = Math.min(lastRow - 1, 5000);
      const startRow = lastRow - scanCount + 1;
      const rows = sheet.getRange(startRow, 1, scanCount, 6).getValues();
      rows.forEach(function (row, offset) {
        const rowDate = normalizePredictionDateKey_(row[0]);
        const rowSchedule = String(row[1] || "").trim().toUpperCase();
        const rowWebsite = String(row[3] || "").trim().toUpperCase();
        if (rowDate === dateKey && rowSchedule === scheduleId && cleanWebsites.indexOf(rowWebsite) >= 0) {
          result[rowWebsite] = String(row[4] || "");
          recordRows[rowWebsite] = startRow + offset;
        }
      });
    }

    const usedHashes = {};
    const rebuild = [];

    cleanWebsites.forEach(function (website) {
      const content = String(result[website] || "");
      const hash = content ? contentHash_(content) : "";
      const isLegacy = /^\s*PREDIKSI\s+KHUSUS\b/i.test(content);
      const isDuplicate = !!(hash && usedHashes[hash]);

      if (!content || isLegacy || isDuplicate) {
        rebuild.push(website);
        delete result[website];
      } else {
        usedHashes[hash] = website;
      }
    });

    const createdAt = new Date();
    const appendRows = [];

    rebuild.forEach(function (website) {
      let attempt = 0;
      let content = "";
      let hash = "";
      do {
        content = buildPredictionBundle_(index, website, attempt);
        hash = contentHash_(content);
        attempt++;
      } while (usedHashes[hash] && attempt < 20);

      result[website] = content;
      usedHashes[hash] = website;
      const values = [dateKey, scheduleId, config.nama, website, content, createdAt];

      if (recordRows[website]) {
        sheet.getRange(recordRows[website], 1, 1, 6).setValues([values]);
        sheet.getRange(recordRows[website], 1).setNumberFormat("@");
        sheet.getRange(recordRows[website], 6).setNumberFormat("dd/MM/yyyy HH:mm:ss");
      } else {
        appendRows.push(values);
      }
    });

    if (appendRows.length) {
      const appendStartRow = sheet.getLastRow() + 1;
      sheet.getRange(appendStartRow, 1, appendRows.length, 6).setValues(appendRows);
      sheet.getRange(appendStartRow, 1, appendRows.length, 1).setNumberFormat("@");
      sheet.getRange(appendStartRow, 6, appendRows.length, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
    }

    if (rebuild.length) SpreadsheetApp.flush();
    return result;
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

function getPredictionRegistrySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PREDICTION_REGISTRY_SHEET_);
  if (!sheet) sheet = ss.insertSheet(PREDICTION_REGISTRY_SHEET_);
  ensurePredictionRegistryV4_(sheet);
  return sheet;
}

function ensurePredictionRegistryV4_(sheet) {
  const requiredColumns = PREDICTION_REGISTRY_HEADERS_.length;
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, requiredColumns).setValues([PREDICTION_REGISTRY_HEADERS_]);
  sheet.getRange(1, 1, 1, requiredColumns)
    .setFontWeight("bold")
    .setBackground("#7c3aed")
    .setFontColor("#ffffff");
  sheet.setFrozenRows(1);

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const range = sheet.getRange(2, 1, lastRow - 1, requiredColumns);
    const rows = range.getValues();
    let changed = false;

    rows.forEach(function (row) {
      const dateKey = normalizePredictionDateKey_(row[0]);
      const scheduleId = String(row[1] || "").trim().toUpperCase();
      const website = String(row[3] || "").trim().toUpperCase();
      const uniqueKey = dateKey && scheduleId && website
        ? predictionUniqueKey_(dateKey, scheduleId, website)
        : "";

      if (String(row[0] || "") !== dateKey) { row[0] = dateKey; changed = true; }
      if (String(row[1] || "") !== scheduleId) { row[1] = scheduleId; changed = true; }
      if (String(row[3] || "") !== website) { row[3] = website; changed = true; }
      if (String(row[4] || "").trim() !== String(row[4] || "").trim().toUpperCase()) {
        row[4] = String(row[4] || "").trim().toUpperCase();
        changed = true;
      }
      if (String(row[10] || "") !== uniqueKey) { row[10] = uniqueKey; changed = true; }
    });

    sheet.getRange(2, 1, lastRow - 1, 1).setNumberFormat("@");
    sheet.getRange(2, 11, lastRow - 1, 1).setNumberFormat("@");
    if (changed) range.setValues(rows);
  }

  try { sheet.hideSheet(); } catch (error) {}
}

function predictionTimeMs_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  const parsed = new Date(String(value || ""));
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function predictionEntryRank_(entry) {
  if (!entry) return -1;
  if (entry.status === "BERHASIL") return 100;
  if (entry.status === "PROCESSING" && entry.processingFresh) return 60;
  if (entry.status === "GAGAL") return 30;
  if (entry.status === "PROCESSING") return 10;
  return 0;
}

function readPredictionRegistryForDate_(dateKey) {
  const sheet = getPredictionRegistrySheet_();
  const result = {};
  if (sheet.getLastRow() < 2) return result;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, PREDICTION_REGISTRY_HEADERS_.length).getValues();
  rows.forEach(function (row, index) {
    const normalizedDate = normalizePredictionDateKey_(row[0]);
    if (normalizedDate !== normalizePredictionDateKey_(dateKey)) return;

    const scheduleId = String(row[1] || "").trim().toUpperCase();
    const website = String(row[3] || "").trim().toUpperCase();
    if (!scheduleId || !website) return;

    const rawTime = row[6];
    const timeMs = predictionTimeMs_(rawTime);
    const status = String(row[4] || "").trim().toUpperCase();
    const entry = {
      row: index + 2,
      dateKey: normalizedDate,
      scheduleId: scheduleId,
      website: website,
      status: status,
      username: String(row[5] || ""),
      time: rawTime,
      timeMs: timeMs,
      timeText: rawTime instanceof Date
        ? Utilities.formatDate(rawTime, PREDICTION_TIMEZONE_, "dd/MM/yyyy HH:mm:ss")
        : String(rawTime || ""),
      requestId: String(row[7] || ""),
      detail: String(row[8] || ""),
      uniqueKey: String(row[10] || predictionUniqueKey_(normalizedDate, scheduleId, website)),
      processingFresh: status === "PROCESSING" && timeMs > 0 && (Date.now() - timeMs < PREDICTION_PROCESSING_TTL_MS_)
    };

    const key = scheduleId + "||" + website;
    const current = result[key];
    const currentRank = predictionEntryRank_(current);
    const entryRank = predictionEntryRank_(entry);
    if (!current || entryRank > currentRank || (entryRank === currentRank && entry.timeMs >= current.timeMs)) {
      result[key] = entry;
    }
  });
  return result;
}

function readPredictionTelegramAccountsSource_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sosmed");
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  const values = sheet.getDataRange().getValues();
  const headerScanRows = Math.min(values.length, 3);
  let websiteColumn = -1;
  let websiteHeaderRow = 0;
  let groupColumn = -1;
  let groupRow = -1;

  for (let row = 0; row < headerScanRows; row++) {
    for (let col = 0; col < values[row].length; col++) {
      const value = String(values[row][col] || "").trim().toUpperCase();
      if (value === "WEBSITE" && websiteColumn < 0) {
        websiteColumn = col;
        websiteHeaderRow = row;
      }
      if (value === "TELEGRAM PREDIKSI" && groupColumn < 0) {
        groupColumn = col;
        groupRow = row;
      }
    }
  }

  let tokenColumn = -1;
  let chatIdColumn = -1;
  let fieldHeaderRow = groupRow;

  if (groupColumn >= 0) {
    const lastHeaderRow = Math.min(values.length - 1, groupRow + 2);
    for (let row = groupRow; row <= lastHeaderRow; row++) {
      const lastColumn = Math.min(values[row].length - 1, groupColumn + 3);
      for (let col = groupColumn; col <= lastColumn; col++) {
        const value = String(values[row][col] || "").trim().toUpperCase();
        if (value === "TOKEN") {
          tokenColumn = col;
          fieldHeaderRow = Math.max(fieldHeaderRow, row);
        }
        if (value === "CHAT_ID" || value === "CHAT ID") {
          chatIdColumn = col;
          fieldHeaderRow = Math.max(fieldHeaderRow, row);
        }
      }
    }
  }

  if (tokenColumn < 0 && sheet.getLastColumn() >= 11) tokenColumn = 10;
  if (chatIdColumn < 0 && sheet.getLastColumn() >= 12) chatIdColumn = 11;
  if (websiteColumn < 0) websiteColumn = 0;
  if (tokenColumn < 0 || chatIdColumn < 0) return map;

  const startRow = Math.max(websiteHeaderRow, groupRow, fieldHeaderRow, 0) + 1;
  for (let row = startRow; row < values.length; row++) {
    const website = String(values[row][websiteColumn] || "").trim().toUpperCase();
    if (!website || website === "WEBSITE") continue;

    const token = String(values[row][tokenColumn] || "").trim();
    const chatId = String(values[row][chatIdColumn] || "").trim();
    map[website] = { TOKEN: token, CHAT_ID: chatId };
  }
  return map;
}

function validatePredictionSendContext_(username, onlyWebsites) {
  const cleanUser = String(username || "").trim();
  const profile = getUserProfile_(cleanUser);
  if (!profile) return { error: "User tidak ditemukan. Silakan login ulang." };
  if (profile.status !== "AKTIF") return { error: "Akun tidak aktif." };

  const maintenance = getMaintenanceSettings_();
  if (maintenance.enabled && profile.role !== "ADMIN") return { error: maintenance.message };
  if (!profile.permissions.telegram) return { error: "Akses Telegram pada Sheet Users belum diaktifkan." };

  const allowedWebsites = Array.from(new Set((profile.websites || []).map(function (site) {
    return String(site || "").trim().toUpperCase();
  }).filter(Boolean)));
  const requestedSet = Array.isArray(onlyWebsites) && onlyWebsites.length
    ? new Set(onlyWebsites.map(function (site) { return String(site || "").trim().toUpperCase(); }))
    : null;
  const websites = requestedSet
    ? allowedWebsites.filter(function (site) { return requestedSet.has(site); })
    : allowedWebsites;

  if (!websites.length) return { error: "Tidak ada website yang dapat diproses untuk akun ini." };
  return { cleanUser: cleanUser, profile: profile, websites: websites };
}

function sendPredictionJobLegacy_(options) {
  const startedAt = Date.now();
  const context = validatePredictionSendContext_(options.username, options.onlyWebsites);
  if (context.error) {
    return { success: false, blocked: true, message: context.error, websiteResults: [], kind: options.kind || "schedule" };
  }

  const cleanUser = context.cleanUser;
  const websites = context.websites;
  const dateKey = predictionTodayKey_();
  const scheduleId = String(options.scheduleId || "").trim().toUpperCase();
  const predictionName = String(options.predictionName || "PREDIKSI");
  const requestId = Utilities.getUuid();
  const accounts = readPredictionTelegramAccounts_();
  const registrySheet = getPredictionRegistrySheet_();
  const reservationLock = LockService.getScriptLock();
  const reservations = [];
  const resultMap = {};
  const contentMap = {};

  // Konten dibuat sebelum Smart Lock registry agar tidak terjadi nested lock.
  websites.forEach(function (website) {
    try {
      contentMap[website] = String(options.messageForWebsite(website) || "");
    } catch (error) {
      contentMap[website] = "";
    }
  });

  try {
    reservationLock.waitLock(30000);
    const registry = readPredictionRegistryForDate_(dateKey);
    let nextRow = registrySheet.getLastRow() + 1;

    websites.forEach(function (website) {
      const key = scheduleId + "||" + website;
      const previous = registry[key] || null;

      if (previous && previous.status === "BERHASIL") {
        resultMap[website] = {
          website: website,
          status: "SUDAH DIKIRIM",
          reason: "Smart Lock memblokir duplikat. Sudah dikirim oleh " + (previous.username || "user lain") +
            (previous.timeText ? " pada " + previous.timeText : "") + "."
        };
        return;
      }

      if (previous && previous.status === "PROCESSING" && previous.processingFresh) {
        resultMap[website] = {
          website: website,
          status: "SEDANG DIPROSES",
          reason: "Website ini sedang dikunci dan diproses oleh " + (previous.username || "user lain") + "."
        };
        return;
      }

      const content = String(contentMap[website] || "");
      if (!content) {
        resultMap[website] = { website: website, status: "GAGAL", reason: "Isi pesan kosong." };
        return;
      }

      const row = previous && previous.row ? previous.row : nextRow++;
      const uniqueKey = predictionUniqueKey_(dateKey, scheduleId, website);
      registrySheet.getRange(row, 1).setNumberFormat("@");
      registrySheet.getRange(row, 11).setNumberFormat("@");
      registrySheet.getRange(row, 1, 1, PREDICTION_REGISTRY_HEADERS_.length).setValues([[
        dateKey,
        scheduleId,
        predictionName,
        website,
        "PROCESSING",
        cleanUser,
        new Date(),
        requestId,
        "Reservasi Smart Content V5",
        contentHash_(content),
        uniqueKey
      ]]);
      reservations.push({ website: website, row: row, content: content, uniqueKey: uniqueKey });
    });
    SpreadsheetApp.flush();
  } finally {
    try { reservationLock.releaseLock(); } catch (error) {}
  }

  reservations.forEach(function (reservation) {
    const account = accounts[reservation.website] || null;
    let normalized;

    if (!account || !account.TOKEN || !account.CHAT_ID) {
      normalized = {
        status: "GAGAL",
        reason: "TOKEN atau CHAT_ID Telegram Prediksi tidak ditemukan pada Sheet Sosmed."
      };
    } else {
      let response;
      try {
        response = sendToTelegramInternal_(reservation.content, account);
      } catch (error) {
        response = "Tele Error: " + error.message;
      }
      normalized = normalizeSendResult_(response);
    }

    resultMap[reservation.website] = {
      website: reservation.website,
      status: normalized.status,
      reason: normalized.reason
    };
  });

  if (reservations.length) {
    const updateLock = LockService.getScriptLock();
    try {
      updateLock.waitLock(30000);
      reservations.forEach(function (reservation) {
        const rowValues = registrySheet.getRange(reservation.row, 1, 1, PREDICTION_REGISTRY_HEADERS_.length).getValues()[0];
        const currentRequestId = String(rowValues[7] || "");
        const currentUniqueKey = String(rowValues[10] || "");
        if (currentRequestId !== requestId || currentUniqueKey !== reservation.uniqueKey) return;

        const result = resultMap[reservation.website];
        registrySheet.getRange(reservation.row, 5, 1, 5).setValues([[
          result.status === "BERHASIL" ? "BERHASIL" : "GAGAL",
          cleanUser,
          new Date(),
          requestId,
          result.reason
        ]]);
        registrySheet.getRange(reservation.row, 7).setNumberFormat("dd/MM/yyyy HH:mm:ss");
      });
      SpreadsheetApp.flush();
    } finally {
      try { updateLock.releaseLock(); } catch (error) {}
    }
  }

  const websiteResults = websites.map(function (website) {
    return resultMap[website] || {
      website: website,
      status: "GAGAL",
      reason: "Status pengiriman tidak tersedia."
    };
  });

  const counters = { success: 0, failed: 0, already: 0, processing: 0 };
  websiteResults.forEach(function (item) {
    const status = String(item.status || "").toUpperCase();
    if (status === "BERHASIL") counters.success++;
    else if (status === "SUDAH DIKIRIM") counters.already++;
    else if (status === "SEDANG DIPROSES") counters.processing++;
    else counters.failed++;
  });

  const pendingWebsites = websiteResults.filter(function (item) {
    return String(item.status || "").toUpperCase() === "GAGAL";
  }).map(function (item) { return item.website; });

  const allAlready = counters.already === websiteResults.length;
  const noNewSend = counters.success === 0 && counters.failed === 0;
  const anySuccess = counters.success > 0;
  const anyFailure = counters.failed > 0;
  const detail = websiteResults.map(function (item) {
    return item.website + ": " + item.status + " (" + item.reason + ")";
  }).join(" | ");

  let logStatus = "INFO";
  if (allAlready) logStatus = "DIBLOKIR";
  else if (anySuccess && anyFailure) logStatus = "SEBAGIAN";
  else if (anyFailure && !anySuccess) logStatus = "GAGAL";
  else if (anySuccess) logStatus = "BERHASIL";

  logActivity_(
    cleanUser,
    allAlready ? "DUPLIKAT PREDIKSI DIBLOKIR" : String(options.logAction || "KIRIM PREDIKSI AUTO"),
    predictionName + " | " + detail,
    logStatus,
    reservations.map(function (item) { return item.content; }).join("\n\n")
  );

  return {
    success: anySuccess && !anyFailure,
    partial: anySuccess && anyFailure,
    blocked: noNewSend,
    allAlready: allAlready,
    message: allAlready
      ? "Smart Lock memblokir pengiriman karena seluruh website sudah menerima sesi ini hari ini."
      : pendingWebsites.length
        ? "Sebagian website belum berhasil dikirim."
        : counters.processing > 0 && !anySuccess
          ? "Pengiriman sedang diproses oleh permintaan lain."
          : "Proses pengiriman selesai.",
    kind: options.kind || "schedule",
    activeSlot: options.activeSlot || "",
    predictionIndex: options.predictionIndex == null ? -1 : Number(options.predictionIndex),
    predictionName: predictionName,
    dateKey: dateKey,
    scheduleId: scheduleId,
    websiteResults: websiteResults,
    pendingWebsites: pendingWebsites,
    counters: counters,
    durationMs: Date.now() - startedAt,
    serverVersion: "SMART-CONTENT-V5.1"
  };
}

function sendPredictionAutoInternal_(index, username, onlyWebsites) {
  const scheduleIndex = Number(index);
  const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
  if (!config) {
    return { success: false, blocked: true, message: "Jadwal prediksi tidak ditemukan.", websiteResults: [], kind: "schedule" };
  }

  const context = validatePredictionSendContext_(username, onlyWebsites);
  if (context.error) {
    return { success: false, blocked: true, message: context.error, websiteResults: [], kind: "schedule" };
  }

  const contents = getOrCreateDailyPredictionContents_(scheduleIndex, context.websites);
  return sendPredictionJob_({
    username: username,
    onlyWebsites: context.websites,
    scheduleId: predictionScheduleId_(scheduleIndex),
    predictionName: config.nama,
    predictionIndex: scheduleIndex,
    kind: "schedule",
    logAction: "KIRIM PREDIKSI AUTO",
    messageForWebsite: function (website) {
      return String(contents[String(website || "").trim().toUpperCase()] || "");
    }
  });
}

function predictionSiteDisplayName_(website) {
  const key = String(website || "").trim().toUpperCase();
  return PREDICTION_SITE_NAMES_[key] || key;
}

function formatClosingDateEnglish_(date) {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const day = Utilities.formatDate(date || new Date(), PREDICTION_TIMEZONE_, "dd");
  const monthIndex = Number(Utilities.formatDate(date || new Date(), PREDICTION_TIMEZONE_, "M")) - 1;
  const year = Utilities.formatDate(date || new Date(), PREDICTION_TIMEZONE_, "yyyy");
  return day + " " + months[monthIndex] + " " + year;
}

function buildClosingPredictionMessage_(website, date, slot) {
  const siteName = predictionSiteDisplayName_(website);
  const activeSlot = normalizeClosingSlot_(slot);
  const dateText = formatClosingDateEnglish_(date || new Date());
  const seed = contentHash_(String(website || "") + "|" + dateText + "|" + activeSlot);
  const variantIndex = parseInt(seed.substring(0, 8), 16) % CLOSING_PREDICTION_VARIANTS_.length;

  return "Prediksi Togel Gacor " + siteName + " " + dateText +
    "\n\n" + CLOSING_PREDICTION_VARIANTS_[variantIndex];
}

function generateClosingPredictionCopyInternal_(username, slot) {
  const context = validatePredictionSendContext_(username, null);
  if (context.error) return { success: false, message: context.error, messages: [] };

  const activeSlot = normalizeClosingSlot_(slot);
  const messages = context.websites.map(function (website) {
    return {
      website: website,
      siteName: predictionSiteDisplayName_(website),
      text: buildClosingPredictionMessage_(website, new Date(), activeSlot)
    };
  });

  return {
    success: true,
    kind: "closing",
    activeSlot: activeSlot,
    predictionName: CLOSING_PREDICTION_NAME_,
    messages: messages,
    copyText: messages.map(function (item) {
      return "【" + item.siteName + "】\n" + item.text;
    }).join("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"),
    serverVersion: "SMART-CONTENT-V5.1"
  };
}

function sendClosingPredictionAutoInternal_(username, onlyWebsites, slot) {
  const activeSlot = normalizeClosingSlot_(slot);
  return sendPredictionJob_({
    username: username,
    onlyWebsites: onlyWebsites,
    scheduleId: closingScheduleId_(activeSlot),
    predictionName: CLOSING_PREDICTION_NAME_ + " · " + activeSlot,
    predictionIndex: -1,
    kind: "closing",
    activeSlot: activeSlot,
    logAction: "KIRIM PENUTUP PREDIKSI AUTO",
    messageForWebsite: function (website) {
      return buildClosingPredictionMessage_(website, new Date(), activeSlot);
    }
  });
}

function repairPredictionRegistryV4Internal_() {
  const sheet = getPredictionRegistrySheet_();
  ensurePredictionRegistryV4_(sheet);
  SpreadsheetApp.flush();
  return {
    success: true,
    message: "Prediction Send Registry berhasil dinormalisasi ke Smart Content V5.",
    rows: Math.max(sheet.getLastRow() - 1, 0)
  };
}
