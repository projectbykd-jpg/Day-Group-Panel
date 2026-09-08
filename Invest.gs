// ============================================================================
// Invest.gs  -  Menu INVEST untuk Day-Group PANEL.
// AutoCheck INVEST: index semua pasaran togel di panel agen (BASE_URL), hitung
// jumlah LINE per user per game (2D/3D/4D) untuk HARI INI + KEMARIN, lalu tandai
// user yang MELEBIHI batas invest.
//
// PER-USER: setiap operator yang login punya SETTING (BASE_URL, PHPSESSID, limit)
// dan HASIL SCAN sendiri-sendiri. Satu operator menyimpan PHPSESSID tidak
// mengubah punya operator lain. Config disimpan di Script Properties dengan
// awalan "INVEST_CFG::<username>::". Hasil disimpan di sheet "INVEST WARNING"
// dengan kolom "Owner" -> tiap user hanya melihat barisnya sendiri.
//
// Scan berat jalan di latar belakang lewat 1 trigger self-healing
// (investRunScanTrigger_ -> investPumpScans_) yang memproses SEMUA user yang
// statusnya 'running' secara bergiliran. Panel memantau lewat polling
// investGetStatus.
//
// Diadaptasi dari AutoCheckINVEST.gs (standalone). Semua helper diberi awalan
// invest / INVEST_ supaya tidak bentrok dengan kode panel yang lain.
// ============================================================================

var INVEST_DEFAULT_CONFIG_ = {
  BASE_URL          : 'https://ag.suksesbogil.com/',
  PHPSESSID         : '',
  KODEREDIS         : '',
  COOKIE_EXTRA      : '',
  TIMEZONE          : 'Asia/Jakarta',
  LIMIT_2D          : 20,
  LIMIT_3D          : 250,
  LIMIT_4D          : 1296,
  PERIODE_LOOKBACK  : 8,
  PAGE_SIZE         : 50,
  MAX_PAGES_PER_GAME: 80
};

var INVEST_RESUME_DELAY_MS_ = 3000;   // jeda antar potongan scan
var INVEST_HEAD_BATCH_      = 30;     // request "head pasaran" per fetchAll
var INVEST_PUMP_BUDGET_MS_  = 300000; // total waktu 1 sesi trigger (~5 mnt, batas keras 6)
var INVEST_USER_SLICE_MS_   = 95000;  // maks waktu per user per potongan (biar >2 user kebagian per putaran)

// 62 pasaran togel standar (index dari agent_bt.php) + IDN4D.
var INVEST_DEFAULT_PASARAN_ = [
  ['p33190','ARIZONA'],['p12698','ATHENS'],['p12703','AUSTRIA'],['p12701','BAHRAIN'],
  ['p33210','BALI'],['p31202','BERLIN'],['p33191','BRAZIL'],['p6680','BULLSEYE'],
  ['p31205','BUSAN'],['p12700','CAIRO'],['p21546','CALIFORNIA'],['p33192','CANADA'],
  ['p6682','CAROLINADAY'],['p21547','CAROLINAEVE'],['p31211','COLORADO'],['p31210','DALLAS'],
  ['p21545','FLORIDAEVE'],['p21544','FLORIDAMID'],['p31209','HK SIANG'],['p6683','HONGKONG'],
  ['p6684','IDAHO'],['p6685','INDIA'],['p28611','INDIA MORNING'],['p33193','JAKARTA'],
  ['p12704','KANSAS'],['p6686','KENTUCKYEVE'],['p21540','KENTUCKYMID'],['p31585','KHMER LOTTO'],
  ['p31199','LAOS MALAM'],['p31200','LAOS SIANG'],['p12699','LISBON'],['p28616','LISBON NIGHT'],
  ['p31206','MALAYSIA'],['p33211','MANILA'],['p12706','MEXICO'],['p31213','MICHIGAN'],
  ['p31214','MONTANA'],['p6687','NEBRASKA'],['p28614','NEW MEXICO'],['p21543','NEWYORKEVE'],
  ['p21542','NEWYORKMID'],['p31594','NIPPON LOTTO'],['p31212','OHIO'],['p21538','OREGON03'],
  ['p21535','OREGON06'],['p21537','OREGON09'],['p21539','OREGON12'],['p31203','OSAKA'],
  ['p6688','PANAMA'],['p31204','PARIS'],['p12705','PARMA'],['p31201','ROMA'],
  ['p31198','RUSIA'],['p12697','SAPPORO'],['p28613','SAPPORO EVE'],['p6689','SINGAPORE'],
  ['p6690','SYDNEY'],['p31588','TAIPEI LOTTO'],['p31207','THAILAND'],['p31587','TIONGKOK 4D'],
  ['p12702','TURKEY'],['p31208','UEA SORE'],
  ['p808','IDN4D']
];

var INVEST_GAMES_     = ['2D','3D','4D'];
var INVEST_RAW_SH_    = '_invest_raw';
var INVEST_WARN_SH_   = 'INVEST WARNING';
var INVEST_CFG_NS_    = 'INVEST_CFG::';     // + <user> + :: + <FIELD>
var INVEST_STATE_NS_  = 'INVEST_STATE::';   // + <user>
var INVEST_TRIGGER_FN_ = 'investRunScanTrigger_';
var INVEST_ROW_RE_ = />(?:2D|3D|4D)-(\d+)<\/font><\/td>\s*<td[^>]*><FONT[^>]*>(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}<\/font><\/td>\s*<td[^>]*><FONT[^>]*>([^<]*)<\/font><\/td>/g;

function investUserKey_(token) {
  var s = requireSession_(token, { ignoreMaintenance: true });
  return s.username;
}

// =============================== CONFIG (per-user) ===========================
function investLoadConfig_(user) {
  var cfg = JSON.parse(JSON.stringify(INVEST_DEFAULT_CONFIG_));
  var props = PropertiesService.getScriptProperties();
  var prefix = INVEST_CFG_NS_ + user + '::';
  Object.keys(cfg).forEach(function (k) {
    var v = props.getProperty(prefix + k);
    if (v === null || v === '') return;
    cfg[k] = (typeof INVEST_DEFAULT_CONFIG_[k] === 'number' && !isNaN(Number(v))) ? Number(v) : v;
  });
  if (cfg.BASE_URL && cfg.BASE_URL.slice(-1) !== '/') cfg.BASE_URL += '/';
  return cfg;
}

function investSaveConfigInternal_(user, data) {
  data = data || {};
  var cur = investLoadConfig_(user);
  var props = PropertiesService.getScriptProperties();
  var prefix = INVEST_CFG_NS_ + user + '::';
  Object.keys(INVEST_DEFAULT_CONFIG_).forEach(function (k) {
    var has = Object.prototype.hasOwnProperty.call(data, k);
    var raw = has ? String(data[k] == null ? '' : data[k]).trim() : String(cur[k]);
    if (typeof INVEST_DEFAULT_CONFIG_[k] === 'number') {
      var n = Number(raw);
      raw = (raw === '' || isNaN(n)) ? String(INVEST_DEFAULT_CONFIG_[k]) : String(n);
    }
    props.setProperty(prefix + k, raw);
  });
  return investLoadConfig_(user);
}

function investLoadPasaran_() {
  return INVEST_DEFAULT_PASARAN_.map(function (p) { return { kode: p[0], nama: p[1] }; });
}

// =============================== STATE (per-user) ============================
function investGetState_(user) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(INVEST_STATE_NS_ + user) || '{}') || {}; }
  catch (e) { return {}; }
}
function investSetState_(user, patch) {
  var s = investGetState_(user);
  Object.keys(patch || {}).forEach(function (k) { s[k] = patch[k]; });
  s.updatedAt = new Date().toISOString();
  try { PropertiesService.getScriptProperties().setProperty(INVEST_STATE_NS_ + user, JSON.stringify(s)); } catch (e) {}
  return s;
}
function investClearState_(user) {
  try { PropertiesService.getScriptProperties().deleteProperty(INVEST_STATE_NS_ + user); } catch (e) {}
}
// Daftar user yang statusnya masih perlu diproses ('running').
function investRunningUsers_() {
  var all;
  try { all = PropertiesService.getScriptProperties().getProperties(); } catch (e) { return []; }
  var out = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(INVEST_STATE_NS_) !== 0) return;
    var st;
    try { st = JSON.parse(all[key] || '{}'); } catch (e) { return; }
    if (st && st.state === 'running') out.push(key.substring(INVEST_STATE_NS_.length));
  });
  return out;
}

// =============================== SHEETS ====================================
// SEMUA data kerja INVEST di SPREADSHEET TERPISAH ("DAY-GROUP - INVEST Data"),
// BUKAN di Database panel yang sibuk -> tidak bentrok dgn kirim result / log
// aktivitas -> tidak lagi "Spreadsheet service timed out".
function investSS_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INVEST_SS_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  try {
    var ss = SpreadsheetApp.create('DAY-GROUP - INVEST Data');
    props.setProperty('INVEST_SS_ID', ss.getId());
    return ss;
  } catch (e) {
    // create gagal (mis. scope belum diizinkan) -> fallback ke spreadsheet aktif.
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

// Retry untuk operasi sheet yang kena timeout transien Google.
function investRetry_(fn) {
  for (var a = 0; ; a++) {
    try { return fn(); }
    catch (e) {
      if (a >= 3 || String((e && e.message) || e).indexOf('SESSION_EXPIRED') >= 0) throw e;
      Utilities.sleep(1500 + a * 1000);
    }
  }
}

// _invest_raw_<user> : data kerja per-user (7 kolom, tanpa owner). Per-user supaya
// dua scan tidak menulis ke sheet yang sama.
function investRawSheetName_(user) {
  return ('_invest_raw ' + String(user || '').replace(/[\[\]\*\?\/\\:]/g, ' ').trim()).substring(0, 90);
}
var INVEST_RAW_HEAD_ = ['tanggal', 'user', 'pasaran', 'periode', 'game', 'line', 'limit'];
function investRawSheet_(user) {
  return investRetry_(function () {
    var ss = investSS_();
    var nm = investRawSheetName_(user);
    var r = ss.getSheetByName(nm);
    if (!r) {
      r = ss.insertSheet(nm);
      r.getRange(1, 1, 1, 7).setValues([INVEST_RAW_HEAD_]);
      try { r.getRange('A2:A').setNumberFormat('@'); r.getRange('C2:C').setNumberFormat('@'); } catch (e) {}
      try { r.hideSheet(); } catch (e) {}
    }
    return r;
  });
}

// 1 USER = 1 SHEET hasil = "INVEST <username>".
function investWarnSheetName_(user) {
  return ('INVEST ' + String(user || '').replace(/[\[\]\*\?\/\\:]/g, ' ').trim()).substring(0, 90);
}
var INVEST_WARN_HEAD_ = ['Tanggal', 'Username', 'Pasaran', 'Periode', 'Line', 'Rincian', 'Data (JSON)'];
function investWarnSheet_(user) {
  return investRetry_(function () {
    var ss = investSS_();
    var nm = investWarnSheetName_(user);
    var w = ss.getSheetByName(nm);
    if (!w) {
      w = ss.insertSheet(nm);
      w.getRange(1, 1, 1, 7).setValues([INVEST_WARN_HEAD_]).setFontWeight('bold').setBackground('#fce5cd');
      w.setFrozenRows(1);
      w.setColumnWidth(3, 220); w.setColumnWidth(6, 480);
      try { w.getRange('A2:A').setNumberFormat('@'); } catch (e) {}
    }
    return w;
  });
}
function investWarnSheetIfExists_(user) {
  try { return investSS_().getSheetByName(investWarnSheetName_(user)); }
  catch (e) { return null; }
}
function investWarningCountForUser_(user) {
  try {
    var w = investWarnSheetIfExists_(user);
    return w ? Math.max(w.getLastRow() - 1, 0) : 0;
  } catch (e) { return 0; }
}

function investDateStr_(v, tz) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, tz || 'Asia/Jakarta', 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz || 'Asia/Jakarta', 'yyyy-MM-dd');
  return s;
}

// =============================== HTTP ========================================
function investCookieHeader_(cfg) {
  if (cfg.COOKIE_EXTRA) return cfg.COOKIE_EXTRA;
  var c = 'PHPSESSID=' + cfg.PHPSESSID;
  if (cfg.KODEREDIS) c += '; koderedis=' + cfg.KODEREDIS;
  return c;
}
var INVEST_UA_ = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
function investReqOpts_(cfg) {
  return {
    method: 'get',
    headers: { 'Cookie': investCookieHeader_(cfg), 'User-Agent': INVEST_UA_ },
    muteHttpExceptions: true,
    followRedirects: false
  };
}
function investIsLoginPage_(code, body, headers) {
  var loc = String((headers && (headers['Location'] || headers['location'])) || '');
  // Redirect ke halaman login/index -> sesi memang mati.
  if (/(?:^|\/)(?:login|index|logout)\.php/i.test(loc) || /[?&]expired/i.test(loc)) return true;
  // Form login pada body.
  if (/name=["']entered_login["']/i.test(body) ||
      /name=["']vb_login_md5password["']/i.test(body) ||
      /class="submit-button"\s+value="LOGIN"/i.test(body) ||
      /<form[^>]+action=["'][^"']*login/i.test(body)) return true;
  // 302 TANPA tujuan login (mis. redirect internal ke frame data) -> BUKAN expired.
  // Body kosong dari 302 begini akan gagal di-parse & pasaran-nya dilewati saja.
  return false;
}
function investFetch_(cfg, path) {
  if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) throw new Error('PHPSESSID kosong — isi & simpan dulu di menu INVEST.');
  var res = UrlFetchApp.fetch(cfg.BASE_URL + path, investReqOpts_(cfg));
  var body = res.getContentText();
  if (investIsLoginPage_(res.getResponseCode(), body, res.getAllHeaders())) throw new Error('SESSION_EXPIRED');
  return body;
}
function investBatchGet_(cfg, paths) {
  if (!paths.length) return [];
  var opts = investReqOpts_(cfg);
  var reqs = paths.map(function (p) {
    var r = { url: cfg.BASE_URL + p };
    Object.keys(opts).forEach(function (k) { r[k] = opts[k]; });
    return r;
  });
  var out = [];
  for (var i = 0; i < reqs.length; i += 50) {
    var chunk = reqs.slice(i, i + 50);
    var fetched;
    try { fetched = UrlFetchApp.fetchAll(chunk); }
    catch (e) { fetched = chunk.map(function () { return null; }); }
    for (var j = 0; j < chunk.length; j++) {
      var f = fetched[j];
      if (!f) { out.push({ body: '', expired: false, error: 'fetch gagal' }); continue; }
      try {
        var b = f.getContentText();
        out.push({ body: b, expired: investIsLoginPage_(f.getResponseCode(), b, f.getAllHeaders()), error: '' });
      } catch (e) { out.push({ body: '', expired: false, error: (e && e.message) || String(e) }); }
    }
  }
  return out;
}

// ========================= PARSER HELPERS ===================================
function investParsePeriode_(html) {
  var m = html.match(/name=["']?periode["']?[^>]*value=["'](\d+)["']/i);
  return m ? parseInt(m[1], 10) : null;
}
function investParseTotals_(html) {
  var t = { '2D': 0, '3D': 0, '4D': 0 };
  ['2D', '3D', '4D'].forEach(function (g) {
    var m = html.match(new RegExp('value ="' + g + '">&nbsp;:&nbsp;(\\d+)'));
    if (m) t[g] = parseInt(m[1], 10);
  });
  return t;
}
function investMaxGame_(t) {
  var g = '2D';
  if (t['3D'] > t[g]) g = '3D';
  if (t['4D'] > t[g]) g = '4D';
  return g;
}
function investFetchFrame_(cfg, kode, per, game, start, size) {
  var url = 'admin_invoice_frame.php?tombol=' + game +
            '&start=' + start + '&end=' + (start + size) +
            '&s_user=&s_nomor=&s_periode=' + per + '&pos2d=&dist=invoice';
  return investFetch_(cfg, url);
}
function investFirstDate_(html) {
  INVEST_ROW_RE_.lastIndex = 0;
  var m = INVEST_ROW_RE_.exec(html);
  return m ? m[2] : null;
}
function investCountUsers_(cfg, kode, per, game, total, page1Html) {
  var users = {}, seen = {};
  var size = cfg.PAGE_SIZE;
  var pages = 0;
  function eat(html) {
    INVEST_ROW_RE_.lastIndex = 0;
    var mm, got = 0;
    while ((mm = INVEST_ROW_RE_.exec(html)) !== null) {
      var id = mm[1], user = (mm[3] || '').trim();
      if (seen[id]) continue;
      seen[id] = 1;
      users[user] = (users[user] || 0) + 1;
      got++;
    }
    return got;
  }
  var start = 0;
  if (page1Html) { eat(page1Html); start = size; pages = 1; }
  for (; start <= total; start += size) {
    if (++pages > cfg.MAX_PAGES_PER_GAME) break;
    var got = eat(investFetchFrame_(cfg, kode, per, game, start, size));
    if (got === 0) break;
  }
  return users;
}

// =============================== TRIGGER / PUMP =============================
function investDeleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === INVEST_TRIGGER_FN_) ScriptApp.deleteTrigger(t);
  });
}
function investEnsureTrigger_(delayMs) {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === INVEST_TRIGGER_FN_;
  });
  if (!exists) ScriptApp.newTrigger(INVEST_TRIGGER_FN_).timeBased().after(Math.max(1000, delayMs || 1000)).create();
}

function investRunScanTrigger_() {
  try { investPumpScans_(); } catch (e) {}
}

// Proses SEMUA user yang statusnya 'running', bergiliran, dalam 1 anggaran waktu.
// PENTING: single-flight-nya pakai FLAG di CacheService, BUKAN LockService.
// getScriptLock() -> kalau pump memegang script-lock 4-5 menit, jalur KIRIM
// RESULT (dgSmartSendEngine_ / sendPredictionJob_ yang juga waitLock script-lock)
// bisa timeout & gagal. Flag cache tidak memblokir apa pun.
var INVEST_PUMP_FLAG_ = 'INVEST_PUMP_RUNNING';
function investPumpScans_() {
  var cache = CacheService.getScriptCache();
  try { if (cache.get(INVEST_PUMP_FLAG_)) return; } catch (e) {}
  try { cache.put(INVEST_PUMP_FLAG_, '1', 360); } catch (e) {}
  try {
    var deadline = Date.now() + INVEST_PUMP_BUDGET_MS_;
    var users = investRunningUsers_();
    if (!users.length) { investDeleteTriggers_(); return; }

    for (var i = 0; i < users.length; i++) {
      if (Date.now() >= deadline) break;
      var slice = Math.min(deadline, Date.now() + INVEST_USER_SLICE_MS_);
      try { investScanUser_(users[i], slice); }
      catch (e) {
        investSetState_(users[i], { state: 'paused', message: 'Sempat error (' + ((e && e.message) || e) + '). Coba lanjut otomatis, atau klik LANJUTKAN.' });
      }
    }

    // Masih ada yang 'running' (termasuk yang tadi di-slice) -> jadwalkan lagi.
    investDeleteTriggers_();
    if (investRunningUsers_().length) {
      ScriptApp.newTrigger(INVEST_TRIGGER_FN_).timeBased().after(INVEST_RESUME_DELAY_MS_).create();
    }
  } finally {
    try { cache.remove(INVEST_PUMP_FLAG_); } catch (e) {}
  }
}

// Scan 1 user dari state.cursor sampai selesai / deadline / sesi mati.
function investScanUser_(user, deadline) {
  var st = investGetState_(user);
  if (!st || st.state !== 'running') return;   // sudah selesai/di-reset user
  var cfg = investLoadConfig_(user);
  var pas = investLoadPasaran_();
  var raw = investRawSheet_(user);
  var cursor = parseInt(st.cursor || 0, 10);

  var tz = cfg.TIMEZONE || 'Asia/Jakarta';
  var today     = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var yesterday = Utilities.formatDate(new Date(Date.now() - 864e5), tz, 'yyyy-MM-dd');
  var wanted = {}; wanted[today] = 1; wanted[yesterday] = 1;
  var limits = { '2D': cfg.LIMIT_2D, '3D': cfg.LIMIT_3D, '4D': cfg.LIMIT_4D };
  var buffer = [];

  var flush = function () {
    if (!buffer.length) return;
    var toWrite = buffer;
    buffer = [];
    investRetry_(function () {
      raw.getRange(raw.getLastRow() + 1, 1, toWrite.length, 7).setValues(toWrite);
    });
  };

  investSetState_(user, { state: 'running', cursor: cursor, total: pas.length });

  if (cursor === 0) {
    try {
      if (raw.getLastRow() > 1) investRetry_(function () { raw.getRange(2, 1, raw.getLastRow() - 1, 7).clearContent(); });
    } catch (e) {}
  }

  // Prefetch head semua pasaran sisa (paralel).
  var headCache = {};
  var headPaths = [], headIdx = [];
  for (var h = cursor; h < pas.length; h++) { headPaths.push('admin_invoice13.php?psr=' + pas[h].kode); headIdx.push(h); }
  for (var hb = 0; hb < headPaths.length; hb += INVEST_HEAD_BATCH_) {
    if (Date.now() >= deadline) break;
    var got = investBatchGet_(cfg, headPaths.slice(hb, hb + INVEST_HEAD_BATCH_));
    for (var gi = 0; gi < got.length; gi++) headCache[headIdx[hb + gi]] = got[gi];
  }
  for (var ck in headCache) {
    if (headCache[ck] && headCache[ck].expired) {
      investSetState_(user, { state: 'session_expired', cursor: cursor, message: 'SESSION EXPIRED. Tempel PHPSESSID baru, SIMPAN, lalu klik LANJUTKAN SCAN.' });
      return;
    }
  }

  for (; cursor < pas.length; cursor++) {
    if (Date.now() >= deadline) {
      flush();
      investSetState_(user, { state: 'running', cursor: cursor, message: 'Scan berjalan — pasaran ' + cursor + '/' + pas.length + '…' });
      return; // pump akan menjadwalkan lanjutan
    }

    var p = pas[cursor];
    try {
      var hc0 = headCache[cursor];
      var head0 = (hc0 && hc0.body) ? hc0.body : investFetch_(cfg, 'admin_invoice13.php?psr=' + p.kode);
      var open = investParsePeriode_(head0);
      if (open) {
        for (var i = 0; i < cfg.PERIODE_LOOKBACK; i++) {
          var per = open - i;
          var head = (i === 0) ? head0 : investFetch_(cfg, 'admin_invoice13.php?psr=' + p.kode + '&periode=' + per + '&tombol=2D');
          var totals = investParseTotals_(head);
          var maxG = investMaxGame_(totals);
          if (totals[maxG] === 0) continue;
          var page1 = investFetchFrame_(cfg, p.kode, per, maxG, 0, cfg.PAGE_SIZE);
          var pdate = investFirstDate_(page1);
          if (pdate) {
            if (pdate < yesterday) break;
            if (!wanted[pdate]) continue;
          }
          INVEST_GAMES_.forEach(function (g) {
            if (totals[g] <= limits[g]) return;
            var counts = investCountUsers_(cfg, p.kode, per, g, totals[g], (g === maxG ? page1 : null));
            for (var uu in counts) {
              if (counts[uu] > limits[g]) buffer.push([pdate || today, uu, p.nama, per, g, counts[uu], limits[g]]);
            }
          });
        }
      }
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') {
        flush();
        investSetState_(user, { state: 'session_expired', cursor: cursor, message: 'SESSION EXPIRED di ' + p.nama + '. Tempel PHPSESSID baru, SIMPAN, lalu klik LANJUTKAN SCAN.' });
        return;
      }
      buffer.push([today, '(ERROR)', p.nama, '-', '-', '-', e.message]);
    }

    if (buffer.length >= 400) flush();
    investSetState_(user, { cursor: cursor + 1 });
  }

  flush();
  var n = investAggregateUser_(user);
  investSetState_(user, { state: 'done', cursor: pas.length, finishedAt: new Date().toISOString(), message: 'Scan selesai — ' + n + ' user lewat batas.', warningCount: n });
}

// Gabung _invest_raw_<owner> jadi 1 baris/user di sheet "INVEST <owner>".
function investAggregateUser_(owner) {
  var raw = investRawSheet_(owner);
  var w = investWarnSheet_(owner);
  var cfg = investLoadConfig_(owner);
  var tz = cfg.TIMEZONE || 'Asia/Jakarta';

  // Sheet hasil khusus owner ini -> kosongkan seluruhnya (di bawah header).
  investRetry_(function () { if (w.getLastRow() > 1) w.getRange(2, 1, w.getLastRow() - 1, 7).clearContent(); });

  if (raw.getLastRow() < 2) return 0;
  var rows = investRetry_(function () { return raw.getRange(2, 1, raw.getLastRow() - 1, 7).getValues(); });
  if (!rows.length) return 0;

  var byUser = {};
  rows.forEach(function (r) {
    var tgl = investDateStr_(r[0], tz), user = String(r[1]);
    var pas = String(r[2]), per = r[3], game = String(r[4]), line = Number(r[5]) || 0, lim = Number(r[6]) || 0;
    if (!byUser[user]) byUser[user] = { tgl: {}, pas: {}, hits: [], excess: 0 };
    var u = byUser[user];
    u.tgl[tgl] = 1;
    if (user === '(ERROR)') { u.hits.push({ tanggal: tgl, pasaran: pas, error: String(r[6] || 'error') }); return; }
    u.pas[pas] = 1;
    var over = line - lim;
    u.excess += over;
    u.hits.push({ tanggal: tgl, pasaran: pas, periode: per, game: game, line: line, limit: lim, over: over });
  });

  var dsort = function (a, b) { return investDateStr_(a) < investDateStr_(b) ? -1 : 1; };
  var list = Object.keys(byUser).map(function (user) {
    var u = byUser[user];
    return {
      user: user,
      dates: Object.keys(u.tgl).sort(dsort),
      markets: Object.keys(u.pas).sort(),
      excess: u.excess,
      hits: u.hits.sort(function (a, b) {
        var d = investDateStr_(a.tanggal) < investDateStr_(b.tanggal) ? -1 : (investDateStr_(a.tanggal) > investDateStr_(b.tanggal) ? 1 : 0);
        return d !== 0 ? d : (b.over || 0) - (a.over || 0);
      })
    };
  }).sort(function (a, b) { return b.excess - a.excess; });

  var out = list.map(function (x) {
    return [
      x.dates.join(', '),
      x.user,
      x.markets.join(', '),
      x.hits.map(function (hh) { return hh.periode; }).filter(function (v, i, a) { return v != null && a.indexOf(v) === i; }).join(', '),
      x.hits.map(function (hh) { return hh.error ? (hh.pasaran + ':ERROR') : (hh.game + ' ' + hh.line); }).join(', '),
      x.hits.map(function (hh) { return hh.error ? (hh.pasaran + ': ' + hh.error) : (hh.pasaran + ' ' + hh.periode + ' ' + hh.game + ' ' + hh.line + '/' + hh.limit + ' (+' + hh.over + ')'); }).join('  |  '),
      JSON.stringify(x)
    ];
  });
  if (out.length) investRetry_(function () { w.getRange(2, 1, out.length, 7).setValues(out); });
  return out.length;
}

// =========================== ENDPOINT PUBLIK ================================
function investGetConfig(token) {
  var user = investUserKey_(token);
  return {
    success: true,
    config: investLoadConfig_(user),
    state: investGetState_(user),
    warningCount: investWarningCountForUser_(user)
  };
}

function investSaveConfig(token, data) {
  var user = investUserKey_(token);
  var cfg = investSaveConfigInternal_(user, data);
  try {
    logActivity_(user, 'INVEST SIMPAN SETTING',
      'BASE_URL: ' + cfg.BASE_URL + ' | PHPSESSID ' + (cfg.PHPSESSID ? 'terisi (' + cfg.PHPSESSID.length + ' char)' : 'kosong') +
      ' | limit 2D/3D/4D: ' + cfg.LIMIT_2D + '/' + cfg.LIMIT_3D + '/' + cfg.LIMIT_4D, 'BERHASIL', '');
  } catch (e) {}
  return { success: true, config: cfg };
}

function investTestSession(token) {
  var user = investUserKey_(token);
  try {
    var html = investFetch_(investLoadConfig_(user), 'agentoverview.php');
    return { success: true, message: 'Session valid (' + html.length + ' bytes diterima).' };
  } catch (e) {
    return {
      success: false,
      message: e.message === 'SESSION_EXPIRED'
        ? 'Session sudah tidak valid / expired. Ambil PHPSESSID baru dari browser lalu simpan.'
        : (e && e.message ? e.message : String(e))
    };
  }
}

function investStartScan(token) {
  var user = investUserKey_(token);
  var cfg = investLoadConfig_(user);
  if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) return { success: false, message: 'PHPSESSID belum diisi. Simpan dulu sesinya.' };
  var cur = investGetState_(user);
  if (cur && cur.state === 'running') return { success: false, message: 'Scan kamu sedang berjalan. Tunggu selesai atau klik RESET.' };

  investSetState_(user, {
    state: 'running', cursor: 0, total: investLoadPasaran_().length,
    startedAt: new Date().toISOString(), finishedAt: '', warningCount: 0,
    by: user, message: 'Scan dijadwalkan…'
  });
  investEnsureTrigger_(1000);
  try { logActivity_(user, 'INVEST SCAN MULAI', 'Scan invest dijadwalkan (' + investLoadPasaran_().length + ' pasaran).', 'INFO', ''); } catch (e) {}
  return { success: true, message: 'Scan dijadwalkan — mulai ~1 detik lagi.', state: investGetState_(user) };
}

function investContinueScan(token) {
  var user = investUserKey_(token);
  var cur = investGetState_(user);
  if (cur && cur.state === 'running') return { success: false, message: 'Scan kamu sedang berjalan.' };
  investSetState_(user, { state: 'running', message: 'Melanjutkan scan…' });
  investEnsureTrigger_(1000);
  try { logActivity_(user, 'INVEST SCAN LANJUT', cur && cur.cursor != null ? ('Lanjut dari pasaran ' + cur.cursor) : 'Lanjut scan', 'INFO', ''); } catch (e) {}
  return { success: true, message: 'Scan dilanjutkan — mulai ~1 detik lagi.', state: investGetState_(user) };
}

function investResetScan(token) {
  var user = investUserKey_(token);
  investSetState_(user, { state: 'idle', cursor: 0, message: 'Scan di-reset. Hasil lama tetap ada sampai scan berikutnya.' });
  try { logActivity_(user, 'INVEST SCAN RESET', 'Scan invest di-reset', 'INFO', ''); } catch (e) {}
  // Trigger dibiarkan — pump akan hapus sendiri kalau tidak ada user 'running'.
  return { success: true, message: 'Scan di-reset.' };
}

function investGetStatus(token) {
  var user = investUserKey_(token);
  var st = investGetState_(user);
  st.success = true;
  st.warningCount = investWarningCountForUser_(user);
  return st;
}

function investGetWarnings(token) {
  var user = investUserKey_(token);
  var users = [];
  try {
    var w = investWarnSheetIfExists_(user);   // sheet khusus user ini
    if (w && w.getLastRow() > 1) {
      var vals = w.getRange(2, 1, w.getLastRow() - 1, 7).getValues();
      vals.forEach(function (r) {
        if (!String(r[1] || '').trim()) return;
        var parsed = null;
        try { parsed = r[6] ? JSON.parse(r[6]) : null; } catch (e) {}
        if (parsed && parsed.user) { users.push(parsed); return; }
        var dates0 = String(r[0] || '').split(', ').filter(Boolean);
        var hits0 = [], excess0 = 0;
        String(r[5] || '').split('  |  ').forEach(function (seg) {
          var m = seg.match(/^(.+?)\s+(\d+)\s+(2D|3D|4D)\s+(\d+)\/(\d+)\s+\(\+(\d+)\)$/);
          if (m) { var o = Number(m[6]); excess0 += o; hits0.push({ tanggal: dates0[0] || '?', pasaran: m[1], periode: Number(m[2]), game: m[3], line: Number(m[4]), limit: Number(m[5]), over: o }); }
        });
        users.push({ user: String(r[1]), dates: dates0, markets: String(r[2] || '').split(', ').filter(Boolean), excess: excess0, hits: hits0, raw: hits0.length ? '' : String(r[5] || '') });
      });
    }
  } catch (e) {}
  return { success: true, users: users, state: investGetState_(user), warningCount: users.length };
}
