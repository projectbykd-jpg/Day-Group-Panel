// ============================================================================
// Code.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// Entry point web app: doGet / doPost + webhook auto-post prediksi.
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================

// include(): menyisipkan file HTML lain ke template Index.html lewat
// scriptlet <?!= include('Styles'); ?> / <?!= include('Scripts'); ?>.
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

  function doGet(e) {
  var params = (e && e.parameter) || {};

  // WEBHOOK AUTO POSTING PREDIKSI
  // Dipanggil layanan cron eksternal (mis. cron-job.org) TEPAT di jam sesi, supaya
  // prediksi naik on-time (jeda beberapa detik saja), bukan menunggu tick trigger
  // Apps Script yang bisa telat 5-7 menit. Diamankan dengan kunci rahasia.
  if (params.autopost) {
    return handleAutoPostWebhook_(params.autopost);
  }

  var scriptUrl = ScriptApp.getService().getUrl();

  var faviconUrl = 'https://i.ibb.co/FkF6x1St/image.png';

  var template = HtmlService.createTemplateFromFile('index');
  template.scriptUrl = scriptUrl;
  return template.evaluate()
              .setTitle('Day-Group PANEL')
              .setFaviconUrl(faviconUrl)
              .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
              .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// POST tidak di-redirect Apps Script (beda dengan GET yang balas 302 ke
// googleusercontent.com). Jadi cron eksternal yang pakai method POST langsung
// menerima JSON {"ok":true} tanpa "Redirection detected".
function doPost(e) {
  var params = (e && e.parameter) || {};
  if (params.autopost) {
    return handleAutoPostWebhook_(params.autopost);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: false, message: 'Tidak ada aksi.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function autoPostWebhookKey_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('DG_AUTOPOST_WEBHOOK_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
    props.setProperty('DG_AUTOPOST_WEBHOOK_KEY', key);
  }
  return key;
}

function handleAutoPostWebhook_(providedKey) {
  var out = { ok: false, message: '' };
  try {
    if (String(providedKey || '') !== autoPostWebhookKey_()) {
      out.message = 'Kunci webhook tidak valid.';
    } else {
      // Kirim LANGSUNG di sini supaya prediksi naik tepat di jamnya (jeda detik,
      // bukan menit). Cepat karena: 1 pekerjaan per sesi untuk semua website
      // (1 batch Telegram), konten sudah di-prebuild oleh trigger 5-menit,
      // dan single-flight mencegah tumpang tindih.
      var res = autoPostPredictionRouter({ force: true, windowMinutes: 25 }) || {};
      out.ok = true;
      out.ran = !!res.ran;
      out.sent = Number(res.sent || 0);
      out.already = Number(res.already || 0);
      out.failed = Number(res.failed || 0);
      out.message = res.message || 'OK';
    }
  } catch (err) {
    out.message = (err && err.message) ? err.message : String(err);
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// Pasang trigger sekali-pakai untuk menjalankan router di latar belakang.
// Dipakai HANYA untuk susulan besar saat auto posting baru diaktifkan
// (bisa memproses banyak sesi 10 jam ke belakang -> jangan tahan respons).
function autoPostScheduleRunner_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'autoPostWebhookRunner_') ScriptApp.deleteTrigger(t);
    });
  } catch (e) {}
  ScriptApp.newTrigger('autoPostWebhookRunner_').timeBased().after(1000).create();
}

function autoPostWebhookRunner_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'autoPostWebhookRunner_') ScriptApp.deleteTrigger(t);
    });
  } catch (e) {}
  try { autoPostPredictionRouter({ force: true }); } catch (e) {}
}