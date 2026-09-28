// Worker Puppeteer headless: lái một Chrome THẬT (TLS khớp Chrome, không dính
// fingerprint) đã đăng nhập Shopee. Gọi fetch trong trang → tạo link được.
// Không cần extension. Profile cố định giữ đăng nhập + fingerprint ổn định.
const path = require("path");
const fs = require("fs");
const https = require("https");
const { addExtra } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerCore = require("puppeteer-core");

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const SHOT = path.join(__dirname, "..", "worker-screen.png");
const START_URL = "https://affiliate.shopee.vn/offer/custom_link";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page = null;
let cfg = {};       // config.puppeteer
let fullCfg = {};   // toàn bộ config (cho sadcaptcha, notify,...)
let queue = Promise.resolve();
const state = { ready: false, loggedIn: false, lastError: null, headless: null };

// Chạy tuần tự để tránh nhiều thao tác page đè nhau
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return undefined;
}

// ===== Hàm chạy TRONG trang (self-contained) =====
function pageDo(action, params) {
  params = params || {};
  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  async function createLink(originalLink, subIds) {
    if (!originalLink) return { ok: false, code: "MISSING_LINK", error: "Thiếu originalLink." };
    const body = {
      operationName: "batchGetCustomLink",
      query:
        "query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }",
      variables: {
        linkParams: [{ originalLink: String(originalLink).trim(), advancedLinkParams: subIds || {} }],
        sourceCaller: "CUSTOM_LINK_CALLER",
      },
    };
    const res = await fetch("https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json; charset=UTF-8", "affiliate-program-type": "1", "csrf-token": getCsrf() },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const errCode = data && (data.error != null ? data.error : data.err_code);
    if (errCode) {
      if (errCode === 90309999) return { ok: false, code: "CAPTCHA", error: "Shopee yêu cầu xác thực CAPTCHA.", hint: "Admin cần vào noVNC giải captcha rồi tạo 1 link qua giao diện.", raw: data };
      return { ok: false, code: "SHOPEE_" + errCode, error: "Shopee trả lỗi: " + errCode + ".", raw: data };
    }
    const item = data && data.data && data.data.batchCustomLink && data.data.batchCustomLink[0];
    if (!item || (!item.shortLink && item.failCode != null)) {
      const fc = item && item.failCode;
      const FC_MSG = {
        1: "Link đã được chuyển đổi trước đó.",
        2: "URL không đúng định dạng Shopee. Dùng link trực tiếp từ shopee.vn (dạng https://shopee.vn/ten-san-pham.i.shopId.itemId).",
        3: "Shopee từ chối link: URL không hợp lệ, sản phẩm không trong chương trình affiliate, hoặc Sub_Id chứa ký tự không hợp lệ (chỉ [a-zA-Z0-9]).",
        4: "Vượt giới hạn tạo link của Shopee. Thử lại sau ít phút.",
      };
      return { ok: false, code: "SHOPEE_FAIL_" + fc, error: FC_MSG[fc] || ("Shopee từ chối tạo link (failCode " + fc + ")."), raw: data };
    }
    return { ok: true, shortLink: item.shortLink, longLink: item.longLink, raw: data };
  }
  async function getReport(o) {
    o = o || {};
    const now = Math.floor(Date.now() / 1000);
    const start = now - (o.days || 7) * 86400;
    const url = "https://affiliate.shopee.vn/api/v3/report/list?page_num=" + (o.pageNum || 1) +
      "&page_size=" + (o.pageSize || 50) + "&purchase_time_s=" + start + "&purchase_time_e=" + now + "&version=1";
    const res = await fetch(url, { credentials: "include", headers: { "affiliate-program-type": "1", "csrf-token": getCsrf() } });
    const data = await res.json().catch(() => ({}));
    const errCode = data && (data.error != null ? data.error : data.err_code);
    if (errCode) {
      if (errCode === 90309999) return { ok: false, code: "CAPTCHA", error: "Shopee yêu cầu xác thực CAPTCHA.", hint: "Admin cần vào noVNC giải captcha." };
      return { ok: false, code: "SHOPEE_" + errCode, error: "Shopee trả lỗi: " + errCode + "." };
    }
    const list = (data && data.data && data.data.list) || data.list || [];
    return { ok: true, total: list.length, list };
  }
  if (action === "createLink") return createLink(params.originalLink, params.subIds);
  if (action === "getReport") return getReport(params);
  return Promise.resolve({ ok: false, error: "Hành động không hợp lệ." });
}

// ===== SadCaptcha auto-solver =====

// Gọi SadCaptcha REST API để lấy pixel offset cần kéo
async function callSadCaptchaApi(apiKey, puzzleImageB64, pieceImageB64) {
  const body = JSON.stringify({ puzzleImageB64, pieceImageB64 });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "www.sadcaptcha.com",
        path: `/api/v1/shopeeSlider?licenseKey=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("SadCaptcha: response không hợp lệ: " + data.slice(0, 200))); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("SadCaptcha: timeout 30s")); });
    req.write(body);
    req.end();
  });
}

// Tự động phát hiện và giải Shopee slider captcha.
// Trả về { solved: bool, reason?: string, slideXPixels?: number }
async function solveCaptcha() {
  if (!page) return { solved: false, reason: "no_page" };
  const apiKey = fullCfg.sadcaptcha && fullCfg.sadcaptcha.apiKey;
  if (!apiKey) {
    console.log("[captcha] sadcaptcha.apiKey chưa cấu hình — bỏ qua auto-solve.");
    return { solved: false, reason: "no_apikey" };
  }

  try {
    // Phát hiện phần tử puzzle: background (ảnh đầy đủ có lỗ) + piece (mảnh cần ghép)
    // Shopee dùng nhiều class tên khác nhau qua các phiên bản, thử lần lượt
    const BG_SEL = [
      "img.sesl-puzzle-bg",
      "[class*='puzzle-bg'] img",
      "[class*='puzzle-bg']",
      "[class*='captcha-bg'] img",
      "[class*='verify-panel'] img",
    ].join(", ");

    const PIECE_SEL = [
      "img.sesl-puzzle-piece",
      "[class*='puzzle-piece'] img",
      "[class*='puzzle-piece']",
      "[class*='captcha-piece'] img",
    ].join(", ");

    const SLIDER_SEL = [
      ".sesl-slider-btn",
      "[class*='slider-btn']",
      "[class*='slide-btn']",
      "[class*='slider-handle']",
      "[class*='drag-btn']",
      "[class*='captcha-slide'] button",
      "[class*='verify'] button",
      "[class*='slider'] .btn",
    ].join(", ");

    const [bgHandle, pieceHandle, sliderHandle] = await Promise.all([
      page.$(BG_SEL).catch(() => null),
      page.$(PIECE_SEL).catch(() => null),
      page.$(SLIDER_SEL).catch(() => null),
    ]);

    if (!bgHandle) {
      console.log("[captcha] Không tìm thấy puzzle — không có captcha hoặc selector cần cập nhật.");
      return { solved: false, reason: "captcha_not_found" };
    }

    console.log("[captcha] Phát hiện slider captcha, đang chụp ảnh...");

    // Chụp từng element (đáng tin cậy hơn fetch URL vì tránh vấn đề CORS/auth)
    const bgB64 = await bgHandle.screenshot({ encoding: "base64" }).catch(() => null);
    const pieceB64 = pieceHandle ? await pieceHandle.screenshot({ encoding: "base64" }).catch(() => null) : null;

    if (!bgB64) return { solved: false, reason: "screenshot_failed" };

    console.log("[captcha] Gọi SadCaptcha API...");
    const sadResult = await callSadCaptchaApi(apiKey, bgB64, pieceB64);

    if (!sadResult || typeof sadResult.slideXPixels !== "number") {
      console.error("[captcha] SadCaptcha response không hợp lệ:", JSON.stringify(sadResult));
      return { solved: false, reason: "invalid_response", detail: sadResult };
    }

    const dist = sadResult.slideXPixels;
    console.log(`[captcha] Offset từ SadCaptcha: ${dist}px — đang kéo slider...`);

    if (!sliderHandle) return { solved: false, reason: "no_slider_handle" };
    const box = await sliderHandle.boundingBox().catch(() => null);
    if (!box) return { solved: false, reason: "slider_not_visible" };

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Kéo với chuyển động ease-in-out + nhiễu nhỏ để trông tự nhiên
    await page.mouse.move(startX, startY);
    await sleep(80 + Math.random() * 80);
    await page.mouse.down();
    await sleep(60 + Math.random() * 40);

    const STEPS = 35;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      await page.mouse.move(startX + dist * ease, startY + (Math.random() - 0.5) * 2);
      await sleep(6 + Math.random() * 10);
    }
    await page.mouse.move(startX + dist, startY);
    await sleep(120 + Math.random() * 80);
    await page.mouse.up();

    await sleep(2500);
    await saveShot();

    // Kiểm tra kết quả: nếu puzzle biến mất → đã giải xong
    const stillPresent = await page.$(BG_SEL).catch(() => null);
    const solved = !stillPresent;
    console.log(solved
      ? "[captcha] ✅ Giải thành công!"
      : "[captcha] ⚠️ Captcha vẫn còn — offset có thể sai hoặc cần thử lại.");
    return { solved, slideXPixels: dist };

  } catch (e) {
    console.error("[captcha] Lỗi auto-solve:", e.message);
    return { solved: false, reason: e.message };
  }
}

async function saveShot() {
  // Cửa sổ headful bị ẩn/minimize có thể làm page.screenshot() treo vô hạn
  // -> bọc timeout, ảnh chụp chỉ là tiện ích, tuyệt đối không được chặn luồng chính.
  try {
    await Promise.race([
      page.screenshot({ path: SHOT }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("shot timeout")), 4000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function refreshLogin() {
  try { state.loggedIn = await page.evaluate(() => /(?:^|;\s*)SPC_U=/.test(document.cookie)); }
  catch { state.loggedIn = false; }
  return state.loggedIn;
}

// Đảm bảo đang ở trang affiliate.shopee.vn + app đã load.
// Tự động giải captcha nếu Chrome bị redirect sang trang verify.
async function ensureOnApp() {
  const url = page.url();
  if (!/affiliate\.shopee\.vn/.test(url)) {
    // Nếu đang ở trang captcha/verify của Shopee → thử giải trước
    if (/shopee\.(vn|com)/i.test(url)) {
      const r = await solveCaptcha();
      if (r.solved) {
        await sleep(800);
        // Sau khi giải, Shopee có thể tự redirect về affiliate; nếu chưa thì navigate thủ công
        if (!/affiliate\.shopee\.vn/.test(page.url())) {
          await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        }
      } else {
        await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      }
    } else {
      await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
  }

  // Sau khi navigate, có thể vẫn bị captcha (ví dụ affiliate.shopee.vn redirect ngược về verify)
  if (!/affiliate\.shopee\.vn/.test(page.url())) {
    await solveCaptcha();
    await sleep(500);
    if (!/affiliate\.shopee\.vn/.test(page.url())) {
      await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
  }

  // đợi app cài hook fetch (tối đa ~8s), không bắt buộc
  await page.waitForFunction(() => window.__sap_hook_fetch === true, { timeout: 8000 }).catch(() => {});
  await refreshLogin();
}

async function callPage(action, params) {
  if (!page) return { ok: false, code: "WORKER_NOT_READY", error: "Worker chưa sẵn sàng.", hint: "Thử lại sau vài giây." };
  try { return await page.evaluate(pageDo, action, params || {}); }
  catch (e) {
    const msg = (e.message || "").split("\n")[0];
    if (/Failed to fetch/i.test(msg)) return { ok: false, code: "FETCH_ERROR", error: "Chrome không thể kết nối đến Shopee.", hint: "Gọi GET /api/worker/open-login để điều hướng lại, rồi thử lại." };
    if (/Execution context was destroyed/i.test(msg)) return { ok: false, code: "PAGE_NAVIGATED", error: "Trang bị điều hướng trong khi xử lý.", hint: "Thử lại ngay." };
    return { ok: false, code: "EVALUATE_ERROR", error: "Lỗi thực thi trong Chrome: " + msg };
  }
}

async function init(config) {
  fullCfg = config || {};
  cfg = (config && config.puppeteer) || {};

  if (cfg.connectURL) {
    // GẮN vào Chrome bạn tự mở (cổng debug) — cửa sổ do bạn mở nên hiển thị bình thường
    browser = await puppeteer.connect({ browserURL: cfg.connectURL, defaultViewport: null });
    state.connected = true;
    state.headless = false;
    const pages = await browser.pages();
    page = pages.find((p) => /affiliate\.shopee\.vn/.test(p.url())) || pages[0] || (await browser.newPage());
    if (!/affiliate\.shopee\.vn/.test(page.url())) {
      await page.goto(cfg.startUrl || START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
  } else {
    const executablePath = findChrome(cfg.executablePath);
    if (!executablePath) throw new Error("Không tìm thấy Chrome. Đặt config.puppeteer.executablePath hoặc CHROME_PATH.");
    const userDataDir = path.resolve(cfg.userDataDir || "./.chrome-profile");
    state.headless = cfg.headless !== false; // mặc định headless
    browser = await puppeteer.launch({
      headless: state.headless ? "new" : false,
      executablePath,
      userDataDir,
      defaultViewport: null,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu", "--disable-software-rasterizer",
        "--window-size=" + (cfg.windowSize || "1280,900"),
        "--window-position=" + (cfg.windowPosition || "60,40"),
        cfg.proxy ? "--proxy-server=" + cfg.proxy : "",
      ].filter(Boolean),
    });
    const pages = await browser.pages();
    page = pages[0] || (await browser.newPage());
    if (cfg.userAgent) await page.setUserAgent(cfg.userAgent);
    await page.bringToFront().catch(() => {});
    await page.goto(cfg.startUrl || START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }

  await page.waitForFunction(() => window.__sap_hook_fetch === true, { timeout: 8000 }).catch(() => {});
  await refreshLogin();
  await saveShot();
  state.ready = true;
  return getStatus();
}

function createLink(originalLink, subIds) {
  return enqueue(async () => {
    if (!state.ready) return { ok: false, code: "WORKER_NOT_READY", error: "Worker chưa khởi động.", hint: "Thử lại sau vài giây." };
    await ensureOnApp();
    if (!state.loggedIn) { await saveShot(); return { ok: false, code: "NOT_LOGGED_IN", error: "Chưa đăng nhập Shopee.", hint: "Admin cần đăng nhập lại qua noVNC tại /vnc.html." }; }

    let res = await callPage("createLink", { originalLink, subIds });

    // FETCH_ERROR: trang bị redirect sang captcha khi đang gọi API
    // CAPTCHA (90309999): API trả captcha flag — cả 2 trường hợp thử auto-solve rồi retry 1 lần
    if (res && (res.code === "CAPTCHA" || res.code === "FETCH_ERROR")) {
      state.lastError = "90309999";
      await saveShot();
      const solved = await solveCaptcha();
      if (solved.solved) {
        await ensureOnApp();
        res = await callPage("createLink", { originalLink, subIds });
        if (res && res.code === "CAPTCHA") state.lastError = "90309999";
      }
    }
    return res;
  });
}

function getReport(opts) {
  return enqueue(async () => {
    if (!state.ready) return { ok: false, code: "WORKER_NOT_READY", error: "Worker chưa khởi động.", hint: "Thử lại sau vài giây." };
    await ensureOnApp();
    if (!state.loggedIn) return { ok: false, code: "NOT_LOGGED_IN", error: "Chưa đăng nhập Shopee.", hint: "Admin cần đăng nhập lại qua noVNC." };
    return callPage("getReport", opts || {});
  });
}

function navigate(url) {
  return enqueue(async () => {
    if (!page) return { ok: false, error: "Worker chưa sẵn sàng." };
    try {
      await page.bringToFront().catch(() => {});
      await page.goto(url || START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await refreshLogin(); await saveShot();
      return { ok: true, url: page.url(), loggedIn: state.loggedIn };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

// Hiện mã QR đăng nhập để quét từ điện thoại (không cần thao tác cửa sổ Chrome)
function showQr() {
  return enqueue(async () => {
    if (!page) return { ok: false, error: "Worker chưa sẵn sàng." };
    try {
      if (!/affiliate\.shopee\.vn/.test(page.url())) {
        await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      }
      await sleep(1800);
      // tìm toạ độ phần tử "Log in with QR" rồi click bằng chuột thật
      const rect = await page.evaluate(() => {
        const els = Array.prototype.slice.call(document.querySelectorAll("div,button,span,a,img"));
        const t = els.find((e) => /log in with qr|đăng nhập.*qr|qr code/i.test((e.textContent || "").trim()));
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }).catch(() => null);
      if (rect) {
        try { await page.mouse.click(rect.x, rect.y); } catch (_) {}
      }
      await sleep(3000);
      await refreshLogin();
      await saveShot();
      return { ok: true, loggedIn: state.loggedIn, url: page.url() };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

function snapshot() {
  return enqueue(async () => {
    if (!page) return { ok: false, error: "Worker chưa sẵn sàng." };
    await refreshLogin(); const ok = await saveShot();
    return { ok, loggedIn: state.loggedIn, url: page.url() };
  });
}

function getStatus() {
  return { ready: state.ready, loggedIn: state.loggedIn, headless: state.headless, lastError: state.lastError, shot: fs.existsSync(SHOT) };
}

async function shutdown() {
  try { if (browser) { if (state.connected) await browser.disconnect(); else await browser.close(); } } catch {}
  browser = null; page = null; state.ready = false;
}

module.exports = { init, createLink, getReport, navigate, snapshot, showQr, getStatus, shutdown, SHOT };
