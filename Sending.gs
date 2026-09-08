// ============================================================================
// Sending.gs  -  bagian dari Day-Group PANEL (dipecah dari code.gs, 2026-09-07).
// Parser hasil (processText_), peta shio dan pasaran, pengirim Telegram / LinkTree / Panel-Z (jalur Internal / legacy).
// Apps Script menggabung semua file .gs jadi satu scope global saat eksekusi,
// jadi URUTAN dan NAMA file bebas; perilaku runtime IDENTIK dengan code.gs lama.
// Pemecahan ini murni untuk kerapian, bukan perubahan logika.
// ============================================================================


function processText_(text) {
  try {
    if (!text || text.length < 5) return createEmptyResponse_();
    
    const marketMatch = text.match(/Pasaran\s+(.*)/i);
    const market = marketMatch ? marketMatch[1].trim() : 'UNKNOWN';
    const prize1 = ((text.match(/Prize\s*1[^0-9]*(\d{4})/i) || [])[1] || '');
    
    if (!prize1) return { market, status: 'SALAH', shio: '', twoDigit: '', output: '', prize1: '', prize2: '', prize3: '' };
    
    const prize2 = ((text.match(/Prize\s*2[^0-9]*(\d{4})/i) || [])[1] || '');
    const prize3 = ((text.match(/Prize\s*3[^0-9]*(\d{4})/i) || [])[1] || '');
    const twoDigit = Number(prize1.slice(-2));
    const shio = getShio_(twoDigit);
    const shioInput = ((text.match(/Shio\s*:\s*([A-Z]+)/i) || [])[1] || '').toUpperCase();
    const status = shioInput ? (shioInput === shio ? 'BENAR' : 'SALAH') : 'BENAR';

    let output = text.trim();
    output = output.replace(/Prize\s*1\s*:/gi, 'Prize 1️⃣ :').replace(/Prize\s*2\s*:/gi, 'Prize 2️⃣ :').replace(/Prize\s*3\s*:/gi, 'Prize 3️⃣ :');
    if (/Shio\s*:/i.test(output)) { output = output.replace(/Shio\s*:.*$/im, 'Shio : ' + shio); } else { output += '\n\nShio : ' + shio; }
    output = output.replace(/Selamat kepada para pemenang jackpot\s*\.?/i, 'Selamat kepada para pemenang jackpot 🙏🏻');

    return { market, status, shio, twoDigit, output, prize1, prize2, prize3 };
  } catch (e) { return createEmptyResponse_(); }
}

function createEmptyResponse_() {
  return { market: 'UNKNOWN', status: 'SALAH', shio: '', twoDigit: '', output: '', prize1: '', prize2: '', prize3: '' };
}

function getShio_(num) {
  const map = {
    1:"KUDA",13:"KUDA",25:"KUDA",37:"KUDA",49:"KUDA",61:"KUDA",73:"KUDA",85:"KUDA",97:"KUDA",
    2:"ULAR",14:"ULAR",26:"ULAR",38:"ULAR",50:"ULAR",62:"ULAR",74:"ULAR",86:"ULAR",98:"ULAR",
    3:"NAGA",15:"NAGA",27:"NAGA",39:"NAGA",51:"NAGA",63:"NAGA",75:"NAGA",87:"NAGA",99:"NAGA",
    4:"KELINCI",16:"KELINCI",28:"KELINCI",40:"KELINCI",52:"KELINCI",64:"KELINCI",76:"KELINCI",88:"KELINCI",0:"KELINCI",
    5:"HARIMAU",17:"HARIMAU",29:"HARIMAU",41:"HARIMAU",53:"HARIMAU",65:"HARIMAU",77:"HARIMAU",89:"HARIMAU",
    6:"KERBAU",18:"KERBAU",30:"KERBAU",42:"KERBAU",54:"KERBAU",66:"KERBAU",78:"KERBAU",90:"KERBAU",
    7:"TIKUS",19:"TIKUS",31:"TIKUS",43:"TIKUS",55:"TIKUS",67:"TIKUS",79:"TIKUS",91:"TIKUS",
    8:"BABI",20:"BABI",32:"BABI",44:"BABI",56:"BABI",68:"BABI",80:"BABI",92:"BABI",
    9:"ANJING",21:"ANJING",33:"ANJING",45:"ANJING",57:"ANJING",69:"ANJING",81:"ANJING",93:"ANJING",
    10:"AYAM",22:"AYAM",34:"AYAM",46:"AYAM",58:"AYAM",70:"AYAM",82:"AYAM",94:"AYAM",
    11:"MONYET",23:"MONYET",35:"MONYET",47:"MONYET",59:"MONYET",71:"MONYET",83:"MONYET",95:"MONYET",
    12:"KAMBING",24:"KAMBING",36:"KAMBING",48:"KAMBING",60:"KAMBING",72:"KAMBING",84:"KAMBING",96:"KAMBING"
  };
  return map[num] || "UNKNOWN";
}

function getAkunByWebsiteLegacy_(websiteName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Sosmed");
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().toUpperCase() === websiteName.toString().toUpperCase()) {
      return {
        TELEGRAM: {
          TOKEN: data[i][1],
          CHAT_ID: data[i][2]
        },
        LINKTREE: {
          EMAIL: data[i][3],
          PASS: data[i][4]
        },
        PANELZ: {
          USERNAME: data[i][5],
          PASSWORD: data[i][6],
          USERNAME2: data[i][7],
          PASSWORD2: data[i][8],
          URL: data[i][9]
        }
      };
    }
  }
  return null;
}

function getAkunPrediksiByWebsite_(websiteName) {
  const key = String(websiteName || "").trim().toUpperCase();
  const map = readPredictionTelegramAccounts_();
  if (map[key] && map[key].TOKEN && map[key].CHAT_ID) return map[key];

  // Fallback untuk instalasi lama yang masih memakai sheet PREDIKSI.
  const oldSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("PREDIKSI");
  if (oldSheet && oldSheet.getLastRow() >= 3) {
    const data = oldSheet.getDataRange().getValues();
    for (let i = 2; i < data.length; i++) {
      if (String(data[i][0] || "").trim().toUpperCase() === key) {
        return { TOKEN: data[i][1], CHAT_ID: data[i][2] };
      }
    }
  }
  return null;
}

/**
 * FUNGSI UTAMA PENGIRIMAN (Dinamis berdasarkan Website)
 */
function sendAllSystemsInternal_(rawText, username, isPrediksiAuto) {
  return sendSelectedSystemsInternal_(rawText, username, ["telegram","linktree","panelz"], false, !!isPrediksiAuto);
}

function getSendPreviewInternal_(rawText, username) {
  const profile = getUserProfile_(username);
  if (!profile) return {success:false, message:"User tidak ditemukan"};
  const processed = processText_(rawText);
  const normalized = processed.output || String(rawText || "").trim();
  const websiteStatus = getWebsiteDeliveryStatus_(profile, normalized);
  const pendingWebsites = websiteStatus.filter(x => x.hasPending).map(x => x.website);
  const completedWebsites = websiteStatus.filter(x => !x.hasPending).map(x => x.website);
  return {
    success:true,
    market:processed.market || "-", prize1:processed.prize1 || "-", prize2:processed.prize2 || "-", prize3:processed.prize3 || "-",
    permissions:profile.permissions, websites:profile.websites,
    websiteStatus:websiteStatus,
    pendingWebsites:pendingWebsites,
    completedWebsites:completedWebsites,
    allCompleted:pendingWebsites.length===0,
    content:normalized
  };
}

function sendSelectedSystemsInternal_(rawText, username, targets, forceDuplicate, isPrediksiAuto, onlyWebsites) {
  const profile = getUserProfile_(username);
  if (!profile) return {success:false, blocked:true, message:"User tidak ditemukan"};
  const maintenance = getMaintenanceSettings_();
  if (maintenance.enabled && profile.role !== "ADMIN") return {success:false, blocked:true, message:maintenance.message};

  const processed = processText_(rawText);
  const textToSend = isPrediksiAuto ? String(rawText || "") : (processed.output || String(rawText || ""));
  targets = Array.isArray(targets) ? targets.map(x=>String(x).toLowerCase()) : ["telegram","linktree","panelz"];
  const requested = {telegram:targets.includes("telegram"), linktree:targets.includes("linktree"), panelz:targets.includes("panelz")};
  const permissionMap = profile.permissions;
  const selectedSet = new Set((Array.isArray(onlyWebsites)&&onlyWebsites.length?onlyWebsites:profile.websites).map(x=>String(x).trim().toUpperCase()));
  const websites = profile.websites.filter(w=>selectedSet.has(String(w).trim().toUpperCase()));

  const websiteResults = [];
  for (const website of websites) {
    const previous = getRegistryEntry_(website, textToSend);
    const acc = getAkunByWebsiteInternal_(website);
    const wr = {website:website, telegram:{status:"SKIP",reason:"Tidak dipilih"}, linktree:{status:"SKIP",reason:"Tidak dipilih"}, panelz:{status:"SKIP",reason:"Tidak dipilih"}};

    for (const k of ["telegram","linktree","panelz"]) {
      if (!requested[k]) continue;
      if (!permissionMap[k]) { wr[k]={status:"GAGAL",reason:"Tidak diizinkan pada Sheet Users"}; continue; }
      if (!forceDuplicate && previous && previous[k] === true) { wr[k]={status:"SUDAH DIKIRIM",reason:"Data ini sudah berhasil dikirim ke "+website}; continue; }
      if (!acc) { wr[k]={status:"GAGAL",reason:"Konfigurasi website "+website+" tidak ditemukan"}; continue; }
      let r;
      if (k === "telegram") {
        if (isPrediksiAuto) {
          const p = getAkunPrediksiByWebsite_(website);
          r = p && p.TOKEN ? sendToTelegramInternal_(textToSend,p) : "Token PREDIKSI tidak ditemukan";
        } else r = sendToTelegramInternal_(textToSend, acc.TELEGRAM);
      } else if (k === "linktree") r = sendToAWSInternal_(textToSend, acc.LINKTREE);
      else r = sendToPanelZInternal_(textToSend, acc.PANELZ);
      wr[k] = normalizeSendResult_(r);
    }

    const merged = {
      telegram: (previous&&previous.telegram===true) || wr.telegram.status==="BERHASIL",
      linktree: (previous&&previous.linktree===true) || wr.linktree.status==="BERHASIL",
      panelz: (previous&&previous.panelz===true) || wr.panelz.status==="BERHASIL"
    };
    if (merged.telegram || merged.linktree || merged.panelz) saveOrUpdateSentRegistry_(username, website, textToSend, processed.market, merged, wr);
    websiteResults.push(wr);
  }

  const flat = ["telegram","linktree","panelz"].reduce((o,k)=>{
    const vals=websiteResults.map(w=>w[k]).filter(Boolean);
    if(!requested[k]) o[k]={status:"SKIP",reason:"Tidak dipilih"};
    else if(!permissionMap[k]) o[k]={status:"GAGAL",reason:"Tidak diizinkan pada Sheet Users"};
    else if(vals.some(v=>v.status==="GAGAL")) o[k]={status:"GAGAL",reason:vals.filter(v=>v.status==="GAGAL").map((v,i)=>websiteResults[i]?.website+": "+v.reason).join(" | ")};
    else if(vals.some(v=>v.status==="BERHASIL")) o[k]={status:"BERHASIL",reason:"Terkirim ke "+vals.filter(v=>v.status==="BERHASIL").length+" website"};
    else if(vals.some(v=>v.status==="SUDAH DIKIRIM")) o[k]={status:"SUDAH DIKIRIM",reason:"Semua website terpilih sudah pernah menerima data ini"};
    else o[k]={status:"SKIP",reason:"Tidak ada website diproses"};
    return o;
  },{});

  const attempted = websiteResults.flatMap(w=>[w.telegram,w.linktree,w.panelz]).filter(x=>x.status!=="SKIP"&&x.status!=="SUDAH DIKIRIM");
  const anySuccess = attempted.some(x=>x.status==="BERHASIL");
  const anyFailure = attempted.some(x=>x.status==="GAGAL");
  const allAlready = attempted.length===0 && websiteResults.length>0;
  const detail = websiteResults.map(w=>`${w.website} => Telegram: ${w.telegram.status} (${w.telegram.reason}) | LinkTree: ${w.linktree.status} (${w.linktree.reason}) | Panel-Z: ${w.panelz.status} (${w.panelz.reason})`).join(" || ");
  logActivity_(username, allAlready?"DUPLIKAT WEBSITE DIBLOKIR":(isPrediksiAuto?"KIRIM PREDIKSI OTOMATIS":"SEND SYSTEMS"), detail, anyFailure&&!anySuccess?"GAGAL":(anyFailure?"SEBAGIAN":"BERHASIL"), textToSend);
  return {success:!anyFailure&&!allAlready, partial:anySuccess&&anyFailure, allAlready:allAlready, telegram:flat.telegram, linktree:flat.linktree, panelz:flat.panelz, websiteResults:websiteResults, content:textToSend};
}

function retryFailedSystemInternal_(rawText, username, systemName, websiteName) {
  const websites = websiteName ? [websiteName] : null;
  return sendSelectedSystemsInternal_(rawText, username, [String(systemName||'').toLowerCase()], true, false, websites);
}

function normalizeSendResult_(value) {
  if (value && typeof value === 'object' && value.success === false) return {status:"GAGAL",reason:value.message||"Tidak diketahui"};
  const text = String(value == null ? '' : value);
  if (/^(terkirim|berhasil)/i.test(text)) return {status:"BERHASIL",reason:text};
  if (!text) return {status:"GAGAL",reason:"Tidak ada respons"};
  return {status:"GAGAL",reason:text};
}

/**
 * TELEGRAM SEND
 */
function sendToTelegramInternal_(rawText, teleCfg) {
  try {
    const url = `https://api.telegram.org/bot${teleCfg.TOKEN}/sendMessage`;
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      payload: {
        chat_id: String(teleCfg.CHAT_ID).trim(),
        text: rawText
      },
      muteHttpExceptions: true
    });

    const body = response.getContentText();
    if (response.getResponseCode() !== 200) {
      return "Tele Error: " + body;
    }
    return "Terkirim";
  } catch (e) { 
    return "Tele Error: " + e.message; 
  }
}

function loginAWSInternal_(config) {
  try {
    const response = UrlFetchApp.fetch(
      "http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/index",
      {
        method: "post",
        payload: {
          email: config.EMAIL,
          password: config.PASS
        },
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    Logger.log("LOGIN CODE = " + response.getResponseCode());

    const headers = response.getAllHeaders();

    let cookies = headers["Set-Cookie"] || headers["set-cookie"];

    if (!cookies) {
      return "Error: Cookie tidak ditemukan";
    }

    if (!Array.isArray(cookies)) {
      cookies = [cookies];
    }

    const sessionCookie = cookies
      .map(cookie => cookie.split(";")[0])
      .join("; ");

    return sessionCookie;
  } catch (e) {
    return "Error: " + e.message;
  }
}

function sendToAWSInternal_(rawText, linktreeCfg) {
  try {
    const sessionCookie = loginAWSInternal_(linktreeCfg);
    if (typeof sessionCookie === "string" && sessionCookie.startsWith("Error:")) return sessionCookie;

    const processed = processText_(rawText);
    const marketName = processed.market && processed.market !== 'UNKNOWN' ? processed.market : 'LAOS SIANG';

    const titleText = `Hasil Pengeluaran Pasaran ${marketName}`;

    let bodyText = `🅿️1️⃣ : ${processed.prize1 || '8145'}`;
    if (processed.prize2) bodyText += `  🅿️2️⃣ : ${processed.prize2}`;
    if (processed.prize3) bodyText += `  🅿️3️⃣ : ${processed.prize3}`;

    const payload = {
      apikey: "bbd53ebb-ba2b-11ec-9377-f2937b475656",
      title: titleText,
      body: bodyText
    };

    const response = UrlFetchApp.fetch(
      "http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/notif_send_post",
      {
        method: "post",
        headers: { Cookie: sessionCookie },
        payload: payload,
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    const code = response.getResponseCode();
    const responseBody = response.getContentText();
    if (responseBody.indexOf("LinkTree System") > -1) return "Session Login Gagal";
    if (code === 200 || code === 302) return "Terkirim";
    return "Gagal (" + code + ")";
  } catch (e) {
    return "Error: " + e.message;
  }
}

function loginPanelZInternal_(panelCfg) {
  try {
    const basicAuth =
      "Basic " +
      Utilities.base64Encode(
        panelCfg.USERNAME +
        ":" +
        panelCfg.PASSWORD
      );

    const response = UrlFetchApp.fetch(
      panelCfg.URL + "/assets/sys-tmbet/authentication.php",
      {
        method: "post",
        headers: { Authorization: basicAuth },
        payload: {
          username: panelCfg.USERNAME2,
          password: panelCfg.PASSWORD2
        },
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    const headers = response.getAllHeaders();
    let cookie = headers["Set-Cookie"] || headers["set-cookie"];

    if (!cookie) {
      return "Error: PHPSESSID tidak ditemukan";
    }

    if (Array.isArray(cookie)) {
      cookie = cookie[0];
    }

    const match = cookie.match(/PHPSESSID=[^;]+/);

    if (!match) {
      return "Error: Session gagal";
    }

    return {
      basicAuth: basicAuth,
      cookie: match[0]
    };
  } catch (e) {
    return "Error: " + e.message;
  }
}

function getPanelRowAutoInternal_(sessionData, panelCfg, market) {
  try {
    const response = UrlFetchApp.fetch(
      panelCfg.URL + "/dashboard.php?hal=result",
      {
        headers: {
          Authorization: sessionData.basicAuth,
          Cookie: sessionData.cookie
        },
        muteHttpExceptions: true
      }
    );

    const html = response.getContentText();
    const marketKey = convertMarketToPanel_(market);

    if (!marketKey) {
      return null;
    }

    const regex = new RegExp(
      marketKey + "[\\s\\S]{0,500}?" + "update-resultlotto\\.php\\?row=(\\d+)",
      "i"
    );

    const match = html.match(regex);
    return match ? match[1] : null;
  } catch (e) {
    Logger.log("ROW ERROR = " + e.message);
    return null;
  }
}

function convertMarketToPanel_(market) {
  const map = {
    "ATHENS":"athens",
    "AUSTRIA":"austria",
    "BAHRAIN":"bahrain",
    "BERLIN":"berlin",
    "BULLSEYE":"bullseye",
    "BUSAN":"busan",
    "CAIRO":"cairo",
    "CALIFORNIA":"california",
    "CAROLINADAY":"carolina-day",
    "CAROLINAEVE":"carolina-eve",
    "COLORADO":"colorado",
    "DALLAS":"dallas",
    "FLORIDAEVE":"florida-eve",
    "FLORIDAMID":"florida-mid",
    "HK SIANG":"hk-siang",
    "HONGKONG":"hongkong",
    "IDAHO":"idaho",
    "INDIA MORNING":"india-mor",
    "INDIA":"india-night",
    "KANSAS":"kansas",
    "KENTUCKYEVE":"kentucky-eve",
    "KENTUCKYMID":"kentucky-mid",
    "KHMER LOTTO":"khmer-lotto",
    "LAOS MALAM":"laos-malam",
    "LAOS SIANG":"laos-siang",
    "LISBON":"lisbon-mor",
    "LISBON NIGHT":"lisbon-night",
    "MALAYSIA":"malaysia",
    "NEW MEXICO":"mexico-day",
    "MEXICO":"mexico-night",
    "MICHIGAN":"michigan",
    "MONTANA":"montana",
    "NEBRASKA":"nebraska",
    "NEWYORKEVE":"newyork-eve",
    "NEWYORKMID":"newyork-mid",
    "NIPPON LOTTO":"nippon-lotto",
    "OHIO":"ohio",
    "OREGON12":"oregon12",
    "OREGON03":"oregon3",
    "OREGON06":"oregon6",
    "OREGON09":"oregon9",
    "OSAKA":"osaka",
    "PANAMA":"panama",
    "PARIS":"paris",
    "PARMA":"parma",
    "ROMA":"roma",
    "RUSIA":"rusia",
    "SAPPORO EVE":"sapporo-eve",
    "SAPPORO":"sapporo-mid",
    "SINGAPORE":"singapore",
    "SYDNEY":"sydney",
    "TAIPEI LOTTO":"taipei-lotto",
    "THAILAND":"thailand",
    "TIONGKOK 4D":"tiongkok-4D",
    "TURKEY":"turkey",
    "TOTOMACAU-13":"totomacau-13",
    "TOTOMACAU-16":"totomacau-16",
    "TOTOMACAU-19":"totomacau-19",
    "TOTOMACAU-22":"totomacau-22",
    "TOTOMACAU-23":"totomacau-23",
    "TOTOMACAU-00":"totomacau-00",
    "TOTOMACAU-15-5D":"totomacau-15-5d",
    "TOTOMACAU-21-5D":"totomacau-21-5d",
    "CANADA POOLS":"canada",
    "CANADA POOL":"canada",
    "CANADA":"canada",
    "ARIZONA POOLS":"arizona",
    "ARIZONA POOL":"arizona",
    "ARIZONA":"arizona",
    "BRAZIL LOTTO":"brazil",
    "BRAZIL":"brazil",
    "JAKARTA LOTTO":"jakarta",
    "JAKARTA":"jakarta",
    "MANILA LOTTO":"manila",
    "MANILA":"manila",
    "BALI LOTTO":"bali",
    "BALI":"bali",    
  };
  return map[market.toUpperCase()] || null;
}

function sendToPanelZInternal_(rawText, panelCfg) {
  try {
    Logger.log("=== PANEL Z START ===");

    if (!rawText) {
      return "rawText kosong atau undefined";
    }

    const marketMatch = rawText.match(/Pasaran\s+(.+)/i) || rawText.match(/Hasil Pengeluaran Pasaran\s+(.+)/i);
    const prize1Match = rawText.match(/Prize\s*1[^\d]*(\d{4})/i) || rawText.match(/Prize\s*1\s*[:\-]?\s*(\d+)/i);

    if (!marketMatch) {
      return "Pasaran tidak ditemukan";
    }

    if (!prize1Match) {
      return { success: false, message: "Prize 1 tidak ditemukan dalam format teks" };
    }

    const market = marketMatch[1].trim().toUpperCase();
    const prize1 = prize1Match[1];

    const pasaranMatch = rawText.match(/Pasaran\s+([^\n\r]+)/i);
    const pasaranName = pasaranMatch ? pasaranMatch[1].trim() : "";

    const sessionCookie = loginPanelZInternal_(panelCfg);

    if (typeof sessionCookie === "string" && sessionCookie.startsWith("Error:")) {
      return sessionCookie;
    }

    const rowId = getPanelRowAutoInternal_(sessionCookie, panelCfg, market);

    if (!rowId) {
      return "Row tidak ditemukan : " + market;
    }

    Logger.log("MARKET = " + market);
    Logger.log("ROW ID = " + rowId);
    Logger.log("PRIZE1 = " + prize1);

    const response = UrlFetchApp.fetch(
      panelCfg.URL + "/config/update-resultlotto.php?row=" + rowId,
      {
        method: "post",
        headers: {
          Authorization: sessionCookie.basicAuth,
          Cookie: sessionCookie.cookie
        },
        payload: { updangka: prize1 },
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log("PANEL CODE = " + code);

    if (code === 200 || code === 302) {
      return "Terkirim";
    }

    return "Gagal (" + code + ")";
  } catch (e) {
    Logger.log("PANEL Z ERROR = " + e);
    return "Error: " + e.message;
  }
}

function sendTotomacauToPanelZInternal_(market, angka, username) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName("Users");
  const userData = userSheet.getDataRange().getValues();

  let websites = [];

  for(let i = 1; i < userData.length; i++) {
    if(userData[i][0] == username) {
      websites = String(userData[i][2])
        .split(",")
        .map(x => x.trim());
      break;
    }
  }

  let lastResult = "";

  for(const website of websites) {
    const acc = getAkunByWebsiteInternal_(website);
    if(!acc) continue;

    lastResult = sendCustomPanelZInternal_(market, angka, acc.PANELZ);
  }

  return lastResult || "Website tidak ditemukan";
}

function sendCustomPanelZInternal_(market, angka, panelCfg) {
  try {
    const session = loginPanelZInternal_(panelCfg);

    if(typeof session === "string") {
      return session;
    }

    const rowId = getPanelRowAutoInternal_(session, panelCfg, market);

    if(!rowId) {
      return "Row tidak ditemukan";
    }

    Logger.log("=== CUSTOM PANEL ===");
    Logger.log("MARKET = " + market);
    Logger.log("ANGKA = " + angka);
    Logger.log("ROW ID = " + rowId);
    
    const response = UrlFetchApp.fetch(
      panelCfg.URL + "/config/update-resultlotto.php?row=" + rowId,
      {
        method:"post",
        headers:{
          Authorization: session.basicAuth,
          Cookie: session.cookie
        },
        payload:{ updangka: angka },
        muteHttpExceptions:true
      }
    );

    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log("CUSTOM PANEL CODE = " + code);

    if(code == 200 || code == 302) {
      return "Berhasil dikirim";
    }

    return "Gagal (" + code + ")";
  } catch(e) {
    return "Error : " + e.message;
  }
}

function sendToPanelZOnlyInternal_(market, angka, currentUser) {
  const result = sendTotomacauToPanelZInternal_(market, angka, currentUser);
  const success = result.indexOf("Berhasil") > -1;

  logActivity_(
    currentUser,
    "SEND PANEL-Z",
    `Pasaran: ${market} | Hasil: ${result}`,
    success ? "BERHASIL" : "GAGAL",
    `Angka yang dikirim: ${angka}`
  );

  return {
    success: success,
    message: result
  };
}