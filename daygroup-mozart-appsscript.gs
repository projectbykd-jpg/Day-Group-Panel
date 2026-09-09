/**
 * daygroup-mozart — Apps Script khusus scrape Mozart untuk Day-Group Panel.
 *
 * KENAPA APPS SCRIPT: API Mozart (limatogel.makintajir.com) di belakang Cloudflare
 * yang memblokir SEMUA IP datacenter (Cloudflare Workers + GitHub Actions).
 * IP Google Apps Script lolos.
 *
 * CARA PASANG (sekali saja):
 * 1. https://script.google.com  -> New project -> nama "daygroup-mozart"
 * 2. Hapus isi Code.gs, tempel SELURUH file ini.
 * 3. Ganti SHARED_KEY di bawah dengan string acak panjang (bebas, minimal 30 char).
 * 4. Deploy -> New deployment -> pilih "Web app"
 *      Execute as: Me
 *      Who has access: Anyone
 *    -> Deploy -> salin URL yang berakhiran /exec
 * 5. Kirim URL /exec + SHARED_KEY ke panel (nanti di-set sebagai secret Worker).
 *
 * Panel akan POST {key, cookie, base, startDate, endDate}. Script balas JSON
 * { success, depositData[], withdrawData[], summary }.
 */

var SHARED_KEY = 'GANTI_DENGAN_STRING_ACAK_PANJANG_MINIMAL_30_KARAKTER';

var MOZART_PAGE_SIZE = 100;
var MOZART_MAX_PAGES = 200;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function doPost(e) {
  var out = { success: false };
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (body.key !== SHARED_KEY) {
      return jsonOut({ success: false, message: 'key salah' });
    }
    var base = String(body.base || '').trim();
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    var hm = base.match(/^(https?:\/\/[^\/\s?#]+)/i);
    base = hm ? hm[1] : base.replace(/\/+$/, '');
    var cookie = String(body.cookie || '').trim();
    var startDate = String(body.startDate || '');
    var endDate = String(body.endDate || '');
    if (!cookie) return jsonOut({ success: false, message: 'cookie Mozart kosong' });

    var res = scrapeMozart_(base, cookie, startDate, endDate);
    res.success = true;
    return jsonOut(res);
  } catch (err) {
    return jsonOut({ success: false, message: String(err && err.message || err) });
  }
}

function doGet() {
  return jsonOut({ ok: true, service: 'daygroup-mozart' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function scrapeMozart_(base, cookie, startDate, endDate) {
  var headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': cookie,
    'origin': base,
    'user-agent': UA
  };

  function fetchAll(path, refererPath, baseBody) {
    var rows = [];
    for (var page = 0; page < MOZART_MAX_PAGES; page++) {
      var opts = {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        followRedirects: false,
        headers: Object.assign({}, headers, { 'referer': base + refererPath }),
        payload: JSON.stringify(Object.assign({}, baseBody, { page_number: page, page_size: MOZART_PAGE_SIZE }))
      };
      var r = UrlFetchApp.fetch(base + path, opts);
      var code = r.getResponseCode();
      var text = r.getContentText() || '';
      if (code === 401) throw new Error('MOZART 401: cookie/atoken kedaluwarsa. Perbarui di Setting.');
      if (code === 403 || code === 503) {
        if (/cloudflare|attention required/i.test(text)) {
          throw new Error('MOZART masih diblokir Cloudflare (403). cookie mungkin salah / perlu cf_clearance.');
        }
        throw new Error('MOZART ' + code + ': ' + text.substring(0, 150));
      }
      if (code >= 400) {
        if (page === 0) throw new Error('MOZART HTTP ' + code + ': ' + text.substring(0, 150));
        break;
      }
      var j;
      try { j = JSON.parse(text); } catch (er) {
        if (page === 0) throw new Error('Respons Mozart bukan JSON: ' + text.substring(0, 150));
        break;
      }
      var found = findRows_(j);
      rows = rows.concat(found);
      if (found.length < MOZART_PAGE_SIZE) break;
      Utilities.sleep(120);
    }
    return rows;
  }

  var depoRows = fetchAll('/api/transactions/fetchTransaction', '/transactions', {
    panel_id: 0, start_date: startDate, end_date: endDate, not_done_filter: false, filter_by: null
  });
  var wdRows = fetchAll('/api/wd/fetchWithdrawal', '/wd', {
    panel_id: 0, start_date: startDate, end_date: endDate, filter_by: { minimum_amount: 0 }
  });

  var depositData = depoRows.map(function (r) {
    return {
      date: String(pick_(r, ['created_at','date','transaction_date','trx_date','waktu','time'], '-')),
      username: String(pick_(r, ['username','user','player','user_id','nama_user'], '-')),
      name: String(pick_(r, ['name','sender_name','recipient','nama','account_name'], '-')),
      amount: num_(pick_(r, ['amount','nominal','jumlah'], 0)),
      bank: String(pick_(r, ['bank','bank_name','bank_code','app'], '-')),
      accountNumber: String(pick_(r, ['account_number','rekening','bank_account','no_rek'], '-')),
      status: String(pick_(r, ['status','status_description','state','transaction_status'], 'SUCCESS'))
    };
  });
  var withdrawData = wdRows.map(function (r) {
    return {
      date: String(pick_(r, ['created_at','date','transaction_date','trx_date','waktu','time'], '-')),
      username: String(pick_(r, ['username','user','player','user_id'], '-')),
      name: String(pick_(r, ['name','recipient','recipient_name','nama','account_name'], '-')),
      amount: num_(pick_(r, ['amount','nominal','jumlah'], 0)),
      bank: String(pick_(r, ['destination','bank','bank_name','bank_code','app','to_bank'], '-')),
      accountNumber: String(pick_(r, ['account_number','rekening','bank_account','no_rek'], '-')),
      status: String(pick_(r, ['status','status_description','state','transaction_status'], '-'))
    };
  });

  var sum = function (a) { return a.reduce(function (s, x) { return s + (x.amount || 0); }, 0); };
  return {
    depositData: depositData,
    withdrawData: withdrawData,
    summary: {
      totalDepoRecords: depositData.length,
      totalDepoAmount: sum(depositData),
      totalWdRecords: withdrawData.length,
      totalWdAmount: sum(withdrawData),
      netAmount: sum(depositData) - sum(withdrawData)
    }
  };
}

function findRows_(json) {
  if (Object.prototype.toString.call(json) === '[object Array]') return json;
  var best = [];
  Object.keys(json || {}).forEach(function (k) {
    var v = json[k];
    if (Object.prototype.toString.call(v) === '[object Array]' && v.length >= best.length &&
        (v.length === 0 || typeof v[0] === 'object')) {
      best = v;
    } else if (v && typeof v === 'object') {
      var nested = findRows_(v);
      if (nested.length > best.length) best = nested;
    }
  });
  return best;
}
function pick_(obj, keys, fb) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fb;
}
function num_(v) {
  var n = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
