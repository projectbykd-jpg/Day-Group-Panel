// ============================================================================
// PanelCore.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// Profil user (legacy), Sent Registry, Settings/Maintenance, Dashboard aktivitas, admin kelola Users, Fast Auto Send legacy.
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================


// ==========================================================
// USER PROFILE, DUPLICATE REGISTRY, DASHBOARD & MAINTENANCE
// ==========================================================
function getUserProfileLegacy_(username) {
  const sh = SpreadsheetApp.getActive().getSheetByName("Users");
  if (!sh) return null;
  const values=sh.getDataRange().getValues(); if(values.length<2)return null;
  const headers=values[0].map(x=>String(x).trim().toLowerCase());
  const idx=(...names)=>{for(const n of names){const i=headers.indexOf(String(n).toLowerCase());if(i>-1)return i;}return -1};
  const iUser=idx('username'), iPass=idx('password'), iWeb=idx('website'), iT=idx('telegram'), iL=idx('linktree'), iP=idx('panel-z','panelz');
  const iRole=idx('role'), iStatus=idx('status akun','status'), iName=idx('nama pengguna'), iLast=idx('terakhir login'), iFail=idx('login gagal'), iLock=idx('terkunci sampai'), iTimeout=idx('session timeout');
  for(let r=1;r<values.length;r++) if(String(values[r][iUser]).trim().toLowerCase()===String(username).trim().toLowerCase()){
    return {row:r+1,sheet:sh,username:String(values[r][iUser]).trim(),password:values[r][iPass],websites:String(values[r][iWeb]||'').split(',').map(x=>x.trim()).filter(Boolean),permissions:{telegram:values[r][iT]===true,linktree:values[r][iL]===true,panelz:values[r][iP]===true},role:iRole>-1?String(values[r][iRole]||'OPERATOR').toUpperCase():'OPERATOR',status:iStatus>-1?String(values[r][iStatus]||'AKTIF').toUpperCase():'AKTIF',displayName:iName>-1?String(values[r][iName]||values[r][iUser]):String(values[r][iUser]),timeout:iTimeout>-1?Number(values[r][iTimeout]||60):60,lastCol:{last:iLast,fail:iFail,lock:iLock},failed:iFail>-1?Number(values[r][iFail]||0):0,lockedUntil:iLock>-1?values[r][iLock]:null};
  }
  return null;
}
function updateLastLoginLegacy_(p){if(p.lastCol.last>-1)p.sheet.getRange(p.row,p.lastCol.last+1).setValue(new Date());}
function resetFailedLoginLegacy_(p){if(p.lastCol.fail>-1)p.sheet.getRange(p.row,p.lastCol.fail+1).setValue(0);if(p.lastCol.lock>-1)p.sheet.getRange(p.row,p.lastCol.lock+1).clearContent();}
function registerFailedLoginLegacy_(p){const n=(p.failed||0)+1;if(p.lastCol.fail>-1)p.sheet.getRange(p.row,p.lastCol.fail+1).setValue(n);if(n>=5&&p.lastCol.lock>-1){const d=new Date(Date.now()+10*60000);p.sheet.getRange(p.row,p.lastCol.lock+1).setValue(d);}}
function getCurrentUserProfileInternal_(username){const p=getUserProfile_(username);if(!p)return null;return {username:p.username,role:p.role,displayName:p.displayName,timeout:p.timeout,permissions:p.permissions,websites:p.websites,maintenance:getMaintenanceSettings_()};}

const SENT_REGISTRY_SHEET='Sent Registry';
function contentHash_(s){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||'').trim(),Utilities.Charset.UTF_8);return bytes.map(b=>(b+256)%256).map(b=>('0'+b.toString(16)).slice(-2)).join('');}
// Kunci dedup dinormalisasi dari HASIL YANG SUDAH DIPARSE (Pasaran + Prize 1/2/3),
// bukan dari teks mentah. Dua paste hasil yang sama tapi beda format (spasi, baris
// kosong, urutan baris Shio, dll dari sumber berbeda) akan tetap dianggap duplikat
// selama Pasaran & Prize-nya identik, sehingga tidak lolos kirim dobel.
function dgCanonicalResultKey_(text,precomputedProcessed){
  const processed = precomputedProcessed || processText_(text);
  if (processed && processed.prize1) {
    return 'RESULT|' + String(processed.market||'').trim().toUpperCase() + '|' + processed.prize1 + '|' + (processed.prize2||'') + '|' + (processed.prize3||'');
  }
  return String(text||'').trim();
}
function getSentRegistry_(){
  const ss=SpreadsheetApp.getActive();let sh=ss.getSheetByName(SENT_REGISTRY_SHEET);
  const headers=['Hash','Tanggal/Waktu','Username','Website','Pasaran','Telegram','LinkTree','Panel-Z','Isi/Data'];
  if(!sh){
    sh=ss.insertSheet(SENT_REGISTRY_SHEET);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  } else {
    const current=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getDisplayValues()[0].map(x=>String(x).trim());
    const isNew=current.includes('Website')&&current.includes('Telegram')&&current.includes('Panel-Z')&&current.includes('Isi/Data');
    if(!isNew){
      const old=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,Math.max(sh.getLastColumn(),6)).getValues():[];
      sh.clear();
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      if(old.length){
        const migrated=old.map(r=>[r[0]||'',r[1]||'',r[2]||'', 'LEGACY', r[3]||'-', false,false,false, r[5]||'']);
        sh.getRange(2,1,migrated.length,9).setValues(migrated);
      }
    } else {
      sh.getRange(1,1,1,headers.length).setValues([headers]);
    }
  }
  sh.getRange(1,1,1,9).setFontWeight('bold').setBackground('#312e81').setFontColor('#fff');sh.setFrozenRows(1);
  [180,150,120,130,150,90,90,90,520].forEach((w,i)=>sh.setColumnWidth(i+1,w));
  if(sh.getLastRow()>1)sh.getRange(2,1,sh.getLastRow()-1,9).setWrap(true).setVerticalAlignment('top');
  try{sh.hideSheet();}catch(e){}
  return sh;
}
function getRegistryEntryLegacy_(website,content){
  const sh=getSentRegistry_();if(sh.getLastRow()<2)return null;const hash=contentHash_(content),site=String(website||'').trim().toUpperCase();
  const vals=sh.getRange(2,1,sh.getLastRow()-1,9).getValues();
  for(let i=vals.length-1;i>=0;i--){if(String(vals[i][0])===hash&&String(vals[i][3]).trim().toUpperCase()===site)return {row:i+2,date:vals[i][1] instanceof Date?Utilities.formatDate(vals[i][1],'GMT+7','dd/MM/yyyy HH:mm:ss'):String(vals[i][1]),username:String(vals[i][2]),website:String(vals[i][3]),market:String(vals[i][4]),telegram:vals[i][5]===true||String(vals[i][5]).toUpperCase()==='TRUE',linktree:vals[i][6]===true||String(vals[i][6]).toUpperCase()==='TRUE',panelz:vals[i][7]===true||String(vals[i][7]).toUpperCase()==='TRUE'};}
  return null;
}
function getWebsiteDeliveryStatusLegacy_(profile,content){
  return profile.websites.map(website=>{
    const e=getRegistryEntry_(website,content);
    const systems={
      telegram:{allowed:!!profile.permissions.telegram,sent:!!(e&&e.telegram)},
      linktree:{allowed:!!profile.permissions.linktree,sent:!!(e&&e.linktree)},
      panelz:{allowed:!!profile.permissions.panelz,sent:!!(e&&e.panelz)}
    };
    const hasPending=Object.keys(systems).some(k=>systems[k].allowed&&!systems[k].sent);
    return {website:website,systems:systems,hasPending:hasPending,last:e?{date:e.date,username:e.username}:null};
  });
}
function saveOrUpdateSentRegistry_(username,website,content,market,merged,result){
  const sh=getSentRegistry_(),old=getRegistryEntry_(website,content),row=old?old.row:sh.getLastRow()+1;
  sh.getRange(row,1,1,9).setValues([[contentHash_(content),new Date(),username,website,market||'-',!!merged.telegram,!!merged.linktree,!!merged.panelz,content]]);
  sh.getRange(row,2).setNumberFormat('dd/MM/yyyy HH:mm:ss');sh.getRange(row,1,1,9).setWrap(true).setVerticalAlignment('top');sh.setRowHeight(row,42);
}
function findDuplicateSend_(username,content){
  const p=getUserProfile_(username);if(!p)return null;const list=getWebsiteDeliveryStatus_(p,content),done=list.filter(x=>!x.hasPending),pending=list.filter(x=>x.hasPending);
  return done.length||pending.length?{completedWebsites:done.map(x=>x.website),pendingWebsites:pending.map(x=>x.website),websiteStatus:list}:null;
}
function saveSentRegistry_(username,content,market,status){
  const p=getUserProfile_(username);if(!p)return;p.websites.forEach(w=>saveOrUpdateSentRegistry_(username,w,content,market,{telegram:true,linktree:true,panelz:true},{}));
}

const SETTINGS_SHEET='Settings';
function getSettingsSheet_(){const ss=SpreadsheetApp.getActive();let sh=ss.getSheetByName(SETTINGS_SHEET);if(!sh){sh=ss.insertSheet(SETTINGS_SHEET);sh.getRange(1,1,5,2).setValues([['Pengaturan','Nilai'],['Maintenance','FALSE'],['Maintenance Message','Panel sedang dalam pemeliharaan. Silakan coba kembali nanti.'],['Updated By','SYSTEM'],['Updated At',new Date()]]);sh.getRange(1,1,1,2).setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');sh.setColumnWidth(1,190);sh.setColumnWidth(2,520);sh.hideSheet();}return sh;}
function getMaintenanceSettingsSource_(){const sh=getSettingsSheet_();const vals=sh.getRange(2,1,Math.max(sh.getLastRow()-1,1),2).getValues();const m={};vals.forEach(r=>m[String(r[0]).toLowerCase()]=r[1]);return {enabled:String(m.maintenance).toUpperCase()==='TRUE'||m.maintenance===true,message:String(m['maintenance message']||'Panel sedang dalam pemeliharaan.')};}
function setMaintenanceInternal_(username,enabled,message){const p=getUserProfile_(username);if(!p||p.role!=='ADMIN')throw new Error('Hanya admin yang diizinkan');const sh=getSettingsSheet_();sh.getRange(2,2).setValue(!!enabled);sh.getRange(3,2).setValue(String(message||'Panel sedang dalam pemeliharaan.'));sh.getRange(4,2).setValue(username);sh.getRange(5,2).setValue(new Date());logActivity_(username,'MODE MAINTENANCE',enabled?'Diaktifkan':'Dinonaktifkan','BERHASIL',message||'');return getMaintenanceSettings_();}

function getDashboardDataInternal_(username, request) {
  const profile = getUserProfile_(username);
  if (!profile) throw new Error("User tidak ditemukan");

  const options = normalizeDashboardRequest_(request);

  // Cache pendek (15 detik) per kombinasi role + filter, supaya klik-klik ganti tab
  // atau refresh beruntun tidak scan ulang ribuan baris sheet setiap kali.
  const cacheKey = "dash-v1-" + profile.role + "-" + JSON.stringify(options);
  try {
    const cached = dgCache_().get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  const result = getDashboardDataFresh_(profile, options);
  // Ringkasan header (dipoll terus) di-cache lebih lama daripada tampilan tabel.
  const light = options.page === 1 && options.pageSize <= 5 &&
    !options.query && !options.username && !options.action && !options.status && !options.dateFrom && !options.dateTo;
  try { dgCache_().put(cacheKey, JSON.stringify(result), light ? 45 : DASHBOARD_CACHE_SECONDS_); } catch (e) {}
  return result;
}

function getDashboardDataFresh_(profile, options) {
  const today = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");

  // Rollover hari baru: pakai lock PENDEK (2 dtk) + hanya pindah baris kemarin.
  // Rotasi arsip (yang berat: salin ribuan baris ke file lain) DILEWATI di sini,
  // dibiarkan ke trigger harian / tombol admin -> buka Aktivitas tidak lagi
  // ketahan 5-30 detik saat kebetulan jadi orang pertama di hari itu.
  const activeDate = PropertiesService.getScriptProperties().getProperty("DAYGROUP_ACTIVITY_ACTIVE_DATE");
  if (activeDate !== today) {
    const rollLock = LockService.getDocumentLock();
    try {
      if (rollLock.tryLock(2000)) rolloverActivityLogIfNeeded_(getOrCreateActivityLogSheet_(), false);
    } catch (error) {} finally {
      try { rollLock.releaseLock(); } catch (e) {}
    }
  }

  const currentSheet = getOrCreateActivityLogSheet_();
  const currentRows = readActivityRowsFast_(
    currentSheet,
    "HARI INI",
    Math.max(currentSheet.getLastRow() - 1, 0)
  );

  let combined = currentRows.slice();
  let backupScanned = 0;
  let backupTotal = 0;
  let scanLimited = false;
  let archiveScanned = 0;

  const isFiltered = !!(options.query || options.username || options.action || options.status || options.dateFrom || options.dateTo);
  // Panggilan ringkasan header (live-poll tiap ~15 dtk) cuma butuh statistik hari
  // ini -> TIDAK usah baca backup sama sekali. Ini yang paling sering dipanggil.
  const statsOnly = !isFiltered && options.page === 1 && options.pageSize <= 5;

  if (profile.role === "ADMIN" && options.source !== "CURRENT") {
    const backupSheet = getOrCreateActivityBackupSheet_();
    backupTotal = Math.max(backupSheet.getLastRow() - 1, 0);

    if (!statsOnly) {
      // "BackUp Activity Log" kini hanya menyimpan maksimal ACTIVITY_RETENTION_DAYS_
      // hari terakhir, jadi ukurannya kecil. Tanpa filter cukup baca halaman terbaru;
      // dengan filter baca seluruhnya (tidak ada lagi file arsip terpisah).
      const need = isFiltered
        ? backupTotal
        : Math.min(ACTIVITY_DASHBOARD_MAX_SCAN_, Math.max(300, options.page * options.pageSize * 4));
      backupScanned = Math.min(backupTotal, need);
      scanLimited = false;
      combined = combined.concat(readActivityRowsFast_(backupSheet, "BACKUP", backupScanned));
    }
  }

  if (profile.role !== "ADMIN") {
    combined = combined.filter(function (row) {
      return String(row[1] || "").toLowerCase() === profile.username.toLowerCase() &&
        String(row[6] || "") === "HARI INI";
    });
  }

  combined = combined.filter(function (row) {
    if (options.source === "CURRENT" && row[6] !== "HARI INI") return false;
    if (options.source === "BACKUP" && row[6] !== "BACKUP") return false;
    if (options.username && String(row[1] || "").toLowerCase() !== options.username.toLowerCase()) return false;
    if (options.action && String(row[2] || "").toUpperCase() !== options.action.toUpperCase()) return false;
    if (options.status && String(row[3] || "").toUpperCase() !== options.status.toUpperCase()) return false;

    const dateKey = activityIsoDate_(row[0]);
    if (options.dateFrom && dateKey && dateKey < options.dateFrom) return false;
    if (options.dateTo && dateKey && dateKey > options.dateTo) return false;

    if (options.query) {
      const haystack = row.slice(0, 6).join(" ").toLowerCase();
      if (haystack.indexOf(options.query.toLowerCase()) < 0) return false;
    }
    return true;
  });

  combined.sort(function (a, b) {
    return activityTimestampMs_(b[0]) - activityTimestampMs_(a[0]);
  });

  const total = combined.length;
  const totalPages = Math.max(Math.ceil(total / options.pageSize), 1);
  const page = Math.min(options.page, totalPages);
  const start = (page - 1) * options.pageSize;
  const rows = combined.slice(start, start + options.pageSize);

  const todayScope = currentRows.filter(function (row) {
    return String(row[0] || "").indexOf(today) === 0 &&
      (profile.role === "ADMIN" || String(row[1] || "").toLowerCase() === profile.username.toLowerCase());
  });

  const stats = {
    today: todayScope.length,
    login: todayScope.filter(function (row) { return row[2] === "LOGIN" && row[3] === "BERHASIL"; }).length,
    sends: todayScope.filter(function (row) { return /SEND|KIRIM/.test(String(row[2] || "").toUpperCase()); }).length,
    success: todayScope.filter(function (row) { return row[3] === "BERHASIL"; }).length,
    failed: todayScope.filter(function (row) { return /GAGAL|ERROR/.test(String(row[3] || "").toUpperCase()); }).length,
    currentTotal: Math.max(currentSheet.getLastRow() - 1, 0),
    backupTotal: profile.role === "ADMIN" ? backupTotal : 0,
    found: total
  };

  if (profile.role === "ADMIN") {
    const counts = {};
    todayScope.forEach(function (row) {
      counts[row[1]] = (counts[row[1]] || 0) + 1;
    });
    stats.topUser = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || "-";
  }

  const optionRows = profile.role === "ADMIN" ? combined : todayScope;
  return {
    role: profile.role,
    rows: rows,
    stats: stats,
    maintenance: getMaintenanceSettings_(),
    pagination: {
      page: page,
      pageSize: options.pageSize,
      total: total,
      totalPages: totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages
    },
    filterOptions: {
      usernames: uniqueSortedActivityValues_(optionRows, 1),
      actions: uniqueSortedActivityValues_(optionRows, 2),
      statuses: uniqueSortedActivityValues_(optionRows, 3)
    },
    sourceInfo: {
      currentTotal: Math.max(currentSheet.getLastRow() - 1, 0),
      backupTotal: backupTotal,
      backupScanned: backupScanned,
      archiveScanned: archiveScanned,
      scanLimited: scanLimited
    }
  };
}

// Daftar ID spreadsheet arsip (Day-Group Arsip Activity Log <tahun>) dari Script Properties.
function listArchiveSpreadsheetIds_() {
  const props = dgProps_().getProperties();
  const ids = [];
  Object.keys(props).forEach(function (key) {
    if (key.indexOf("DG_ARCHIVE_SS_") === 0 && props[key]) ids.push(props[key]);
  });
  return ids;
}

// Baca baris aktivitas dari SEMUA file arsip terpisah (paling baru dulu), dibatasi maxRows.
function readArchiveActivityRows_(maxRows) {
  const cap = Number(maxRows) || 4000;
  const out = [];
  const ids = listArchiveSpreadsheetIds_();
  for (let i = ids.length - 1; i >= 0 && out.length < cap; i--) {
    let ss;
    try { ss = SpreadsheetApp.openById(ids[i]); } catch (e) { continue; }
    const sheets = ss.getSheets();
    for (let s = sheets.length - 1; s >= 0 && out.length < cap; s--) {
      const sheet = sheets[s];
      const last = sheet.getLastRow();
      if (last < 2) continue;
      const take = Math.min(last - 1, cap - out.length);
      const startRow = last - take + 1;
      const rows = sheet.getRange(startRow, 1, take, ACTIVITY_LOG_COLS).getDisplayValues();
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (row.some(function (v) { return String(v == null ? "" : v).trim() !== ""; })) {
          out.push(row.concat(["BACKUP"]));
        }
      }
    }
  }
  return out;
}

function normalizeDashboardRequest_(request) {
  if (typeof request === "number") {
    return { page: 1, pageSize: Math.min(Math.max(Number(request) || 100, 10), 250), query: "", username: "", action: "", status: "", source: "ALL", dateFrom: "", dateTo: "" };
  }

  const value = request || {};
  return {
    page: Math.max(Number(value.page) || 1, 1),
    pageSize: Math.min(Math.max(Number(value.pageSize) || 75, 10), 200),
    query: String(value.query || "").trim(),
    username: String(value.username || "").trim(),
    action: String(value.action || "").trim(),
    status: String(value.status || "").trim(),
    source: ["ALL", "CURRENT", "BACKUP"].indexOf(String(value.source || "ALL").toUpperCase()) >= 0
      ? String(value.source || "ALL").toUpperCase()
      : "ALL",
    dateFrom: String(value.dateFrom || "").trim(),
    dateTo: String(value.dateTo || "").trim()
  };
}

function readActivityRowsFast_(sheet, source, maxRows) {
  if (!sheet || sheet.getLastRow() < 2 || maxRows <= 0) return [];
  const total = sheet.getLastRow() - 1;
  const count = Math.min(total, Number(maxRows) || total);
  const startRow = Math.max(2, sheet.getLastRow() - count + 1);
  return sheet.getRange(startRow, 1, count, ACTIVITY_LOG_COLS).getDisplayValues()
    .filter(function (row) {
      return row.some(function (value) { return String(value || "").trim() !== ""; });
    })
    .map(function (row) {
      return row.concat([source]);
    });
}

function activityIsoDate_(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? match[3] + "-" + match[2] + "-" + match[1] : "";
}

function activityTimestampMs_(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return 0;
  return new Date(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0)
  ).getTime();
}

function uniqueSortedActivityValues_(rows, index) {
  return Array.from(new Set((rows || []).map(function (row) {
    return String(row[index] || "").trim();
  }).filter(Boolean))).sort();
}

// ==========================================================
// ADMIN - KELOLA USERS LANGSUNG DARI PANEL
// ==========================================================
const USER_HEADERS_REQUIRED_ = ["Username","Password","Website","Telegram","LinkTree","Panel-Z","Role","Status Akun","Nama Pengguna","Terakhir Login","Login Gagal","Terkunci Sampai","Session Timeout","Catatan Admin"];
function requireAdmin_(username){const p=getUserProfile_(username);if(!p||p.role!=="ADMIN")throw new Error("Akses ditolak. Hanya ADMIN yang diizinkan.");return p;}
function getUsersSheetAndMap_(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();let sh=ss.getSheetByName("Users");if(!sh)sh=ss.insertSheet("Users");
  if(sh.getLastRow()<1)sh.getRange(1,1,1,USER_HEADERS_REQUIRED_.length).setValues([USER_HEADERS_REQUIRED_]);
  let headers=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getDisplayValues()[0].map(x=>String(x).trim());
  USER_HEADERS_REQUIRED_.forEach(h=>{if(!headers.some(x=>x.toLowerCase()===h.toLowerCase())){sh.insertColumnAfter(sh.getLastColumn());sh.getRange(1,sh.getLastColumn()).setValue(h);headers.push(h);}});
  const map={};headers.forEach((h,i)=>map[h.toLowerCase()]=i+1);
  sh.getRange(1,1,1,headers.length).setFontWeight("bold").setFontColor("#ffffff").setBackground("#166534").setHorizontalAlignment("center");sh.setFrozenRows(1);
  return {sh:sh,map:map,headers:headers};
}
function adminListUsersInternal_(adminUsername){
  requireAdmin_(adminUsername);const x=getUsersSheetAndMap_(),sh=x.sh,m=x.map;const last=sh.getLastRow();if(last<2)return [];
  return sh.getRange(2,1,last-1,sh.getLastColumn()).getValues().filter(r=>String(r[m['username']-1]||'').trim()).map(r=>({
    username:String(r[m['username']-1]||'').trim(),displayName:String(r[m['nama pengguna']-1]||''),websites:String(r[m['website']-1]||''),role:String(r[m['role']-1]||'OPERATOR').toUpperCase(),status:String(r[m['status akun']-1]||'AKTIF').toUpperCase(),telegram:r[m['telegram']-1]===true,linktree:r[m['linktree']-1]===true,panelz:r[m['panel-z']-1]===true,lastLogin:r[m['terakhir login']-1] instanceof Date?Utilities.formatDate(r[m['terakhir login']-1],Session.getScriptTimeZone()||'GMT+7','dd/MM/yyyy HH:mm:ss'):String(r[m['terakhir login']-1]||''),timeout:Number(r[m['session timeout']-1]||60),note:String(r[m['catatan admin']-1]||''),failed:Number(r[m['login gagal']-1]||0)
  }));
}
// Baca kolom username SEKALI (bukan getValue() per baris) -> {usernameLower: row}.
// Dipakai oleh save/delete supaya pencarian baris tidak butuh puluhan/ratusan API call terpisah.
function findUserRowMap_(sh, m) {
  const last = sh.getLastRow();
  const map = {};
  if (last < 2) return map;
  sh.getRange(2, m['username'], last - 1, 1).getValues().forEach(function (r, i) {
    const u = String(r[0] || '').trim();
    if (u) map[u.toLowerCase()] = i + 2;
  });
  return map;
}

function adminSaveUserInternal_(adminUsername,data){
  const admin=requireAdmin_(adminUsername);data=data||{};const x=getUsersSheetAndMap_(),sh=x.sh,m=x.map;const original=String(data.originalUsername||'').trim(),username=String(data.username||'').trim();if(!username)throw new Error('Username wajib diisi.');
  const role=String(data.role||'OPERATOR').toUpperCase(),status=String(data.status||'AKTIF').toUpperCase();if(!['ADMIN','OPERATOR','VIEWER'].includes(role))throw new Error('Role tidak valid.');if(!['AKTIF','NONAKTIF','TERKUNCI'].includes(status))throw new Error('Status akun tidak valid.');

  const rowMap = findUserRowMap_(sh, m);
  let row = original ? (rowMap[original.toLowerCase()] || 0) : 0;
  if (!original && rowMap[username.toLowerCase()]) throw new Error('Username sudah digunakan.');
  if (original && original.toLowerCase() !== username.toLowerCase()) {
    const clash = rowMap[username.toLowerCase()];
    if (clash && clash !== row) throw new Error('Username baru sudah digunakan akun lain.');
  }
  const isNewRow = !row;
  if(isNewRow){row=Math.max(sh.getLastRow()+1,2);sh.insertRowAfter(Math.max(sh.getLastRow(),1));}
  if(original&&original.toLowerCase()===admin.username.toLowerCase()&&(role!=='ADMIN'||status!=='AKTIF'))throw new Error('Akun admin yang sedang digunakan tidak boleh diturunkan role atau dinonaktifkan.');
  if(String(data.password||'')===''&&!original)throw new Error('Password wajib untuk akun baru.');

  // Semua kolom ditulis dalam SATU setValues() per baris, ganti ~10 setValue() terpisah tiap simpan.
  const width = sh.getLastColumn();
  const rowValues = isNewRow ? new Array(width).fill('') : sh.getRange(row,1,1,width).getValues()[0];
  rowValues[m['username']-1]=username;
  if(String(data.password||'')!=='')rowValues[m['password']-1]=String(data.password);
  rowValues[m['website']-1]=String(data.websites||'').trim();
  rowValues[m['telegram']-1]=!!data.telegram;
  rowValues[m['linktree']-1]=!!data.linktree;
  rowValues[m['panel-z']-1]=!!data.panelz;
  rowValues[m['role']-1]=role;
  rowValues[m['status akun']-1]=status;
  rowValues[m['nama pengguna']-1]=String(data.displayName||username).trim();
  rowValues[m['session timeout']-1]=Math.max(5,Math.min(Number(data.timeout)||60,1440));
  rowValues[m['catatan admin']-1]=String(data.note||'');
  if(isNewRow){rowValues[m['login gagal']-1]=0;rowValues[m['terkunci sampai']-1]='';}
  sh.getRange(row,1,1,width).setValues([rowValues]);

  // Checkbox cuma dipasang untuk baris baru ini, bukan seluruh kolom tiap kali simpan user manapun.
  if(isNewRow){[m['telegram'],m['linktree'],m['panel-z']].forEach(c=>sh.getRange(row,c,1,1).insertCheckboxes());}

  CacheService.getScriptCache().removeAll(['users-cache-v5']);
  logActivity_(admin.username,original?'EDIT USER':'TAMBAH USER',`Target: ${username} | Role: ${role} | Status: ${status}`,'BERHASIL',`Website: ${data.websites||''} | Telegram: ${!!data.telegram} | LinkTree: ${!!data.linktree} | Panel-Z: ${!!data.panelz}`);
  return {success:true,message:original?'User berhasil diperbarui di Sheet Users.':'User baru berhasil ditambahkan ke Sheet Users.'};
}
function adminDeleteUserInternal_(adminUsername,targetUsername){
  const admin=requireAdmin_(adminUsername),target=String(targetUsername||'').trim();if(!target)throw new Error('Username target kosong.');if(target.toLowerCase()===admin.username.toLowerCase())throw new Error('Anda tidak dapat menghapus akun admin yang sedang digunakan.');
  const x=getUsersSheetAndMap_(),sh=x.sh,m=x.map;const last=sh.getLastRow();if(last<2)throw new Error('User tidak ditemukan.');

  // Satu kali getValues() untuk seluruh tabel (bukan getValue() per baris) -> cari baris & hitung admin sekaligus.
  const rows=sh.getRange(2,1,last-1,sh.getLastColumn()).getValues();
  let row=0,role='',adminCount=0;
  rows.forEach(function(r,i){
    const ro=String(r[m['role']-1]||'').toUpperCase();
    if(ro==='ADMIN')adminCount++;
    if(String(r[m['username']-1]||'').trim().toLowerCase()===target.toLowerCase()){row=i+2;role=ro||'OPERATOR';}
  });
  if(!row)throw new Error('User tidak ditemukan.');
  if(role==='ADMIN'&&adminCount<=1)throw new Error('Admin terakhir tidak boleh dihapus.');
  sh.deleteRow(row);logActivity_(admin.username,'HAPUS USER','Target: '+target,'BERHASIL','Akun dihapus dari Sheet Users');return {success:true,message:'User '+target+' berhasil dihapus dari Sheet Users.'};
}
function adminResetUserLockInternal_(adminUsername,targetUsername){
  const admin=requireAdmin_(adminUsername),p=getUserProfile_(targetUsername);if(!p)throw new Error('User tidak ditemukan.');if(p.lastCol.fail>-1)p.sheet.getRange(p.row,p.lastCol.fail+1).setValue(0);if(p.lastCol.lock>-1)p.sheet.getRange(p.row,p.lastCol.lock+1).clearContent();
  const x=getUsersSheetAndMap_();if(x.map['status akun']&&String(p.sheet.getRange(p.row,x.map['status akun']).getValue()).toUpperCase()==='TERKUNCI')p.sheet.getRange(p.row,x.map['status akun']).setValue('AKTIF');
  logActivity_(admin.username,'RESET KUNCI USER','Target: '+p.username,'BERHASIL','Login gagal direset menjadi 0');return {success:true,message:'Kunci dan login gagal '+p.username+' berhasil direset.'};
}


// ==========================================================
// FAST AUTO SEND ENGINE
// Satu panggilan server, satu kali baca Users/Sosmed/Registry,
// kirim semua website pending, lalu satu kali batch write registry.
// ==========================================================

function smartAutoSendFastInternal_(rawText, username) {
  const startedAt = Date.now();
  const cleanUser = String(username || "").trim();
  const profile = getUserProfile_(cleanUser);

  if (!profile) {
    return {
      success: false,
      blocked: true,
      message: "User tidak ditemukan.",
      websiteResults: []
    };
  }

  const maintenance = getMaintenanceSettings_();
  if (maintenance.enabled && profile.role !== "ADMIN") {
    return {
      success: false,
      blocked: true,
      message: maintenance.message,
      websiteResults: []
    };
  }

  const processed = processText_(rawText);
  const textToSend = processed.output || String(rawText || "").trim();

  if (!textToSend) {
    return {
      success: false,
      blocked: true,
      message: "Isi data kosong.",
      websiteResults: []
    };
  }

  const websites = Array.from(new Set(
    (profile.websites || [])
      .map(function (value) {
        return String(value || "").trim().toUpperCase();
      })
      .filter(Boolean)
  ));

  if (!websites.length) {
    return {
      success: false,
      blocked: true,
      message: "Akun ini belum memiliki website pada Sheet Users.",
      websiteResults: []
    };
  }

  // Baca konfigurasi Sosmed sekali.
  const accountMap = readSosmedAccountsFast_();

  // Baca seluruh registry sekali dan cari berdasarkan hash + website di memori.
  const registrySheet = getSentRegistryFast_();
  const registryData = readSentRegistryFast_(registrySheet);
  const hash = contentHash_(textToSend);

  const websiteResults = [];
  const registryChanges = [];

  websites.forEach(function (website) {
    const registryKey = hash + "||" + website;
    const previous = registryData.map[registryKey] || null;
    const account = accountMap[website] || null;

    const websiteResult = {
      website: website,
      telegram: { status: "SKIP", reason: "Tidak diproses" },
      linktree: { status: "SKIP", reason: "Tidak diproses" },
      panelz: { status: "SKIP", reason: "Tidak diproses" }
    };

    const systemDefinitions = [
      {
        key: "telegram",
        allowed: !!profile.permissions.telegram,
        already: !!(previous && previous.telegram),
        send: function () {
          return account
            ? sendToTelegramInternal_(textToSend, account.TELEGRAM)
            : "Konfigurasi website " + website + " tidak ditemukan";
        }
      },
      {
        key: "linktree",
        allowed: !!profile.permissions.linktree,
        already: !!(previous && previous.linktree),
        send: function () {
          return account
            ? sendToAWSInternal_(textToSend, account.LINKTREE)
            : "Konfigurasi website " + website + " tidak ditemukan";
        }
      },
      {
        key: "panelz",
        allowed: !!profile.permissions.panelz,
        already: !!(previous && previous.panelz),
        send: function () {
          return account
            ? sendToPanelZInternal_(textToSend, account.PANELZ)
            : "Konfigurasi website " + website + " tidak ditemukan";
        }
      }
    ];

    systemDefinitions.forEach(function (definition) {
      const key = definition.key;

      if (!definition.allowed) {
        websiteResult[key] = {
          status: "DIBLOKIR",
          reason: "Tidak diizinkan pada Sheet Users"
        };
        return;
      }

      if (definition.already) {
        const sender = previous && previous.username
          ? previous.username
          : "user sebelumnya";
        const dateText = previous && previous.dateText
          ? previous.dateText
          : "waktu tidak tercatat";

        websiteResult[key] = {
          status: "SUDAH DIKIRIM",
          reason: "Pernah dikirim oleh " + sender + " pada " + dateText
        };
        return;
      }

      let sendResponse;
      try {
        sendResponse = definition.send();
      } catch (error) {
        sendResponse = "Error: " + error.message;
      }

      websiteResult[key] = normalizeSendResult_(sendResponse);
    });

    const merged = {
      telegram:
        !!(previous && previous.telegram) ||
        websiteResult.telegram.status === "BERHASIL",
      linktree:
        !!(previous && previous.linktree) ||
        websiteResult.linktree.status === "BERHASIL",
      panelz:
        !!(previous && previous.panelz) ||
        websiteResult.panelz.status === "BERHASIL"
    };

    if (merged.telegram || merged.linktree || merged.panelz) {
      registryChanges.push({
        row: previous ? previous.row : 0,
        values: [
          hash,
          new Date(),
          cleanUser,
          website,
          processed.market || "-",
          merged.telegram,
          merged.linktree,
          merged.panelz,
          textToSend
        ]
      });
    }

    websiteResults.push(websiteResult);
  });

  // Semua perubahan registry ditulis sekaligus.
  writeSentRegistryBatchFast_(registrySheet, registryChanges);

  const counters = {
    success: 0,
    failed: 0,
    blocked: 0,
    already: 0,
    skipped: 0
  };

  websiteResults.forEach(function (websiteResult) {
    ["telegram", "linktree", "panelz"].forEach(function (key) {
      const status = String(
        (websiteResult[key] && websiteResult[key].status) || "SKIP"
      ).toUpperCase();

      if (status === "BERHASIL") counters.success++;
      else if (status === "GAGAL") counters.failed++;
      else if (status === "DIBLOKIR") counters.blocked++;
      else if (status === "SUDAH DIKIRIM") counters.already++;
      else counters.skipped++;
    });
  });

  const detail = websiteResults.map(function (websiteResult) {
    const shortSystem = function (label, item) {
      const status = String((item && item.status) || "SKIP").toUpperCase();
      const reason = String((item && item.reason) || "").trim();
      const shortReason = reason.length > 70
        ? reason.substring(0, 67) + "..."
        : reason;

      return label + ": " + status +
        (shortReason ? " — " + shortReason : "");
    };

    return "[" + websiteResult.website + "]\n" +
      shortSystem("Telegram", websiteResult.telegram) + "\n" +
      shortSystem("LinkTree", websiteResult.linktree) + "\n" +
      shortSystem("Panel-Z", websiteResult.panelz);
  }).join("\n\n");

  const allDuplicate =
    counters.success === 0 &&
    counters.failed === 0 &&
    counters.already > 0;

  const logStatus =
    counters.failed > 0 && counters.success === 0
      ? "GAGAL"
      : counters.failed > 0
        ? "SEBAGIAN"
        : counters.success > 0
          ? "BERHASIL"
          : allDuplicate
            ? "DIBLOKIR"
            : "INFO";

  // Activity Log hanya satu kali setelah seluruh proses selesai.
  logActivity_(
    cleanUser,
    allDuplicate ? "DUPLIKAT WEBSITE DIBLOKIR" : "FAST AUTO SEND",
    detail,
    logStatus,
    textToSend
  );

  return {
    success: counters.failed === 0 && counters.success > 0,
    partial: counters.success > 0 && counters.failed > 0,
    allAlready: allDuplicate,
    blocked: counters.success === 0 && counters.failed === 0,
    message: allDuplicate
      ? "Semua website yang diizinkan sudah pernah menerima data ini."
      : "Proses selesai.",
    websiteResults: websiteResults,
    counters: counters,
    content: textToSend,
    market: processed.market || "-",
    durationMs: Date.now() - startedAt
  };
}

function readSosmedAccountsFastLegacy_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sosmed");
  const map = {};

  if (!sheet || sheet.getLastRow() < 2) {
    return map;
  }

  const values = sheet.getDataRange().getValues();

  for (let row = 1; row < values.length; row++) {
    const website = String(values[row][0] || "").trim().toUpperCase();
    if (!website) continue;

    map[website] = {
      TELEGRAM: {
        TOKEN: values[row][1],
        CHAT_ID: values[row][2]
      },
      LINKTREE: {
        EMAIL: values[row][3],
        PASS: values[row][4]
      },
      PANELZ: {
        USERNAME: values[row][5],
        PASSWORD: values[row][6],
        USERNAME2: values[row][7],
        PASSWORD2: values[row][8],
        URL: values[row][9]
      }
    };
  }

  return map;
}

function getSentRegistryFast_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SENT_REGISTRY_SHEET);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SENT_REGISTRY_SHEET);
    const headers = [
      "Hash",
      "Tanggal/Waktu",
      "Username",
      "Website",
      "Pasaran",
      "Telegram",
      "LinkTree",
      "Panel-Z",
      "Isi/Data"
    ];

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setBackground("#312e81")
      .setFontColor("#ffffff");

    sheet.setFrozenRows(1);

    try {
      sheet.hideSheet();
    } catch (error) {}
  }

  return sheet;
}

function readSentRegistryFast_(sheet) {
  const map = {};
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return { map: map, lastRow: lastRow };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 9).getValues();

  values.forEach(function (row, index) {
    const hash = String(row[0] || "");
    const website = String(row[3] || "").trim().toUpperCase();

    if (!hash || !website || website === "LEGACY") return;

    const key = hash + "||" + website;
    const rawDate = row[1];

    map[key] = {
      row: index + 2,
      hash: hash,
      username: String(row[2] || ""),
      website: website,
      market: String(row[4] || ""),
      telegram:
        row[5] === true ||
        String(row[5]).toUpperCase() === "TRUE",
      linktree:
        row[6] === true ||
        String(row[6]).toUpperCase() === "TRUE",
      panelz:
        row[7] === true ||
        String(row[7]).toUpperCase() === "TRUE",
      dateText:
        rawDate instanceof Date
          ? Utilities.formatDate(
              rawDate,
              "GMT+7",
              "dd/MM/yyyy HH:mm:ss"
            )
          : String(rawDate || "")
    };
  });

  return { map: map, lastRow: lastRow };
}

function writeSentRegistryBatchFast_(sheet, changes) {
  if (!changes || !changes.length) return;

  const updates = changes.filter(function (item) {
    return item.row > 0;
  });

  const inserts = changes.filter(function (item) {
    return !item.row;
  });

  // Update existing rows. Jumlahnya umumnya kecil dan tidak memformat sheet.
  updates.forEach(function (item) {
    sheet.getRange(item.row, 1, 1, 9).setValues([item.values]);
  });

  // Semua baris baru ditulis dalam satu batch.
  if (inserts.length) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, inserts.length, 9)
      .setValues(inserts.map(function (item) {
        return item.values;
      }));

    sheet.getRange(startRow, 2, inserts.length, 1)
      .setNumberFormat("dd/MM/yyyy HH:mm:ss");
  }
}


/**
 * Jalankan satu kali dari editor Apps Script untuk merapikan seluruh
 * Activity Log lama tanpa menghapus data.
 */
function rapikanSemuaActivityLogInternal_() {
  const sheet = getOrCreateActivityLogSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return "Activity Log masih kosong.";

  for (let row = 2; row <= lastRow; row++) {
    const username = String(sheet.getRange(row, 2).getDisplayValue() || "").trim();
    if (username) formatActivityLogRow_(sheet, row);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, ACTIVITY_LOG_COLS)
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#0f766e")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  SpreadsheetApp.flush();
  return (lastRow - 1) + " baris Activity Log berhasil dirapikan.";
}