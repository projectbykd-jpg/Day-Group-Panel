// ============================================================================
// V6Core.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// DAYGROUP-V6.0-FAST-SECURE: crypto/PBKDF2, sesi token, cache Users/Sosmed, mesin kirim V6 paralel, endpoint publik google.script.run, admin sesi aktif.
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================


// ============================================================================
// Day-Group Panel — FAST + SECURE MULTI USER CORE
// 19+ users ready: authenticated sessions, cached sheet config, parallel I/O,
// short reservation locks, cached remote sessions/rows, batch registry writes,
// performance telemetry, and automatic password-hash migration.
// ============================================================================
const DG_V6_VERSION_ = 'DAYGROUP-V6.0-FAST-SECURE';
const DG_USERS_CACHE_KEY_ = 'DG_V6_USERS';
const DG_USERS_CACHE_SECONDS_ = 180;
const DG_SOSMED_CACHE_KEY_ = 'DG_V6_SOSMED';
const DG_SOSMED_CACHE_SECONDS_ = 300;
const DG_PREDICTION_ACCOUNTS_CACHE_KEY_ = 'DG_V6_PRED_ACCOUNTS';
const DG_SESSION_PREFIX_ = 'DGSESSION_';
const DG_SESSION_CACHE_PREFIX_ = 'DGSESS_';
// Session Timeout DIHAPUS TOTAL untuk SEMUA role (termasuk ADMIN) atas permintaan
// eksplisit: token sesi tidak boleh kedaluwarsa sendiri lagi, siapa pun akunnya.
// Kolom "Session Timeout" di Sheet Users tidak lagi dibaca untuk membatasi ini.
//
// SENGAJA DIBATASI 180 HARI (bukan literal "selamanya"/10 tahun seperti versi awal
// fix ini) supaya dgPruneExpiredSessions_ (pembersih harian) tetap bisa membuang
// catatan sesi yang sudah lama ditinggalkan. Token TIDAK PERNAH kedaluwarsa selama
// akunnya terus dipakai dalam 180 hari terakhir; hanya kalau akun benar-benar tidak
// pernah login lagi selama 180 hari catatannya baru dibuang. Tanpa batas ini,
// Script Properties (kuota total 500KB, dipakai bersama SELURUH data properti
// script) bisa penuh oleh tumpukan sesi lama yang tidak pernah dibersihkan -> begitu
// penuh, pembuatan sesi baru bisa gagal dan muncul sebagai galat mirip
// "session timeout" walau fix Session Timeout-nya sendiri sudah benar.
const DG_SESSION_NO_TIMEOUT_MINUTES_ = 60 * 24 * 180;
const DG_PBKDF2_ITERATIONS_ = 2000;
const DG_LINKTREE_LOGIN_URL_ = 'http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/index';
const DG_LINKTREE_POST_URL_ = 'http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/notif_send_post';
const DG_LINKTREE_API_KEY_ = 'bbd53ebb-ba2b-11ec-9377-f2937b475656';
function dgLinktreeLoginUrl_(){return dgProps_().getProperty('DG_LINKTREE_LOGIN_URL')||DG_LINKTREE_LOGIN_URL_;}
function dgLinktreePostUrl_(){return dgProps_().getProperty('DG_LINKTREE_POST_URL')||DG_LINKTREE_POST_URL_;}

function dgNowMs_(){ return Date.now(); }
function dgMs_(start){ return Math.max(0, Date.now() - Number(start || Date.now())); }
function dgCache_(){ return CacheService.getScriptCache(); }
function dgProps_(){ return PropertiesService.getScriptProperties(); }
function dgSignedByte_(n){ n = n & 255; return n > 127 ? n - 256 : n; }
function dgUnsignedByte_(n){ return Number(n) & 255; }
function dgUtf8Bytes_(text){ return Utilities.newBlob(String(text == null ? '' : text)).getBytes(); }
function dgInt32Bytes_(i){ return [dgSignedByte_(i>>>24),dgSignedByte_(i>>>16),dgSignedByte_(i>>>8),dgSignedByte_(i)]; }
function dgXorBytes_(a,b){ return a.map(function(v,i){ return dgSignedByte_(dgUnsignedByte_(v) ^ dgUnsignedByte_(b[i])); }); }
function dgHmacSha256_(keyBytes,dataBytes){ return Utilities.computeHmacSha256Signature(dataBytes,keyBytes); }
function dgConstEq_(a,b){ a=String(a||'');b=String(b||'');if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0; }
function dgCacheKey_(prefix, value){ return String(prefix||'DG_') + contentHash_(String(value||'')).substring(0,48); }

function dgPbkdf2Sha256_(password,salt,iterations){
  const key = dgUtf8Bytes_(password);
  const saltBytes = dgUtf8Bytes_(salt);
  let u = dgHmacSha256_(key, saltBytes.concat(dgInt32Bytes_(1)));
  let out = u.slice();
  for(let i=1;i<iterations;i++){
    u = dgHmacSha256_(key,u);
    out = dgXorBytes_(out,u);
  }
  return Utilities.base64EncodeWebSafe(out).replace(/=+$/,'');
}
function dgHashPassword_(password){
  const salt = Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'').substring(0,12);
  const hash = dgPbkdf2Sha256_(String(password||''), salt, DG_PBKDF2_ITERATIONS_);
  return 'pbkdf2-sha256$'+DG_PBKDF2_ITERATIONS_+'$'+salt+'$'+hash;
}
function dgVerifyPassword_(stored,password){
  stored = String(stored == null ? '' : stored);
  if(stored.indexOf('pbkdf2-sha256$') !== 0) return dgConstEq_(stored,String(password||''));
  const parts = stored.split('$');
  if(parts.length !== 4) return false;
  const iter = Math.max(1,Number(parts[1])||DG_PBKDF2_ITERATIONS_);
  const actual = dgPbkdf2Sha256_(String(password||''),parts[2],iter);
  return dgConstEq_(actual,parts[3]);
}
function dgPasswordIsHashed_(stored){ return String(stored||'').indexOf('pbkdf2-sha256$')===0; }

function invalidateUsersCache_(){ try{ dgCache_().remove(DG_USERS_CACHE_KEY_); }catch(e){} }
function buildUsersCacheV6_(){
  const sh = SpreadsheetApp.getActive().getSheetByName('Users');
  const output = {map:{}, headers:{}};
  if(!sh || sh.getLastRow()<2) return output;
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(function(x){return String(x||'').trim().toLowerCase();});
  const idx = function(){ for(let a=0;a<arguments.length;a++){const i=headers.indexOf(String(arguments[a]).toLowerCase());if(i>-1)return i;} return -1; };
  const c={
    user:idx('username'), pass:idx('password'), web:idx('website'), telegram:idx('telegram'), linktree:idx('linktree'), panelz:idx('panel-z','panelz'),
    role:idx('role'), status:idx('status akun','status'), name:idx('nama pengguna'), last:idx('terakhir login'), fail:idx('login gagal'), lock:idx('terkunci sampai'), timeout:idx('session timeout')
  };
  output.headers=c;
  for(let r=1;r<values.length;r++){
    const username=String(values[r][c.user]||'').trim(); if(!username) continue;
    const lockValue=c.lock>-1?values[r][c.lock]:null;
    output.map[username.toLowerCase()]={
      row:r+1,username:username,password:c.pass>-1?String(values[r][c.pass]||''):'',passwordCol:c.pass+1,
      websites:String(c.web>-1?values[r][c.web]||'':'').split(',').map(function(x){return x.trim();}).filter(Boolean),
      permissions:{telegram:c.telegram>-1&&values[r][c.telegram]===true,linktree:c.linktree>-1&&values[r][c.linktree]===true,panelz:c.panelz>-1&&values[r][c.panelz]===true},
      role:c.role>-1?String(values[r][c.role]||'OPERATOR').toUpperCase():'OPERATOR',
      status:c.status>-1?String(values[r][c.status]||'AKTIF').toUpperCase():'AKTIF',
      displayName:c.name>-1?String(values[r][c.name]||username):username,
      timeout:c.timeout>-1?Math.max(5,Number(values[r][c.timeout]||60)):60,
      lastCol:{last:c.last,fail:c.fail,lock:c.lock}, failed:c.fail>-1?Number(values[r][c.fail]||0):0,
      lockedUntilMs:lockValue instanceof Date?lockValue.getTime():(lockValue?new Date(lockValue).getTime():0)
    };
  }
  try{dgCache_().put(DG_USERS_CACHE_KEY_,JSON.stringify(output),DG_USERS_CACHE_SECONDS_);}catch(e){}
  return output;
}
function getUsersCacheV6_(){
  try{const raw=dgCache_().get(DG_USERS_CACHE_KEY_);if(raw)return JSON.parse(raw);}catch(e){}
  return buildUsersCacheV6_();
}
function getUserProfile_(username){
  const clean=String(username||'').trim().toLowerCase(); if(!clean)return null;
  const data=getUsersCacheV6_(); const p=data.map&&data.map[clean]; if(!p)return null;
  const clone=JSON.parse(JSON.stringify(p));
  clone.sheet=SpreadsheetApp.getActive().getSheetByName('Users');
  clone.lockedUntil=clone.lockedUntilMs?new Date(clone.lockedUntilMs):null;
  return clone;
}
function updateLastLogin_(p){ if(p&&p.sheet&&p.lastCol.last>-1){p.sheet.getRange(p.row,p.lastCol.last+1).setValue(new Date());invalidateUsersCache_();} }
function resetFailedLogin_(p){ if(!p||!p.sheet)return;if(p.lastCol.fail>-1)p.sheet.getRange(p.row,p.lastCol.fail+1).setValue(0);if(p.lastCol.lock>-1)p.sheet.getRange(p.row,p.lastCol.lock+1).clearContent();invalidateUsersCache_(); }
function registerFailedLogin_(p){ if(!p||!p.sheet)return;const n=(Number(p.failed)||0)+1;if(p.lastCol.fail>-1)p.sheet.getRange(p.row,p.lastCol.fail+1).setValue(n);if(n>=5&&p.lastCol.lock>-1)p.sheet.getRange(p.row,p.lastCol.lock+1).setValue(new Date(Date.now()+10*60000));invalidateUsersCache_(); }

function dgSessionCacheKey_(token){ return DG_SESSION_CACHE_PREFIX_ + contentHash_(String(token||'')).substring(0,40); }
function dgCreateSession_(profile){
  const token='dg_'+Utilities.getUuid().replace(/-/g,'')+contentHash_(profile.username+'|'+Date.now()+'|'+Math.random()).substring(0,24);
  // Session Timeout DIHAPUS TOTAL untuk semua role (termasuk ADMIN) atas permintaan
  // eksplisit: tidak boleh ada sesi yang kedaluwarsa sendiri lagi. Kolom "Session
  // Timeout" di Sheet Users dibiarkan ada (dipakai form admin lama) tapi TIDAK LAGI
  // dibaca di sini untuk siapa pun.
  const minutes = DG_SESSION_NO_TIMEOUT_MINUTES_;
  const record={username:profile.username,createdAt:Date.now(),expiresAt:Date.now()+minutes*60000};
  const raw=JSON.stringify(record);
  dgProps_().setProperty(DG_SESSION_PREFIX_+token,raw);
  try{dgCache_().put(dgSessionCacheKey_(token),raw,Math.min(minutes*60,21600));}catch(e){}
  return token;
}
function dgLoadSession_(token){
  token=String(token||'').trim(); if(token.indexOf('dg_')!==0)return null;
  let raw='';try{raw=dgCache_().get(dgSessionCacheKey_(token))||'';}catch(e){}
  if(!raw) raw=dgProps_().getProperty(DG_SESSION_PREFIX_+token)||'';
  if(!raw)return null;
  let rec;try{rec=JSON.parse(raw);}catch(e){return null;}
  if(!rec.expiresAt||Number(rec.expiresAt)<=Date.now()){dgProps_().deleteProperty(DG_SESSION_PREFIX_+token);try{dgCache_().remove(dgSessionCacheKey_(token));}catch(e){}return null;}
  return rec;
}
function dgDeleteSession_(token){ if(!token)return;dgProps_().deleteProperty(DG_SESSION_PREFIX_+token);try{dgCache_().remove(dgSessionCacheKey_(token));}catch(e){} }
function dgPruneExpiredSessions_(){
  const props=dgProps_(),today=Utilities.formatDate(new Date(),'GMT+7','yyyyMMdd'),marker='DG_SESSION_PRUNE_DATE';
  if(props.getProperty(marker)===today)return;
  const lock=LockService.getScriptLock();
  try{if(!lock.tryLock(1000))return;if(props.getProperty(marker)===today)return;const all=props.getProperties();Object.keys(all).forEach(function(k){if(k.indexOf(DG_SESSION_PREFIX_)!==0)return;try{const r=JSON.parse(all[k]);if(!r.expiresAt||Number(r.expiresAt)<=Date.now())props.deleteProperty(k);}catch(e){props.deleteProperty(k);}});props.setProperty(marker,today);}finally{try{lock.releaseLock();}catch(e){}}
}
function requireSession_(token,options){
  const rec=dgLoadSession_(token);if(!rec)throw new Error('Sesi tidak valid atau telah berakhir. Silakan login kembali.');
  const p=getUserProfile_(rec.username);if(!p)throw new Error('Akun tidak ditemukan.');
  if(p.status!=='AKTIF')throw new Error('Akun sedang '+String(p.status||'NONAKTIF').toLowerCase()+'.');
  if(p.lockedUntil&&p.lockedUntil.getTime()>Date.now())throw new Error('Akun terkunci sementara.');
  const maintenance=getMaintenanceSettings_();
  if(maintenance.enabled&&p.role!=='ADMIN'&&!(options&&options.ignoreMaintenance))throw new Error(maintenance.message);
  if(options&&options.admin&&p.role!=='ADMIN')throw new Error('Akses ditolak. Hanya ADMIN yang diizinkan.');
  return {token:String(token),username:p.username,profile:p,maintenance:maintenance};
}
function dgPublicProfile_(session, token){const p=session.profile;return {success:true,user:p.username,username:p.username,role:p.role,displayName:p.displayName,timeout:p.timeout,permissions:p.permissions,websites:p.websites,maintenance:session.maintenance,sessionToken:token||session.token,serverVersion:DG_V6_VERSION_};}

function checkLogin(username,password){
  const started=Date.now();const clean=String(username||'').trim();
  try{
    const p=getUserProfile_(clean);
    if(!p){logActivity_(clean||'UNKNOWN','LOGIN','Username tidak ditemukan','GAGAL','');return {success:false,message:'Username atau Password Salah!'};}
    if(p.status!=='AKTIF'){logActivity_(p.username,'LOGIN','Akun tidak aktif: '+p.status,'GAGAL','');return {success:false,message:'Akun sedang '+p.status.toLowerCase()+'. Hubungi admin.'};}
    if(p.lockedUntil&&p.lockedUntil.getTime()>Date.now())return {success:false,message:'Akun terkunci sementara. Coba lagi nanti.'};
    if(!dgVerifyPassword_(p.password,password)){registerFailedLogin_(p);logActivity_(p.username,'LOGIN','Password salah','GAGAL','');return {success:false,message:'Username atau Password Salah!'};}
    if(!dgPasswordIsHashed_(p.password)&&p.passwordCol>0){p.sheet.getRange(p.row,p.passwordCol).setValue(dgHashPassword_(password));invalidateUsersCache_();}
    resetFailedLogin_(p);updateLastLogin_(p);
    const refreshed=getUserProfile_(p.username)||p;const maintenance=getMaintenanceSettings_();
    // Mode maintenance TIDAK lagi menolak login non-admin. Member tetap masuk supaya
    // panel bisa menampilkan overlay maintenance otomatis; pengiriman tetap dikunci
    // di sisi server (requireSession_ / dgSmartSendEngine_).
    if(maintenance.enabled&&refreshed.role!=='ADMIN'){logActivity_(refreshed.username,'LOGIN','Login saat mode maintenance (pengiriman dikunci)','INFO',maintenance.message);}
    dgPruneExpiredSessions_();const token=dgCreateSession_(refreshed);logActivity_(refreshed.username,'LOGIN','Login berhasil ke Day-Group Panel','BERHASIL','Auth '+dgMs_(started)+' ms');
    return dgPublicProfile_({profile:refreshed,maintenance:maintenance,token:token},token);
  }catch(err){logActivity_(clean||'UNKNOWN','LOGIN','Kesalahan validasi login: '+err.message,'ERROR','');return {success:false,message:'Terjadi kesalahan saat login.'};}
}
function resumeSession(token){try{return dgPublicProfile_(requireSession_(token),String(token||''));}catch(e){return {success:false,message:e.message};}}

/**
 * BOOTSTRAP — satu round-trip untuk seluruh data awal panel.
 *
 * Dulu saat panel dibuka frontend memanggil server 3x berturut-turut:
 * resumeSession -> getDashboardData (ringkasan header) -> getDashboardData lagi
 * (dipanggil ulang oleh switchPage('home')). Tiap panggilan google.script.run
 * adalah 1 perjalanan HTTPS penuh ke server Google, jadi loading terasa lama.
 *
 * getBootstrapData menggabungkan semuanya menjadi 1 panggilan. Ini AMAN karena:
 *  - fungsi lama (resumeSession, getDashboardData, dst) tidak diubah sama sekali,
 *    jadi kalau ada pemanggil lain / deployment lama tetap jalan seperti biasa;
 *  - bagian dashboard dibungkus try/catch sendiri, kalau gagal panel tetap terbuka
 *    dan hanya ringkasan header yang kosong (frontend akan ambil ulang otomatis).
 */
function getBootstrapData(token){
  var session;
  try {
    // ignoreMaintenance: panel tetap terbuka untuk member saat maintenance supaya
    // overlay maintenance bisa tampil. Pengiriman tetap dikunci di endpoint kirim.
    session = requireSession_(token, { ignoreMaintenance: true });
  } catch (e) {
    return { success: false, message: (e && e.message) ? e.message : String(e) };
  }

  var out = {
    success: true,
    profile: dgPublicProfile_(session, String(token || '')),
    dashboard: null,
    errors: {}
  };

  try {
    out.dashboard = getDashboardDataInternal_(session.username, { page: 1, pageSize: 1 });
  } catch (e) {
    out.errors.dashboard = (e && e.message) ? e.message : String(e);
  }

  return out;
}

/**
 * getLivePanelData(token, opts) — endpoint RINGAN untuk auto-refresh "realtime" panel.
 *
 * Apps Script tidak bisa WebSocket/SSE, jadi frontend melakukan polling adaptif.
 * Supaya tetap kencang, semua yang perlu di-refresh digabung dalam SATU panggilan
 * google.script.run (1 round-trip), bukan 3 panggilan terpisah.
 *
 * AMAN & backward-compatible:
 *  - tidak mengubah satu pun fungsi lama;
 *  - tiap bagian dibungkus try/catch sendiri — kalau satu gagal, sisanya tetap terkirim;
 *  - kalau fungsi ini belum ter-deploy, frontend otomatis fallback ke fungsi lama.
 *
 * opts = {
 *   activity: <objek request seperti getActivityRequest, atau null bila tidak perlu>,
 *   sessions: <boolean, true = ikut kirim daftar sesi login aktif (admin saja)>
 * }
 */
function getLivePanelData(token, opts){
  var session;
  try { session = requireSession_(token, { ignoreMaintenance: true }); }
  catch (e) { return { success:false, message:(e && e.message) ? e.message : String(e) }; }

  opts = opts || {};
  var out = { success:true, ts:Date.now(), errors:{} };

  // Tumpang pada poll live yang sering ini untuk menuliskan antrean Activity Log
  // dari jalur kirim cepat (dgQueueActivity_). Murah & tidak menahan apa pun.
  try { dgFlushActivityQueue_(); } catch (e) {}

  // Status maintenance ikut setiap poll -> overlay member muncul/hilang otomatis
  // tanpa refresh. Diambil dari sesi (sudah dihitung requireSession_).
  out.maintenance = (session && session.maintenance) || getMaintenanceSettings_();

  // Activity Log halaman aktif — hanya bila diminta (user sedang di halaman Aktivitas/Admin).
  if (opts.activity) {
    try { out.activity = getDashboardDataInternal_(session.username, opts.activity); }
    catch (e) { out.errors.activity = (e && e.message) ? e.message : String(e); }
  }

  // Ringkasan header. Kalau Activity Log sudah diambil di atas, pakai stats-nya langsung
  // (dihitung dari data yang sama) supaya tidak perlu panggilan internal kedua.
  if (out.activity && out.activity.stats) {
    out.summary = { stats: out.activity.stats, role: out.activity.role || '' };
  } else {
    try {
      var head = getDashboardDataInternal_(session.username, { page:1, pageSize:1 });
      out.summary = { stats:(head && head.stats) || {}, role:(head && head.role) || '' };
    } catch (e) { out.errors.summary = (e && e.message) ? e.message : String(e); }
  }

  // Daftar sesi login aktif — admin saja, hanya bila diminta.
  if (opts.sessions) {
    try {
      var adminSession = requireSession_(token, { admin:true });
      out.sessions = adminListActiveSessionsInternal_(adminSession.username);
    } catch (e) { out.errors.sessions = (e && e.message) ? e.message : String(e); }
  }

  return out;
}

function logoutSession(token){const rec=dgLoadSession_(token);if(rec)logActivity_(rec.username,'LOGOUT','User keluar dari panel','BERHASIL','');dgDeleteSession_(token);return {success:true};}
function logClientActivity(token,action,detail,status,content){const s=requireSession_(token,{ignoreMaintenance:true});return logActivity_(s.username,action,detail,status,content);}
function getCurrentUserProfile(token){return dgPublicProfile_(requireSession_(token),String(token||''));}

// Non-blocking activity logging: logging must never hold up the send engine for 20s.
function logActivity_(username,action,detail,status,content){
  const lock=LockService.getDocumentLock();
  try{
    // Dulu nunggu sampai 3 detik kalau lock lagi dipakai proses lain (kirim Telegram,
    // simpan user, dsb) -- itu bikin panel kerasa lemot pas dipakai beberapa admin
    // bersamaan. Sekarang gagal cepat (800ms) dan cukup skip log daripada nge-block.
    if(!lock.tryLock(800))return false;
    const sheet=getOrCreateActivityLogSheet_();rolloverActivityLogIfNeeded_(sheet,false);
    const row=getFirstEmptyLogRow_(sheet);const t=Utilities.formatDate(new Date(),PREDICTION_TIMEZONE_||'GMT+7','dd/MM/yyyy HH:mm:ss');
    sheet.getRange(row,1,1,ACTIVITY_LOG_COLS).setValues([[
      activitySafeSheetText_(t),activitySafeSheetText_(String(username||'UNKNOWN').trim()||'UNKNOWN'),activitySafeSheetText_(String(action||'AKTIVITAS').trim()),activitySafeSheetText_(String(status||'INFO').trim().toUpperCase()),activitySafeSheetText_(String(detail||'').trim()),activitySafeSheetText_(String(content||''))
    ]]);
    ensureActivityLogSize_(sheet,row);return true;
  }catch(e){console.error('Activity log V6: '+e.message);return false;}finally{try{lock.releaseLock();}catch(e){}}
}

// ==========================================================
// ANTREAN LOG AKTIVITAS (untuk jalur kirim yang sensitif kecepatan).
// dgSmartSendEngine_ tidak lagi menulis Activity Log langsung (menahan ~0.3-0.8 dtk
// di akhir tiap posting). Baris di-antre di CacheService dan ditulis massal oleh
// dgFlushActivityQueue_ pada poll live berikutnya / trigger. Kalau cache sempat
// ke-evict sebelum flush, paling banter 1 baris log yang hilang -- dapat ditoleransi.
// ==========================================================
const DG_ACTIVITY_QUEUE_KEY_ = 'DG_ACT_QUEUE_V1';

function dgQueueActivity_(username,action,detail,status,content){
  try{
    const c=dgCache_();
    let arr=[];try{const raw=c.get(DG_ACTIVITY_QUEUE_KEY_);if(raw)arr=JSON.parse(raw)||[];}catch(e){arr=[];}
    arr.push({
      t:Utilities.formatDate(new Date(),PREDICTION_TIMEZONE_||'GMT+7','dd/MM/yyyy HH:mm:ss'),
      u:String(username||'UNKNOWN').trim()||'UNKNOWN',
      a:String(action||'AKTIVITAS').trim(),
      s:String(status||'INFO').trim().toUpperCase(),
      d:String(detail||'').trim(),
      c:String(content||'')
    });
    if(arr.length>40)arr=arr.slice(-40);
    c.put(DG_ACTIVITY_QUEUE_KEY_,JSON.stringify(arr),21600);
    return true;
  }catch(e){
    // Cache bermasalah -> jangan sampai log hilang, tulis sinkron seperti biasa.
    try{return logActivity_(username,action,detail,status,content);}catch(_){return false;}
  }
}

function dgFlushActivityQueue_(){
  let arr=[];
  try{
    const c=dgCache_();const raw=c.get(DG_ACTIVITY_QUEUE_KEY_);
    if(!raw)return 0;
    arr=JSON.parse(raw)||[];
    c.remove(DG_ACTIVITY_QUEUE_KEY_);
  }catch(e){return 0;}
  if(!arr.length)return 0;
  const lock=LockService.getDocumentLock();
  try{
    if(!lock.tryLock(2000)){
      // Lock lagi sibuk -> kembalikan antrean, coba lagi nanti.
      try{dgCache_().put(DG_ACTIVITY_QUEUE_KEY_,JSON.stringify(arr),21600);}catch(e){}
      return 0;
    }
    const sheet=getOrCreateActivityLogSheet_();rolloverActivityLogIfNeeded_(sheet,false);
    const row=getFirstEmptyLogRow_(sheet);
    const values=arr.map(function(e){return [
      activitySafeSheetText_(e.t),activitySafeSheetText_(e.u||'UNKNOWN'),activitySafeSheetText_(e.a||'AKTIVITAS'),
      activitySafeSheetText_((e.s||'INFO')),activitySafeSheetText_(e.d||''),activitySafeSheetText_(e.c||'')
    ];});
    ensureActivityLogSize_(sheet,row+values.length);
    sheet.getRange(row,1,values.length,ACTIVITY_LOG_COLS).setValues(values);
    return values.length;
  }catch(e){console.error('flush activity queue: '+e.message);return 0;}
  finally{try{lock.releaseLock();}catch(e){}}
}

function readSosmedAccountsFast_(){
  try{const raw=dgCache_().get(DG_SOSMED_CACHE_KEY_);if(raw)return JSON.parse(raw);}catch(e){}
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sosmed');const map={};if(!sheet||sheet.getLastRow()<2)return map;
  const values=sheet.getDataRange().getValues();
  for(let r=1;r<values.length;r++){
    const website=String(values[r][0]||'').trim().toUpperCase();if(!website)continue;
    map[website]={TELEGRAM:{TOKEN:values[r][1],CHAT_ID:values[r][2]},LINKTREE:{EMAIL:values[r][3],PASS:values[r][4]},PANELZ:{USERNAME:values[r][5],PASSWORD:values[r][6],USERNAME2:values[r][7],PASSWORD2:values[r][8],URL:values[r][9]}};
  }
  try{dgCache_().put(DG_SOSMED_CACHE_KEY_,JSON.stringify(map),DG_SOSMED_CACHE_SECONDS_);}catch(e){}
  return map;
}
function getAkunByWebsiteInternal_(websiteName){return readSosmedAccountsFast_()[String(websiteName||'').trim().toUpperCase()]||null;}
function readPredictionTelegramAccounts_(){
  try{const raw=dgCache_().get(DG_PREDICTION_ACCOUNTS_CACHE_KEY_);if(raw)return JSON.parse(raw);}catch(e){}
  const map=readPredictionTelegramAccountsSource_();try{dgCache_().put(DG_PREDICTION_ACCOUNTS_CACHE_KEY_,JSON.stringify(map),300);}catch(e){}return map;
}

function dgFetchAll_(requests){
  if(!requests.length)return [];
  try{return UrlFetchApp.fetchAll(requests).map(function(r){return {response:r,error:''};});}
  catch(batchError){
    return requests.map(function(req){try{const p={};Object.keys(req).forEach(function(k){if(k!=='url')p[k]=req[k];});return {response:UrlFetchApp.fetch(req.url,p),error:''};}catch(e){return {response:null,error:e.message||String(e)};}});
  }
}
function dgResponseCode_(item){try{return item&&item.response?Number(item.response.getResponseCode()):0;}catch(e){return 0;}}
function dgResponseText_(item){try{return item&&item.response?String(item.response.getContentText()||''):'';}catch(e){return '';} }
function dgExtractCookie_(response, nameRegex){
  if(!response)return '';
  const h=response.getAllHeaders();let cookies=h['Set-Cookie']||h['set-cookie'];if(!cookies)return '';if(!Array.isArray(cookies))cookies=[cookies];
  const pieces=cookies.map(function(c){return String(c).split(';')[0];});
  if(nameRegex){for(let i=0;i<pieces.length;i++)if(nameRegex.test(pieces[i]))return pieces[i];}
  return pieces.join('; ');
}
function dgTelegramJobs_(jobs){
  if(!jobs.length)return {};
  const req=jobs.map(function(j){return {url:'https://api.telegram.org/bot'+j.cfg.TOKEN+'/sendMessage',method:'post',payload:{chat_id:String(j.cfg.CHAT_ID).trim(),text:j.text},muteHttpExceptions:true};});
  const fetched=dgFetchAll_(req);const out={};
  jobs.forEach(function(j,i){const f=fetched[i];const code=dgResponseCode_(f);out[j.id]=f&&f.error?{status:'GAGAL',reason:'Tele Error: '+f.error}:code===200?{status:'BERHASIL',reason:'Terkirim'}:{status:'GAGAL',reason:'Tele Error HTTP '+code};});
  return out;
}

function dgLinktreeSessionKey_(website,cfg){return dgCacheKey_('DG_LT_SESS_',website+'|'+String(cfg.EMAIL||''));}
function dgLinktreeLoginRequest_(cfg){return {url:dgLinktreeLoginUrl_(),method:'post',payload:{email:cfg.EMAIL,password:cfg.PASS},muteHttpExceptions:true,followRedirects:false};}
function dgLinktreePostRequest_(cookie,title,body){return {url:dgLinktreePostUrl_(),method:'post',headers:{Cookie:cookie},payload:{apikey:DG_LINKTREE_API_KEY_,title:title,body:body},muteHttpExceptions:true,followRedirects:false};}
function dgLinktreeNeedsLogin_(f){const c=dgResponseCode_(f),b=dgResponseText_(f);return !f||!!f.error||c===401||c===403||b.indexOf('LinkTree System')>-1;}
function dgLinktreeLoginBatch_(jobs,sessions){
  const missing=jobs.filter(function(j){return !sessions[j.id];});if(!missing.length)return;
  const fetched=dgFetchAll_(missing.map(function(j){return dgLinktreeLoginRequest_(j.cfg);}));
  missing.forEach(function(j,i){const f=fetched[i];if(f&&f.response){const cookie=dgExtractCookie_(f.response);if(cookie){sessions[j.id]=cookie;try{dgCache_().put(dgLinktreeSessionKey_(j.website,j.cfg),cookie,900);}catch(e){}}}});
}
function dgLinktreeJobs_(jobs){
  const out={};if(!jobs.length)return out;const sessions={};
  jobs.forEach(function(j){try{sessions[j.id]=dgCache_().get(dgLinktreeSessionKey_(j.website,j.cfg))||'';}catch(e){sessions[j.id]='';}});
  dgLinktreeLoginBatch_(jobs,sessions);
  const ready=jobs.filter(function(j){if(!sessions[j.id]){out[j.id]={status:'GAGAL',reason:'LinkTree login gagal'};return false;}return true;});
  let fetched=dgFetchAll_(ready.map(function(j){return dgLinktreePostRequest_(sessions[j.id],j.title,j.body);}));
  const retry=[];
  ready.forEach(function(j,i){const f=fetched[i];if(dgLinktreeNeedsLogin_(f)){try{dgCache_().remove(dgLinktreeSessionKey_(j.website,j.cfg));}catch(e){}sessions[j.id]='';retry.push(j);}else{const c=dgResponseCode_(f);out[j.id]=(c===200||c===302)?{status:'BERHASIL',reason:'Terkirim'}:{status:'GAGAL',reason:'LinkTree HTTP '+c};}});
  if(retry.length){dgLinktreeLoginBatch_(retry,sessions);const retryReady=retry.filter(function(j){return !!sessions[j.id];});const retryFetched=dgFetchAll_(retryReady.map(function(j){return dgLinktreePostRequest_(sessions[j.id],j.title,j.body);}));retryReady.forEach(function(j,i){const f=retryFetched[i],c=dgResponseCode_(f);out[j.id]=(!dgLinktreeNeedsLogin_(f)&&(c===200||c===302))?{status:'BERHASIL',reason:'Terkirim setelah refresh session'}:{status:'GAGAL',reason:'LinkTree gagal setelah refresh session'};});retry.forEach(function(j){if(!out[j.id])out[j.id]={status:'GAGAL',reason:'LinkTree login ulang gagal'};});}
  return out;
}

function dgPanelSessionKey_(website,cfg){return dgCacheKey_('DG_PZ_SESS_',website+'|'+String(cfg.URL||'')+'|'+String(cfg.USERNAME||''));}
function dgPanelRowKey_(website,cfg,market){return dgCacheKey_('DG_PZ_ROW_',website+'|'+String(cfg.URL||'')+'|'+String(market||'').toUpperCase());}
function dgPanelBasicAuth_(cfg){return 'Basic '+Utilities.base64Encode(String(cfg.USERNAME||'')+':'+String(cfg.PASSWORD||''));}
function dgPanelLoginRequest_(cfg){const auth=dgPanelBasicAuth_(cfg);return {url:String(cfg.URL||'')+'/assets/sys-tmbet/authentication.php',method:'post',headers:{Authorization:auth},payload:{username:cfg.USERNAME2,password:cfg.PASSWORD2},muteHttpExceptions:true,followRedirects:false};}
function dgPanelLoginBatch_(jobs,sessions){
  const missing=jobs.filter(function(j){return !sessions[j.id];});if(!missing.length)return;
  const fetched=dgFetchAll_(missing.map(function(j){return dgPanelLoginRequest_(j.cfg);}));
  missing.forEach(function(j,i){const f=fetched[i];if(!f||!f.response)return;const cookie=dgExtractCookie_(f.response,/PHPSESSID=/i);if(!cookie)return;const session={basicAuth:dgPanelBasicAuth_(j.cfg),cookie:cookie};sessions[j.id]=session;try{dgCache_().put(dgPanelSessionKey_(j.website,j.cfg),JSON.stringify(session),900);}catch(e){}});
}
function dgPanelParseRow_(html,market){const key=convertMarketToPanel_(String(market||'').toUpperCase());if(!key)return '';const m=String(html||'').match(new RegExp(key+'[\\s\\S]{0,500}?update-resultlotto\\.php\\?row=(\\d+)','i'));return m?m[1]:'';}
function dgPanelNeedsAuth_(f){const c=dgResponseCode_(f),b=dgResponseText_(f).toLowerCase();return !f||!!f.error||c===401||c===403||b.indexOf('authentication.php')>-1||b.indexOf('php session')>-1;}
function dgPanelJobs_(jobs){
  const out={};if(!jobs.length)return out;const sessions={},rows={};
  jobs.forEach(function(j){try{const raw=dgCache_().get(dgPanelSessionKey_(j.website,j.cfg));sessions[j.id]=raw?JSON.parse(raw):null;}catch(e){sessions[j.id]=null;}try{rows[j.id]=dgCache_().get(dgPanelRowKey_(j.website,j.cfg,j.market))||'';}catch(e){rows[j.id]='';}});
  dgPanelLoginBatch_(jobs,sessions);
  const needRows=jobs.filter(function(j){if(!sessions[j.id]){out[j.id]={status:'GAGAL',reason:'Panel-Z login gagal'};return false;}return !rows[j.id];});
  const dash=dgFetchAll_(needRows.map(function(j){return {url:String(j.cfg.URL||'')+'/dashboard.php?hal=result',headers:{Authorization:sessions[j.id].basicAuth,Cookie:sessions[j.id].cookie},muteHttpExceptions:true};}));
  needRows.forEach(function(j,i){const f=dash[i];if(dgPanelNeedsAuth_(f)){out[j.id]={status:'GAGAL',reason:'Panel-Z session gagal saat membaca dashboard'};return;}const row=dgPanelParseRow_(dgResponseText_(f),j.market);if(row){rows[j.id]=row;try{dgCache_().put(dgPanelRowKey_(j.website,j.cfg,j.market),String(row),21600);}catch(e){}}else out[j.id]={status:'GAGAL',reason:'Row tidak ditemukan: '+j.market};});
  const ready=jobs.filter(function(j){return !out[j.id]&&sessions[j.id]&&rows[j.id];});
  const updates=dgFetchAll_(ready.map(function(j){return {url:String(j.cfg.URL||'')+'/config/update-resultlotto.php?row='+rows[j.id],method:'post',headers:{Authorization:sessions[j.id].basicAuth,Cookie:sessions[j.id].cookie},payload:{updangka:j.prize1},muteHttpExceptions:true,followRedirects:false};}));
  const authRetry=[];
  ready.forEach(function(j,i){const f=updates[i],c=dgResponseCode_(f);if(dgPanelNeedsAuth_(f)){try{dgCache_().remove(dgPanelSessionKey_(j.website,j.cfg));}catch(e){}sessions[j.id]=null;authRetry.push(j);}else out[j.id]=(c===200||c===302)?{status:'BERHASIL',reason:'Terkirim'}:{status:'GAGAL',reason:'Panel-Z HTTP '+c};});
  if(authRetry.length){dgPanelLoginBatch_(authRetry,sessions);const rr=authRetry.filter(function(j){return !!sessions[j.id]&&!!rows[j.id];});const rf=dgFetchAll_(rr.map(function(j){return {url:String(j.cfg.URL||'')+'/config/update-resultlotto.php?row='+rows[j.id],method:'post',headers:{Authorization:sessions[j.id].basicAuth,Cookie:sessions[j.id].cookie},payload:{updangka:j.prize1},muteHttpExceptions:true,followRedirects:false};}));rr.forEach(function(j,i){const f=rf[i],c=dgResponseCode_(f);out[j.id]=(!dgPanelNeedsAuth_(f)&&(c===200||c===302))?{status:'BERHASIL',reason:'Terkirim setelah refresh session'}:{status:'GAGAL',reason:'Panel-Z gagal setelah refresh session'};});authRetry.forEach(function(j){if(!out[j.id])out[j.id]={status:'GAGAL',reason:'Panel-Z login ulang gagal'};});}
  return out;
}

function dgSentHashCacheKey_(hash){return 'DG_SENT_HASH_'+String(hash||'').substring(0,48);}
function dgRowsToGroups_(rows){rows=Array.from(new Set(rows.map(Number))).sort(function(a,b){return a-b;});const groups=[];let g=null;rows.forEach(function(r){if(!g||r!==g.end+1){g={start:r,end:r};groups.push(g);}else g.end=r;});return groups;}
function readSentRegistryForHashFast_(sheet,hash,force){
  const cacheKey=dgSentHashCacheKey_(hash);if(!force){try{const raw=dgCache_().get(cacheKey);if(raw)return JSON.parse(raw);}catch(e){}}
  const map={};const last=sheet.getLastRow();if(last<2)return map;
  let matches=[];try{matches=sheet.getRange(2,1,last-1,1).createTextFinder(String(hash)).matchEntireCell(true).findAll();}catch(e){}
  const rows=matches.map(function(r){return r.getRow();});
  dgRowsToGroups_(rows).forEach(function(g){const vals=sheet.getRange(g.start,1,g.end-g.start+1,9).getValues();vals.forEach(function(row,i){if(String(row[0]||'')!==String(hash))return;const site=String(row[3]||'').trim().toUpperCase();if(!site||site==='LEGACY')return;const rawDate=row[1];map[site]={row:g.start+i,hash:String(row[0]||''),username:String(row[2]||''),website:site,market:String(row[4]||''),telegram:row[5]===true||String(row[5]).toUpperCase()==='TRUE',linktree:row[6]===true||String(row[6]).toUpperCase()==='TRUE',panelz:row[7]===true||String(row[7]).toUpperCase()==='TRUE',dateText:rawDate instanceof Date?Utilities.formatDate(rawDate,'GMT+7','dd/MM/yyyy HH:mm:ss'):String(rawDate||'')};});});
  try{dgCache_().put(cacheKey,JSON.stringify(map),120);}catch(e){}return map;
}
function writeSentRegistryBatchV6_(sheet,changes,hash){
  if(!changes||!changes.length)return;
  const updates=changes.filter(function(x){return Number(x.row)>0;}).sort(function(a,b){return a.row-b.row;});
  const inserts=changes.filter(function(x){return !Number(x.row);});
  const updateByRow={};updates.forEach(function(x){updateByRow[x.row]=x.values;});
  dgRowsToGroups_(updates.map(function(x){return x.row;})).forEach(function(g){const vals=[];for(let r=g.start;r<=g.end;r++)vals.push(updateByRow[r]);sheet.getRange(g.start,1,vals.length,9).setValues(vals);});
  if(inserts.length){const start=sheet.getLastRow()+1;sheet.getRange(start,1,inserts.length,9).setValues(inserts.map(function(x){return x.values;}));sheet.getRange(start,2,inserts.length,1).setNumberFormat('dd/MM/yyyy HH:mm:ss');}
  try{dgCache_().remove(dgSentHashCacheKey_(hash));}catch(e){}
}
function getRegistryEntry_(website,content){const sh=getSentRegistryFast_();const hash=contentHash_(dgCanonicalResultKey_(content));const map=readSentRegistryForHashFast_(sh,hash,false);const e=map[String(website||'').trim().toUpperCase()]||null;if(!e)return null;return {row:e.row,date:e.dateText,username:e.username,website:e.website,market:e.market,telegram:e.telegram,linktree:e.linktree,panelz:e.panelz};}
function getWebsiteDeliveryStatus_(profile,content){const sh=getSentRegistryFast_(),hash=contentHash_(dgCanonicalResultKey_(content)),map=readSentRegistryForHashFast_(sh,hash,false);return (profile.websites||[]).map(function(website){const e=map[String(website||'').trim().toUpperCase()]||null;const systems={telegram:{allowed:!!profile.permissions.telegram,sent:!!(e&&e.telegram)},linktree:{allowed:!!profile.permissions.linktree,sent:!!(e&&e.linktree)},panelz:{allowed:!!profile.permissions.panelz,sent:!!(e&&e.panelz)}};const hasPending=Object.keys(systems).some(function(k){return systems[k].allowed&&!systems[k].sent;});return {website:website,systems:systems,hasPending:hasPending,last:e?{date:e.dateText,username:e.username}:null};});}

function dgSendLockKey_(hash,website,system){return dgCacheKey_('DG_SEND_LOCK_',hash+'|'+website+'|'+system);}
function dgBuildLinktreeContent_(processed){const market=processed.market&&processed.market!=='UNKNOWN'?processed.market:'LAOS SIANG';let body='🅿️1️⃣ : '+(processed.prize1||'8145');if(processed.prize2)body+='  🅿️2️⃣ : '+processed.prize2;if(processed.prize3)body+='  🅿️3️⃣ : '+processed.prize3;return {title:'Hasil Pengeluaran Pasaran '+market,body:body};}
function dgEmptyWebsiteResult_(website){return {website:website,telegram:{status:'SKIP',reason:'Tidak diproses'},linktree:{status:'SKIP',reason:'Tidak diproses'},panelz:{status:'SKIP',reason:'Tidak diproses'}};}

// FAST LANE pengiriman: kalau SEMUA sesi LinkTree & Panel-Z (plus row Panel-Z) sudah
// hangat di cache, kirim KETIGA kanal (Telegram + LinkTree post + Panel-Z update)
// dalam SATU UrlFetchApp.fetchAll paralel -- bukan 3 blok berurutan. Ini memangkas
// ~2 detik dari tiap posting. Kalau ada sesi yang basi saat dikirim, kanal itu
// otomatis dilempar balik ke runner bertahap (dgLinktreeJobs_/dgPanelJobs_).
// Return: { used:boolean } -- kalau false, pemanggil pakai jalur bertahap biasa.
function dgWarmCombinedSend_(jobs, results) {
  if (!jobs.linktree.length && !jobs.panelz.length) return { used: false };

  const ltCookie = {}, pzSess = {}, pzRow = {};
  let allWarm = true;

  jobs.linktree.forEach(function (j) {
    let c = '';
    try { c = dgCache_().get(dgLinktreeSessionKey_(j.website, j.cfg)) || ''; } catch (e) {}
    if (!c) allWarm = false;
    ltCookie[j.id] = c;
  });
  const pzValid = jobs.panelz.filter(function (j) {
    if (!j.market || j.market === 'UNKNOWN' || !j.prize1) {
      results[j.website].panelz = { status: 'GAGAL', reason: 'Pasaran atau Prize 1 tidak ditemukan' };
      return false;
    }
    return true;
  });
  pzValid.forEach(function (j) {
    let s = null, r = '';
    try { const raw = dgCache_().get(dgPanelSessionKey_(j.website, j.cfg)); s = raw ? JSON.parse(raw) : null; } catch (e) {}
    try { r = dgCache_().get(dgPanelRowKey_(j.website, j.cfg, j.market)) || ''; } catch (e) {}
    if (!s || !r) allWarm = false;
    pzSess[j.id] = s; pzRow[j.id] = r;
  });

  if (!allWarm) return { used: false };

  const requests = [], meta = [];
  jobs.telegram.forEach(function (j) {
    requests.push({ url: 'https://api.telegram.org/bot' + j.cfg.TOKEN + '/sendMessage', method: 'post', payload: { chat_id: String(j.cfg.CHAT_ID).trim(), text: j.text }, muteHttpExceptions: true });
    meta.push({ kind: 'telegram', j: j });
  });
  jobs.linktree.forEach(function (j) {
    requests.push(dgLinktreePostRequest_(ltCookie[j.id], j.title, j.body));
    meta.push({ kind: 'linktree', j: j });
  });
  pzValid.forEach(function (j) {
    requests.push({ url: String(j.cfg.URL || '') + '/config/update-resultlotto.php?row=' + pzRow[j.id], method: 'post', headers: { Authorization: pzSess[j.id].basicAuth, Cookie: pzSess[j.id].cookie }, payload: { updangka: j.prize1 }, muteHttpExceptions: true, followRedirects: false });
    meta.push({ kind: 'panelz', j: j });
  });

  const fetched = dgFetchAll_(requests);
  const staleLt = [], stalePz = [];

  fetched.forEach(function (f, i) {
    const kind = meta[i].kind, j = meta[i].j, code = dgResponseCode_(f);
    if (kind === 'telegram') {
      results[j.website].telegram = (f && f.error)
        ? { status: 'GAGAL', reason: 'Tele Error: ' + f.error }
        : code === 200 ? { status: 'BERHASIL', reason: 'Terkirim' } : { status: 'GAGAL', reason: 'Tele Error HTTP ' + code };
    } else if (kind === 'linktree') {
      if (dgLinktreeNeedsLogin_(f)) {
        try { dgCache_().remove(dgLinktreeSessionKey_(j.website, j.cfg)); } catch (e) {}
        staleLt.push(j);
      } else {
        results[j.website].linktree = (code === 200 || code === 302)
          ? { status: 'BERHASIL', reason: 'Terkirim' } : { status: 'GAGAL', reason: 'LinkTree HTTP ' + code };
      }
    } else {
      if (dgPanelNeedsAuth_(f)) {
        try { dgCache_().remove(dgPanelSessionKey_(j.website, j.cfg)); } catch (e) {}
        stalePz.push(j);
      } else {
        results[j.website].panelz = (code === 200 || code === 302)
          ? { status: 'BERHASIL', reason: 'Terkirim' } : { status: 'GAGAL', reason: 'Panel-Z HTTP ' + code };
      }
    }
  });

  // Sesi yang ternyata basi -> lempar ke runner bertahap (login ulang + kirim).
  if (staleLt.length) {
    const r = dgLinktreeJobs_(staleLt);
    staleLt.forEach(function (j) { results[j.website].linktree = r[j.id] || { status: 'GAGAL', reason: 'LinkTree gagal' }; });
  }
  if (stalePz.length) {
    const r = dgPanelJobs_(stalePz);
    stalePz.forEach(function (j) { results[j.website].panelz = r[j.id] || { status: 'GAGAL', reason: 'Panel-Z gagal' }; });
  }

  return { used: true };
}

function dgSmartSendEngine_(rawText,token,options){
  options=options||{};const totalStart=Date.now(),perf={};let t=Date.now();const session=requireSession_(token);perf.authMs=dgMs_(t);const p=session.profile;
  t=Date.now();const processed=processText_(rawText);const textToSend=options.rawContent?String(rawText||'').trim():(processed.output||String(rawText||'').trim());perf.parseMs=dgMs_(t);
  if(!textToSend)return {success:false,blocked:true,message:'Isi data kosong.',websiteResults:[],performance:{totalMs:dgMs_(totalStart)}};
  const targetList=Array.isArray(options.targets)?options.targets.map(function(x){return String(x).toLowerCase();}):['telegram','linktree','panelz'];const requested={telegram:targetList.indexOf('telegram')>-1,linktree:targetList.indexOf('linktree')>-1,panelz:targetList.indexOf('panelz')>-1};
  const allowedSet=new Set((p.websites||[]).map(function(x){return String(x||'').trim().toUpperCase();}).filter(Boolean));const requestedSites=Array.isArray(options.onlyWebsites)&&options.onlyWebsites.length?new Set(options.onlyWebsites.map(function(x){return String(x||'').trim().toUpperCase();})):allowedSet;const websites=Array.from(allowedSet).filter(function(x){return requestedSites.has(x);});
  if(!websites.length)return {success:false,blocked:true,message:'Tidak ada website yang dapat diproses untuk akun ini.',websiteResults:[],performance:{totalMs:dgMs_(totalStart)}};
  t=Date.now();const accounts=readSosmedAccountsFast_();const registrySheet=getSentRegistryFast_();const hash=contentHash_(dgCanonicalResultKey_(textToSend,processed));perf.configMs=dgMs_(t);
  const results={},jobs={telegram:[],linktree:[],panelz:[]},lockKeys=[],requestId=Utilities.getUuid(),scriptLock=LockService.getScriptLock();
  websites.forEach(function(w){results[w]=dgEmptyWebsiteResult_(w);});
  t=Date.now();
  try{
    scriptLock.waitLock(10000);const previousMap=readSentRegistryForHashFast_(registrySheet,hash,true);
    websites.forEach(function(website){const prev=previousMap[website]||null,acc=accounts[website]||null;['telegram','linktree','panelz'].forEach(function(system){if(!requested[system])return;if(!p.permissions[system]){results[website][system]={status:'DIBLOKIR',reason:'Tidak diizinkan pada Sheet Users'};return;}if(!options.forceDuplicate&&prev&&prev[system]){results[website][system]={status:'SUDAH DIKIRIM',reason:'Pernah dikirim oleh '+(prev.username||'user sebelumnya')+' pada '+(prev.dateText||'waktu tidak tercatat')};return;}if(!acc){results[website][system]={status:'GAGAL',reason:'Konfigurasi website '+website+' tidak ditemukan'};return;}const lk=dgSendLockKey_(hash,website,system);let active='';try{active=dgCache_().get(lk)||'';}catch(e){}if(active){results[website][system]={status:'SEDANG DIPROSES',reason:'Sedang diproses oleh permintaan lain'};return;}try{dgCache_().put(lk,requestId,120);}catch(e){}lockKeys.push(lk);const id=website+'|'+system;const base={id:id,website:website,text:textToSend,processed:processed};if(system==='telegram'){base.cfg=acc.TELEGRAM;jobs.telegram.push(base);}else if(system==='linktree'){base.cfg=acc.LINKTREE;const c=dgBuildLinktreeContent_(processed);base.title=c.title;base.body=c.body;jobs.linktree.push(base);}else{base.cfg=acc.PANELZ;base.market=processed.market;base.prize1=processed.prize1;jobs.panelz.push(base);}});});
  }finally{try{scriptLock.releaseLock();}catch(e){}}
  perf.reserveMs=dgMs_(t);
  // FAST LANE: bila semua sesi LinkTree & Panel-Z sudah hangat, kirim 3 kanal
  // dalam 1 fetchAll paralel. Kalau tidak, pakai jalur bertahap (3 blok berurutan).
  t=Date.now();const warm=dgWarmCombinedSend_(jobs,results);
  if(warm.used){
    perf.telegramMs=0;perf.linktreeMs=0;perf.panelzMs=0;perf.combinedMs=dgMs_(t);perf.warmLane=true;
  }else{
    perf.combinedMs=0;perf.warmLane=false;
    if(jobs.telegram.length){t=Date.now();const r=dgTelegramJobs_(jobs.telegram);jobs.telegram.forEach(function(j){results[j.website].telegram=r[j.id]||{status:'GAGAL',reason:'Tidak ada respons Telegram'};});perf.telegramMs=dgMs_(t);}else perf.telegramMs=0;
    if(jobs.linktree.length){t=Date.now();const r=dgLinktreeJobs_(jobs.linktree);jobs.linktree.forEach(function(j){results[j.website].linktree=r[j.id]||{status:'GAGAL',reason:'Tidak ada respons LinkTree'};});perf.linktreeMs=dgMs_(t);}else perf.linktreeMs=0;
    if(jobs.panelz.length){t=Date.now();const valid=jobs.panelz.filter(function(j){if(!j.market||j.market==='UNKNOWN'||!j.prize1){results[j.website].panelz={status:'GAGAL',reason:'Pasaran atau Prize 1 tidak ditemukan'};return false;}return true;});const r=dgPanelJobs_(valid);valid.forEach(function(j){results[j.website].panelz=r[j.id]||{status:'GAGAL',reason:'Tidak ada respons Panel-Z'};});perf.panelzMs=dgMs_(t);}else perf.panelzMs=0;
  }
  t=Date.now();
  try{
    scriptLock.waitLock(10000);const fresh=readSentRegistryForHashFast_(registrySheet,hash,true),changes=[];
    websites.forEach(function(website){const old=fresh[website]||null;const merged={telegram:!!(old&&old.telegram)||results[website].telegram.status==='BERHASIL',linktree:!!(old&&old.linktree)||results[website].linktree.status==='BERHASIL',panelz:!!(old&&old.panelz)||results[website].panelz.status==='BERHASIL'};if(merged.telegram||merged.linktree||merged.panelz)changes.push({row:old?old.row:0,values:[hash,new Date(),p.username,website,processed.market||'-',merged.telegram,merged.linktree,merged.panelz,textToSend]});});writeSentRegistryBatchV6_(registrySheet,changes,hash);try{dgCache_().removeAll(lockKeys);}catch(e){lockKeys.forEach(function(k){try{dgCache_().remove(k);}catch(_){};});}
  }finally{try{scriptLock.releaseLock();}catch(e){}}
  perf.registryWriteMs=dgMs_(t);
  const websiteResults=websites.map(function(w){return results[w];});const counters={success:0,failed:0,blocked:0,already:0,processing:0,skipped:0};websiteResults.forEach(function(w){['telegram','linktree','panelz'].forEach(function(k){const s=String(w[k].status||'SKIP').toUpperCase();if(s==='BERHASIL')counters.success++;else if(s==='GAGAL')counters.failed++;else if(s==='DIBLOKIR')counters.blocked++;else if(s==='SUDAH DIKIRIM')counters.already++;else if(s==='SEDANG DIPROSES')counters.processing++;else counters.skipped++;});});
  const allDuplicate=counters.success===0&&counters.failed===0&&counters.already>0&&counters.processing===0;const logStatus=counters.failed>0&&counters.success===0?'GAGAL':counters.failed>0?'SEBAGIAN':counters.success>0?'BERHASIL':allDuplicate?'DIBLOKIR':'INFO';const detail=websiteResults.map(function(w){return '['+w.website+'] TG:'+w.telegram.status+' | LT:'+w.linktree.status+' | PZ:'+w.panelz.status;}).join(' || ');
  // Log Activity di-ANTRE (bukan tulis sinkron) supaya tidak menahan respons ke user.
  // Ditulis massal oleh dgFlushActivityQueue_ pada poll live / trigger berikutnya.
  t=Date.now();dgQueueActivity_(p.username,allDuplicate?'DUPLIKAT WEBSITE DIBLOKIR':'FAST AUTO SEND V6',detail,logStatus,textToSend);perf.logMs=dgMs_(t);perf.totalMs=dgMs_(totalStart);
  return {success:counters.failed===0&&counters.success>0,partial:counters.success>0&&counters.failed>0,allAlready:allDuplicate,blocked:counters.success===0&&counters.failed===0,message:allDuplicate?'Semua website yang diizinkan sudah pernah menerima data ini.':'Proses selesai.',websiteResults:websiteResults,counters:counters,content:textToSend,market:processed.market||'-',durationMs:perf.totalMs,performance:perf,serverVersion:DG_V6_VERSION_};
}

function smartAutoSendFast(rawText,token){return dgSmartSendEngine_(rawText,token,{});}
function sendAllSystems(rawText,token,isPrediksiAuto){return dgSmartSendEngine_(rawText,token,{rawContent:!!isPrediksiAuto});}
function sendSelectedSystems(rawText,token,targets,forceDuplicate,isPrediksiAuto,onlyWebsites){return dgSmartSendEngine_(rawText,token,{targets:targets,forceDuplicate:!!forceDuplicate,rawContent:!!isPrediksiAuto,onlyWebsites:onlyWebsites});}
function retryFailedSystem(rawText,token,systemName,websiteName){return dgSmartSendEngine_(rawText,token,{targets:[String(systemName||'').toLowerCase()],forceDuplicate:true,onlyWebsites:websiteName?[websiteName]:null});}
function getSendPreview(rawText,token){const s=requireSession_(token);return getSendPreviewInternal_(rawText,s.username);}

function sendToPanelZOnly(market,angka,token){
  const start=Date.now(),s=requireSession_(token),p=s.profile;if(!p.permissions.panelz)throw new Error('Akses Panel-Z tidak diizinkan untuk akun ini.');
  const accounts=readSosmedAccountsFast_(),sites=Array.from(new Set((p.websites||[]).map(function(x){return String(x||'').trim().toUpperCase();}).filter(Boolean)));const jobs=[],siteResults=[];
  sites.forEach(function(w){const acc=accounts[w];if(!acc){siteResults.push({website:w,status:'GAGAL',reason:'Konfigurasi website tidak ditemukan'});return;}jobs.push({id:w+'|panelz-custom',website:w,cfg:acc.PANELZ,market:String(market||'').trim().toUpperCase(),prize1:String(angka||'').trim()});});
  const sent=dgPanelJobs_(jobs);jobs.forEach(function(j){const r=sent[j.id]||{status:'GAGAL',reason:'Tidak ada respons'};siteResults.push({website:j.website,status:r.status,reason:r.reason});});const ok=siteResults.filter(function(x){return x.status==='BERHASIL';}).length;const failed=siteResults.length-ok;logActivity_(p.username,'SEND PANEL-Z',`Pasaran: ${market} | ${ok} berhasil | ${failed} gagal`,failed&&ok?'SEBAGIAN':failed?'GAGAL':'BERHASIL',`Angka yang dikirim: ${angka}`);return {success:ok>0&&failed===0,partial:ok>0&&failed>0,message:ok+' website berhasil, '+failed+' gagal',websiteResults:siteResults,durationMs:dgMs_(start),performance:{panelzMs:dgMs_(start),totalMs:dgMs_(start)}};
}

// Secure wrappers around legacy username-based readers/admin actions.
function getPredictionStatusData(token){const s=requireSession_(token,{ignoreMaintenance:true});return getPredictionStatusDataInternal_(s.username);}
function generatePredictionCopyBundle(index,token){const s=requireSession_(token);return generatePredictionCopyBundleInternal_(index,s.username);}
function generateClosingPredictionCopy(token,slot){const s=requireSession_(token);return generateClosingPredictionCopyInternal_(s.username,slot);}
function triggerManualPrediction(index,token){const s=requireSession_(token);return sendPredictionAutoInternal_(index,s.username);}
function generateSinglePrediction(index,token){const s=requireSession_(token);return generatePredictionCopyBundleInternal_(index,s.username);}
function prosesAutoPostByJadwal(targetJam,token){const s=requireSession_(token);const index=JADWAL_PREDIKSI_CONFIG.findIndex(function(x){return x.jam===targetJam;});if(index<0)return {success:false,message:'Jadwal untuk jam '+targetJam+' tidak ditemukan.'};return sendPredictionAutoInternal_(index,s.username);}
function setupAutoPostTriggers(token){requireSession_(token,{admin:true});return setupAutoPostTriggersInternal_();}
function repairPredictionRegistryV4(token){requireSession_(token,{admin:true});return repairPredictionRegistryV4Internal_();}
function rapikanSemuaActivityLog(token){requireSession_(token,{admin:true});return rapikanSemuaActivityLogInternal_();}
function repairActivityLogTextErrors(token){const s=requireSession_(token,{admin:true});return repairActivityLogTextErrorsInternal_(s.username);}
function setupActivityBackupTrigger(token){const s=requireSession_(token,{admin:true});return setupActivityBackupTriggerInternal_(s.username);}
function adminRunActivityBackup(token){const s=requireSession_(token,{admin:true});return adminRunActivityBackupInternal_(s.username);}
function getDashboardData(token,request){const s=requireSession_(token,{ignoreMaintenance:true});return getDashboardDataInternal_(s.username,request);}
function adminListUsers(token){const s=requireSession_(token,{admin:true});return adminListUsersInternal_(s.username);}
function adminSaveUser(token,data){const s=requireSession_(token,{admin:true});const safe=Object.assign({},data||{});if(String(safe.password||'')!=='')safe.password=dgHashPassword_(String(safe.password));const r=adminSaveUserInternal_(s.username,safe);invalidateUsersCache_();return r;}
function adminDeleteUser(token,targetUsername){const s=requireSession_(token,{admin:true});const r=adminDeleteUserInternal_(s.username,targetUsername);invalidateUsersCache_();return r;}
function adminResetUserLock(token,targetUsername){const s=requireSession_(token,{admin:true});const r=adminResetUserLockInternal_(s.username,targetUsername);invalidateUsersCache_();return r;}
function setMaintenance(token,enabled,message){const s=requireSession_(token,{admin:true});const r=setMaintenanceInternal_(s.username,enabled,message);try{dgCache_().remove('DG_V6_MAINT');}catch(e){}return r;}

// ==========================================================
// ADMIN — DAFTAR SESI LOGIN AKTIF
// Membaca semua record sesi di Script Properties, membuang yang kedaluwarsa,
// lalu mengelompokkan per user. Dipakai admin untuk melihat siapa yang sedang
// login (dan karena itu website-nya ikut auto posting prediksi).
// ==========================================================
function adminListActiveSessionsInternal_(adminUsername) {
  requireAdmin_(adminUsername);

  const all = dgProps_().getProperties();
  const now = Date.now();
  const byUser = {};

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(DG_SESSION_PREFIX_) !== 0) return;
    let rec;
    try { rec = JSON.parse(all[key]); } catch (e) { return; }
    if (!rec || !rec.username) return;
    if (!rec.expiresAt || Number(rec.expiresAt) <= now) return;

    const uKey = String(rec.username).toLowerCase();
    if (!byUser[uKey]) {
      byUser[uKey] = { username: rec.username, sessions: 0, firstLoginMs: 0, lastExpiresMs: 0 };
    }
    byUser[uKey].sessions++;
    const created = Number(rec.createdAt || 0);
    if (created && (!byUser[uKey].firstLoginMs || created < byUser[uKey].firstLoginMs)) {
      byUser[uKey].firstLoginMs = created;
    }
    if (Number(rec.expiresAt) > byUser[uKey].lastExpiresMs) {
      byUser[uKey].lastExpiresMs = Number(rec.expiresAt);
    }
  });

  const usersCache = getUsersCacheV6_();
  const fmt = function (ms) {
    return ms ? Utilities.formatDate(new Date(ms), PREDICTION_TIMEZONE_, "dd/MM/yyyy HH:mm:ss") : "-";
  };

  const list = Object.keys(byUser).map(function (uKey) {
    const item = byUser[uKey];
    const profile = usersCache.map && usersCache.map[uKey];
    const websites = profile ? (profile.websites || []) : [];
    const telegramOn = !!(profile && profile.permissions && profile.permissions.telegram);
    return {
      username: item.username,
      displayName: profile ? profile.displayName : item.username,
      role: profile ? profile.role : "-",
      websites: websites.join(", "),
      telegram: telegramOn,
      sessions: item.sessions,
      loginAt: fmt(item.firstLoginMs),
      expiresAt: fmt(item.lastExpiresMs),
      autoPostEligible: telegramOn && websites.length > 0
    };
  }).sort(function (a, b) {
    return a.username.toLowerCase() < b.username.toLowerCase() ? -1 : 1;
  });

  return {
    success: true,
    generatedAt: fmt(now),
    autoPostEnabled: isAutoPostEnabled_(),
    totalUsers: list.length,
    totalSessions: list.reduce(function (sum, x) { return sum + x.sessions; }, 0),
    sessions: list
  };
}
function adminListActiveSessions(token){const s=requireSession_(token,{admin:true});return adminListActiveSessionsInternal_(s.username);}
function adminRunAutoPostNow(token){const s=requireSession_(token,{admin:true});return adminRunAutoPostNowInternal_(s.username);}

// URL webhook + daftar jam untuk dipasang di cron eksternal (presisi jam sesi).
function adminGetAutoPostWebhookInternal_(adminUsername) {
  requireAdmin_(adminUsername);
  const base = ScriptApp.getService().getUrl();
  const slots = JADWAL_PREDIKSI_CONFIG.map(function (x) { return x.jam; })
    .concat(CLOSING_PREDICTION_SLOTS_)
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .sort();
  return {
    success: true,
    url: base + (base.indexOf('?') >= 0 ? '&' : '?') + 'autopost=' + autoPostWebhookKey_(),
    slots: slots,
    timezone: PREDICTION_TIMEZONE_
  };
}
function adminGetAutoPostWebhook(token){const s=requireSession_(token,{admin:true});return adminGetAutoPostWebhookInternal_(s.username);}

// Trigger router must stay public for Apps Script scheduler, but it uses trusted username internally.
function triggerRouterAutoPost(){
  const now=new Date(),h=Number(Utilities.formatDate(now,PREDICTION_TIMEZONE_,'HH')),m=Number(Utilities.formatDate(now,PREDICTION_TIMEZONE_,'mm')),current=h*60+m;
  JADWAL_PREDIKSI_CONFIG.forEach(function(item,index){const p=item.jam.split(':'),target=Number(p[0])*60+Number(p[1]);if(Math.abs(current-target)<=10)sendPredictionAutoInternal_(index,'Hugo');});
}

// Parallel prediction sender: short registry locks + fetchAll Telegram + grouped writes.
function dgPredictionBatchReserveWrite_(sheet,writes){
  const newItems=writes.filter(function(x){return x.isNew;}).sort(function(a,b){return a.row-b.row;});const existing=writes.filter(function(x){return !x.isNew;});
  if(newItems.length){const start=newItems[0].row;sheet.getRange(start,1,newItems.length,PREDICTION_REGISTRY_HEADERS_.length).setValues(newItems.map(function(x){return x.values;}));}
  existing.forEach(function(x){sheet.getRange(x.row,1,1,PREDICTION_REGISTRY_HEADERS_.length).setValues([x.values]);});
}
function dgPredictionBatchUpdate_(sheet,reservations,resultMap,requestId,cleanUser){
  const groups=dgRowsToGroups_(reservations.map(function(x){return x.row;}));
  groups.forEach(function(g){const vals=sheet.getRange(g.start,1,g.end-g.start+1,PREDICTION_REGISTRY_HEADERS_.length).getValues();let changed=false;vals.forEach(function(row,i){const abs=g.start+i,res=reservations.find(function(x){return x.row===abs;});if(!res)return;if(String(row[7]||'')!==requestId||String(row[10]||'')!==res.uniqueKey)return;const result=resultMap[res.website];row[4]=result.status==='BERHASIL'?'BERHASIL':'GAGAL';row[5]=cleanUser;row[6]=new Date();row[7]=requestId;row[8]=result.reason;changed=true;});if(changed)sheet.getRange(g.start,1,vals.length,PREDICTION_REGISTRY_HEADERS_.length).setValues(vals);});
}
function sendPredictionJob_(options){
  const total=Date.now(),perf={};let t=Date.now();
  let context;
  if (Array.isArray(options.systemWebsites)) {
    // Mode SISTEM (auto posting): kirim ke daftar website apa adanya, tanpa
    // menyaring lewat profil satu user. 1 pekerjaan untuk semua website ->
    // 1 batch Telegram fetchAll -> cepat (tidak per-user).
    const sites=Array.from(new Set(options.systemWebsites.map(function(x){return String(x||'').trim().toUpperCase();}).filter(Boolean)));
    context = sites.length ? {cleanUser:String(options.username||'AUTO'),websites:sites} : {error:'Tidak ada website untuk diproses.'};
  } else {
    context=validatePredictionSendContext_(options.username,options.onlyWebsites);
  }
  perf.validateMs=dgMs_(t);if(context.error)return {success:false,blocked:true,message:context.error,websiteResults:[],kind:options.kind||'schedule',performance:{totalMs:dgMs_(total)}};
  const cleanUser=context.cleanUser,websites=context.websites,dateKey=(options.dateKey&&/^\d{4}-\d{2}-\d{2}$/.test(options.dateKey))?options.dateKey:predictionTodayKey_(),scheduleId=String(options.scheduleId||'').trim().toUpperCase(),predictionName=String(options.predictionName||'PREDIKSI'),requestId=Utilities.getUuid(),accounts=readPredictionTelegramAccounts_(),sheet=getPredictionRegistrySheet_(),lock=LockService.getScriptLock(),reservations=[],resultMap={},contentMap={};
  websites.forEach(function(w){try{contentMap[w]=String(options.messageForWebsite(w)||'');}catch(e){contentMap[w]='';}});
  t=Date.now();
  try{lock.waitLock(10000);const registry=readPredictionRegistryForDate_(dateKey);let next=sheet.getLastRow()+1,writes=[];websites.forEach(function(w){const key=scheduleId+'||'+w,prev=registry[key]||null;if(prev&&prev.status==='BERHASIL'){resultMap[w]={website:w,status:'SUDAH DIKIRIM',reason:'Smart Lock memblokir duplikat. Sudah dikirim oleh '+(prev.username||'user lain')+(prev.timeText?' pada '+prev.timeText:'')+'.'};return;}if(prev&&prev.status==='PROCESSING'&&prev.processingFresh){resultMap[w]={website:w,status:'SEDANG DIPROSES',reason:'Website ini sedang diproses oleh '+(prev.username||'user lain')+'.'};return;}const content=contentMap[w];if(!content){resultMap[w]={website:w,status:'GAGAL',reason:'Isi pesan kosong.'};return;}const isNew=!(prev&&prev.row),row=isNew?next++:prev.row,unique=predictionUniqueKey_(dateKey,scheduleId,w),values=[dateKey,scheduleId,predictionName,w,'PROCESSING',cleanUser,new Date(),requestId,'Reservasi Smart Content V6',contentHash_(content),unique];writes.push({row:row,isNew:isNew,values:values});reservations.push({website:w,row:row,content:content,uniqueKey:unique});});dgPredictionBatchReserveWrite_(sheet,writes);}finally{try{lock.releaseLock();}catch(e){}}
  perf.reserveMs=dgMs_(t);
  t=Date.now();const tgJobs=[];reservations.forEach(function(r){const a=accounts[r.website];if(!a||!a.TOKEN||!a.CHAT_ID)resultMap[r.website]={website:r.website,status:'GAGAL',reason:'TOKEN atau CHAT_ID Telegram Prediksi tidak ditemukan pada Sheet Sosmed.'};else tgJobs.push({id:r.website,website:r.website,text:r.content,cfg:a});});const sent=dgTelegramJobs_(tgJobs);tgJobs.forEach(function(j){const r=sent[j.id]||{status:'GAGAL',reason:'Tidak ada respons Telegram'};resultMap[j.website]={website:j.website,status:r.status,reason:r.reason};});perf.telegramMs=dgMs_(t);
  t=Date.now();if(reservations.length){try{lock.waitLock(10000);dgPredictionBatchUpdate_(sheet,reservations,resultMap,requestId,cleanUser);}finally{try{lock.releaseLock();}catch(e){}}}perf.registryMs=dgMs_(t);
  const wr=websites.map(function(w){return resultMap[w]||{website:w,status:'GAGAL',reason:'Status pengiriman tidak tersedia.'};}),c={success:0,failed:0,already:0,processing:0};wr.forEach(function(x){const s=String(x.status||'').toUpperCase();if(s==='BERHASIL')c.success++;else if(s==='SUDAH DIKIRIM')c.already++;else if(s==='SEDANG DIPROSES')c.processing++;else c.failed++;});const pending=wr.filter(function(x){return String(x.status).toUpperCase()==='GAGAL';}).map(function(x){return x.website;}),allAlready=c.already===wr.length,noNew=c.success===0&&c.failed===0,anySuccess=c.success>0,anyFailure=c.failed>0;let logStatus=allAlready?'DIBLOKIR':anySuccess&&anyFailure?'SEBAGIAN':anyFailure&&!anySuccess?'GAGAL':anySuccess?'BERHASIL':'INFO';
  const logDetail=predictionName+' | '+wr.map(function(x){var st=String(x.status||'').toUpperCase();return x.website+': '+x.status+(st!=='BERHASIL'&&st!=='SUDAH DIKIRIM'&&x.reason?' ('+x.reason+')':'');}).join(' | ');
  logActivity_(cleanUser,allAlready?'DUPLIKAT PREDIKSI DIBLOKIR':String(options.logAction||'KIRIM PREDIKSI AUTO'),logDetail,logStatus,reservations.map(function(x){return x.content;}).join('\n\n'));perf.totalMs=dgMs_(total);
  return {success:anySuccess&&!anyFailure,partial:anySuccess&&anyFailure,blocked:noNew,allAlready:allAlready,message:allAlready?'Smart Lock memblokir pengiriman karena seluruh website sudah menerima sesi ini hari ini.':pending.length?'Sebagian website belum berhasil dikirim.':c.processing>0&&!anySuccess?'Pengiriman sedang diproses oleh permintaan lain.':'Proses pengiriman selesai.',kind:options.kind||'schedule',activeSlot:options.activeSlot||'',predictionIndex:options.predictionIndex==null?-1:Number(options.predictionIndex),predictionName:predictionName,dateKey:dateKey,scheduleId:scheduleId,websiteResults:wr,pendingWebsites:pending,counters:c,durationMs:perf.totalMs,performance:perf,serverVersion:DG_V6_VERSION_};
}
function sendPredictionAuto(index,token,onlyWebsites){const s=requireSession_(token);return sendPredictionAutoInternal_(index,s.username,onlyWebsites);}
function sendClosingPredictionAuto(token,onlyWebsites,slot){const s=requireSession_(token);return sendClosingPredictionAutoInternal_(s.username,onlyWebsites,slot);}


function getMaintenanceSettings_(){
  try{const raw=dgCache_().get('DG_V6_MAINT');if(raw)return JSON.parse(raw);}catch(e){}
  const value=getMaintenanceSettingsSource_();
  try{dgCache_().put('DG_V6_MAINT',JSON.stringify(value),30);}catch(e){}
  return value;
}