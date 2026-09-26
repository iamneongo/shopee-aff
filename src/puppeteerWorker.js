// Worker Puppeteer headless: lái một Chrome THẬT (TLS khớp Chrome, không dính
// fingerprint) đã đăng nhập Shopee. Gọi fetch trong trang → tạo link được.
// Không cần extension. Profile cố định giữ đăng nhập + fingerprint ổn định.
const path = require("path");
const fs = require("fs");
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
let cfg = {};
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
    if (!originalLink) return { ok: false, error: "Thiếu link gốc." };
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
    if (errCode) return { ok: false, code: errCode, error: "Shopee lỗi " + errCode, raw: data };
    const item = data && data.data && data.data.batchCustomLink && data.data.batchCustomLink[0];
    if (!item || (!item.shortLink && item.failCode)) return { ok: false, error: "Không tạo được link (failCode " + (item && item.failCode) + ").", raw: data };
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
    if (errCode) return { ok: false, code: errCode, error: "Shopee lỗi " + errCode };
    const list = (data && data.data && data.data.list) || data.list || [];
    return { ok: true, total: list.length, list };
  }
  if (action === "createLink") return createLink(params.originalLink, params.subIds);
  if (action === "getReport") return getReport(params);
  return Promise.resolve({ ok: false, error: "Hành động không hợp lệ." });
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

// Đảm bảo đang ở trang shopee + app đã load (hook sẵn sàng)
async function ensureOnApp() {
  const url = page.url();
  if (!/affiliate\.shopee\.vn/.test(url)) {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  // đợi app cài hook fetch (tối đa ~8s), không bắt buộc
  await page.waitForFunction(() => window.__sap_hook_fetch === true, { timeout: 8000 }).catch(() => {});
  await refreshLogin();
}

async function callPage(action, params) {
  if (!page) return { ok: false, error: "Worker chưa sẵn sàng." };
  try { return await page.evaluate(pageDo, action, params || {}); }
  catch (e) { return { ok: false, error: "evaluate lỗi: " + e.message }; }
}

async function init(config) {
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
    if (!state.ready) return { ok: false, error: "Worker chưa khởi động." };
    await ensureOnApp();
    if (!state.loggedIn) { await saveShot(); return { ok: false, error: "Chưa đăng nhập Shopee. Gọi /api/worker/open-login rồi đăng nhập (headful/VNC)." }; }
    const res = await callPage("createLink", { originalLink, subIds });
    if (res && res.code === 90309999) { state.lastError = "90309999"; await saveShot(); }
    return res;
  });
}

function getReport(opts) {
  return enqueue(async () => {
    if (!state.ready) return { ok: false, error: "Worker chưa khởi động." };
    await ensureOnApp();
    if (!state.loggedIn) return { ok: false, error: "Chưa đăng nhập Shopee." };
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
