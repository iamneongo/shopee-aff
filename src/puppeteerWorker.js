// Worker Puppeteer headless: lái một Chrome THẬT (TLS khớp Chrome, không dính
// fingerprint) đã đăng nhập Shopee. Gọi fetch trong trang → tạo link được.
// Không cần extension. Profile cố định giữ đăng nhập + fingerprint ổn định.
const path = require("path");
const fs = require("fs");
const https = require("https");
const proxyManager = require("./proxyManager");
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
// Dựa trên shopee-captcha-solver v0.2.2 (PyPI):
//   - Endpoint: /api/v1/puzzle  → response: { slideXProportion: float (0-1) }
//   - Ảnh lấy từ img.src (data:image/png;base64,...), KHÔNG chụp màn hình
//   - Phải kéo slider 10px trước khi capture (piece mới hiện ra)
//   - Selectors: img[draggable=false] = bg, img[draggable=true] = piece
//   - Slider button: div[style*="transform: translateX(0px)"] hoặc tương tự

async function callSadCaptchaApiPuzzle(apiKey, puzzleImageB64, pieceImageB64) {
  const body = JSON.stringify({ puzzleImageB64, pieceImageB64 });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "www.sadcaptcha.com",
        path: `/api/v1/puzzle?licenseKey=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch { reject(new Error(`SadCaptcha: parse lỗi (${res.statusCode}): ${raw.slice(0, 300)}`)); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("SadCaptcha: timeout 30s")); });
    req.write(body);
    req.end();
  });
}

// Dump DOM info để debug selector
async function inspectCaptchaDOM() {
  return page.evaluate(() => {
    const info = { url: location.href.split("?")[0], imgs: [], canvases: [], sliders: [] };
    document.querySelectorAll("img").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 10 && r.height < 10) return;
      info.imgs.push({
        id: el.id, cls: (el.className || "").toString().slice(0, 80),
        draggable: el.draggable, isDataUrl: el.src.startsWith("data:"),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    });
    document.querySelectorAll("canvas").forEach(el => {
      const r = el.getBoundingClientRect();
      info.canvases.push({ id: el.id, cls: (el.className || "").toString().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) });
    });
    document.querySelectorAll("[style*='transform']").forEach(el => {
      const s = el.getAttribute("style") || "";
      if (!s.includes("translateX")) return;
      const r = el.getBoundingClientRect();
      info.sliders.push({ tag: el.tagName, id: el.id, cls: (el.className || "").toString().slice(0, 60), style: s.slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return info;
  }).catch(() => null);
}

// Lấy base64 ảnh bg + piece từ img.src (data URL) — dùng sau khi đã drag 10px
async function getImagesFromPageDOM() {
  return page.evaluate(() => {
    // Ưu tiên img[draggable=false/true] theo đúng library SadCaptcha
    let bgEl = document.querySelector("aside[aria-modal=true] img[draggable=false]")
            || document.querySelector("img[draggable=false]");
    let pieceEl = document.querySelector("aside[aria-modal=true] img[draggable=true]")
               || document.querySelector("img[draggable=true]");

    // Fallback: lấy 2 ảnh lớn nhất (loại bỏ logo/icon)
    if (!bgEl || !bgEl.src.startsWith("data:")) {
      const imgs = Array.from(document.querySelectorAll("img"))
        .filter(img => img.src.startsWith("data:") && img.getBoundingClientRect().width > 50)
        .sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height);
        });
      if (imgs.length > 0) bgEl = imgs[0];
      if (imgs.length > 1) pieceEl = imgs[1];
    }

    const bgSrc = bgEl && bgEl.src.startsWith("data:") ? bgEl.src : null;
    const pieceSrc = pieceEl && pieceEl.src.startsWith("data:") ? pieceEl.src : null;
    const bgBox = bgEl ? bgEl.getBoundingClientRect() : null;

    return {
      bg: bgSrc ? bgSrc.split(",")[1] : null,
      piece: pieceSrc ? pieceSrc.split(",")[1] : null,
      bgWidth: bgBox ? bgBox.width : 0,
    };
  }).catch(() => ({ bg: null, piece: null, bgWidth: 0 }));
}

// Tìm slider button theo thứ tự ưu tiên
async function findSliderButton() {
  const SLIDER_SELS = [
    // SadCaptcha library chính thức (modal)
    'aside[aria-modal=true] div[style*="width: 40px"][style*="height: 40px"]',
    // Standalone verify/captcha page — dạng transform translateX
    'div[style*="transform: translateX(0px)"]',
    // Generic
    '[class*="slider-btn"]', '[class*="slide-btn"]', '[class*="drag-btn"]',
    '[class*="verify-move"]', '[class*="move-block"]',
    // Fallback: bất kỳ div 30-60px có cursor pointer
  ];
  for (const sel of SLIDER_SELS) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width >= 20 && box.height >= 20) {
      console.log(`[captcha] Slider button tìm thấy: "${sel}" box=${JSON.stringify(box)}`);
      return { el, box };
    }
  }
  // Fallback cuối: tìm qua evaluate
  const result = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("div, button"))
      .filter(el => {
        const s = el.getAttribute("style") || "";
        const r = el.getBoundingClientRect();
        return (s.includes("transform") || s.includes("cursor")) && r.width >= 20 && r.width <= 80 && r.height >= 20 && r.height <= 80 && r.x > 0;
      });
    if (!candidates.length) return null;
    const el = candidates[0];
    const r = el.getBoundingClientRect();
    return { cls: el.className.toString().slice(0, 80), style: (el.getAttribute("style") || "").slice(0, 80), x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  if (result) console.log("[captcha] Slider fallback từ evaluate:", JSON.stringify(result));
  return null;
}

// Nhấn nút refresh ↺
async function clickRefreshCaptcha() {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("*"));
    for (const el of candidates) {
      const cls = (el.className || "").toString().toLowerCase();
      const label = (el.getAttribute("aria-label") || el.title || "").toLowerCase();
      if (cls.includes("refresh") || cls.includes("reload") || label.includes("refresh")) {
        (el.closest("button, [role='button']") || el).click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
  if (clicked) { await sleep(2000); return true; }
  console.log("[captcha] Không tìm thấy nút refresh ↺.");
  return false;
}

// Xử lý trang "Verification timed out" — click Go Back để quay lại trang captcha
async function handleVerifyTimeout() {
  const isTimeout = await page.evaluate(() =>
    /Verification timed out/i.test(document.body ? document.body.innerText : "")
  ).catch(() => false);
  if (!isTimeout) return false;
  console.log("[captcha] Phát hiện 'Verification timed out' — đang quay lại...");
  const wentBack = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => /go back/i.test(b.textContent || ""));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (!wentBack) await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await sleep(2000);
  // Nếu goBack đưa về about:blank (không có lịch sử), navigate thẳng về shopee.vn
  if (/^about:|^chrome:/.test(page.url())) {
    console.log("[captcha] goBack về about:blank — navigate thẳng về shopee.vn...");
    await page.goto("https://shopee.vn", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(3000);
  }
  return true;
}

// Tự động giải Shopee slider captcha.
// Theo đúng flow của shopee-captcha-solver library:
//   1. Tìm slider button → drag 10px (piece mới hiện ra)
//   2. Lấy ảnh bg+piece từ img.src (data URL) — KHÔNG screenshot
//   3. Gọi /api/v1/puzzle → slideXProportion (0-1)
//   4. dist = slideXProportion × bgWidth; tiếp tục kéo từ 10px đến dist
async function solveCaptcha(maxRetries = 3) {
  if (!page) return { solved: false, reason: "no_page" };
  const apiKey = process.env.SADCAPTCHA_API_KEY || (fullCfg.sadcaptcha && fullCfg.sadcaptcha.apiKey);
  if (!apiKey) {
    console.log("[captcha] SADCAPTCHA_API_KEY chưa cấu hình.");
    return { solved: false, reason: "no_apikey" };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[captcha] === Lần thử ${attempt}/${maxRetries} (url=${page.url().split("?")[0]}) ===`);
    try {
      await handleVerifyTimeout();
      await sleep(2000); // đợi page render xong

      // Dump DOM để debug
      const dom = await inspectCaptchaDOM();
      if (dom) console.log("[captcha] DOM:", JSON.stringify(dom).slice(0, 600));

      // Tìm slider button
      const slider = await findSliderButton();
      if (!slider) {
        console.log("[captcha] Không tìm thấy slider → captcha chưa load hoặc không có captcha.");
        // Thử fallback: screenshot toàn trang để chuẩn đoán
        if (attempt === 1) await saveShot();
        // Nếu không có slider, có thể page chưa redirect, chờ thêm
        if (attempt < maxRetries) { await sleep(3000); continue; }
        return { solved: false, reason: "no_slider", attempts: attempt };
      }

      const { box: sliderBox } = slider;
      const startX = sliderBox.x + sliderBox.width / 2;
      const startY = sliderBox.y + sliderBox.height / 2;

      // Bước 1: Kéo 10px để piece xuất hiện (per library)
      await page.mouse.move(startX, startY);
      await sleep(80 + Math.random() * 60);
      await page.mouse.down();
      await sleep(100);
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(startX + i, startY + Math.log(1 + i) * 0.3);
        await sleep(40 + Math.random() * 20);
      }
      console.log("[captcha] Đã kéo 10px — lấy ảnh từ img.src...");

      // Bước 2: Lấy ảnh từ DOM (src attribute = data URL)
      const imgs = await getImagesFromPageDOM();
      console.log(`[captcha] Ảnh: bg=${imgs.bg ? imgs.bg.length + "chars" : "null"}, piece=${imgs.piece ? imgs.piece.length + "chars" : "null"}, bgWidth=${imgs.bgWidth}`);

      // Fallback nếu không có data URL: chụp màn hình phần tử
      let bgB64 = imgs.bg;
      let pieceB64 = imgs.piece;
      let bgWidth = imgs.bgWidth;

      if (!bgB64) {
        console.log("[captcha] Không có data URL — thử screenshot element...");
        // Tìm img lớn nhất trên trang
        const allImgs = await page.$$("img").catch(() => []);
        let bestEl = null, bestArea = 0;
        for (const img of allImgs) {
          const box = await img.boundingBox().catch(() => null);
          if (box && box.width * box.height > bestArea) { bestArea = box.width * box.height; bestEl = img; bgWidth = box.width; }
        }
        // Thử canvas
        const allCanvas = await page.$$("canvas").catch(() => []);
        for (const c of allCanvas) {
          const box = await c.boundingBox().catch(() => null);
          if (box && box.width * box.height > bestArea) { bestArea = box.width * box.height; bestEl = c; bgWidth = box.width; }
        }
        if (bestEl) {
          bgB64 = await bestEl.screenshot({ encoding: "base64" }).catch(() => null);
          console.log(`[captcha] Fallback screenshot: area=${bestArea}, bgWidth=${bgWidth}`);
        }
      }

      if (!bgB64) {
        await page.mouse.up().catch(() => {});
        console.log("[captcha] Không lấy được ảnh background.");
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "no_bg_image", attempts: attempt };
      }

      // Bước 3: Gọi SadCaptcha /api/v1/puzzle
      console.log("[captcha] Gọi SadCaptcha /api/v1/puzzle...");
      let apiResp;
      try {
        apiResp = await callSadCaptchaApiPuzzle(apiKey, bgB64, pieceB64);
      } catch (e) {
        await page.mouse.up().catch(() => {});
        console.error("[captcha] SadCaptcha API lỗi:", e.message);
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: e.message, attempts: attempt };
      }

      const { status, data: sadResult } = apiResp;
      console.log(`[captcha] SadCaptcha response (${status}):`, JSON.stringify(sadResult));

      if (status !== 200 || !sadResult || typeof sadResult.slideXProportion !== "number") {
        await page.mouse.up().catch(() => {});
        console.error("[captcha] Response không hợp lệ:", status, JSON.stringify(sadResult));
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "invalid_response", attempts: attempt };
      }

      // Bước 4: Tính pixel dist và kéo đến đích
      // bgWidth = chiều rộng ảnh background (slide bar dài bằng ảnh)
      const slideBarWidth = bgWidth || 270; // fallback 270px nếu không có
      const dist = Math.round(sadResult.slideXProportion * slideBarWidth);
      console.log(`[captcha] slideXProportion=${sadResult.slideXProportion}, barWidth=${slideBarWidth}, dist=${dist}px`);

      for (let i = 10; i <= dist; i += 2) {
        await page.mouse.move(startX + i, startY + Math.log(1 + i) * 0.2);
        await sleep(15 + Math.random() * 8);
      }
      // Overshoot nhẹ rồi về
      await page.mouse.move(startX + dist + 3, startY);
      await sleep(60);
      await page.mouse.move(startX + dist, startY);
      await sleep(150 + Math.random() * 80);
      await page.mouse.up();

      await sleep(2500);
      await saveShot();

      // Kiểm tra kết quả
      await handleVerifyTimeout();
      const stillOnCaptcha = /verify|captcha/i.test(page.url());
      if (!stillOnCaptcha) {
        console.log(`[captcha] ✅ Giải thành công lần ${attempt}! (slideXProportion=${sadResult.slideXProportion})`);
        return { solved: true, slideXProportion: sadResult.slideXProportion, attempts: attempt };
      }

      console.log(`[captcha] ⚠️ Lần ${attempt} thất bại — vẫn ở captcha page.`);
      if (attempt < maxRetries) await clickRefreshCaptcha();

    } catch (e) {
      console.error(`[captcha] Lỗi lần ${attempt}:`, e.message);
      await page.mouse.up().catch(() => {});
      if (attempt < maxRetries) { await sleep(1500); await clickRefreshCaptcha(); }
    }
  }

  console.log("[captcha] ❌ Thất bại sau", maxRetries, "lần.");
  return { solved: false, reason: "max_retries_exceeded", attempts: maxRetries };
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

    // Xóa SingletonLock nếu còn lại từ lần container shutdown trước (gây Code:21)
    for (const lockPath of [
      path.join(userDataDir, "SingletonLock"),
      path.join(userDataDir, "SingletonCookie"),
      path.join(userDataDir, "SingletonSocket"),
    ]) {
      try { if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); console.log("[init] Đã xóa:", lockPath); } } catch {}
    }

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

function isCaptchaError(res) {
  return res && (res.code === "CAPTCHA" || res.code === "FETCH_ERROR");
}

async function autoRecoverAndRetry(originalLink, subIds) {
  state.lastError = "90309999";
  await saveShot();

  // 90309999 là rate-limit/anti-bot ở API level — đợi vài giây rồi thử lại.
  // Nếu trang bị redirect sang verify/captcha thì solveCaptcha xử lý.
  console.log("[worker] CAPTCHA/anti-bot từ Shopee — chờ 5s rồi retry...");
  await sleep(5000);
  await ensureOnApp();
  const retryRes = await callPage("createLink", { originalLink, subIds });
  if (!isCaptchaError(retryRes)) return retryRes;

  // Nếu có captcha UI (trang bị redirect sang verify/captcha), thử giải tự động
  if (/verify|captcha/i.test(page.url())) {
    console.log("[worker] Phát hiện trang verify — thử giải captcha...");
    const captchaResult = await solveCaptcha();
    if (captchaResult.solved) {
      await ensureOnApp();
      const res = await callPage("createLink", { originalLink, subIds });
      if (!isCaptchaError(res)) return res;
    }
  }

  // Không giải được → trả lỗi (session vẫn giữ nguyên, không rotate proxy)
  console.log("[worker] Không giải được CAPTCHA — trả lỗi, giữ session.");
  return { ok: false, code: "CAPTCHA", error: "Shopee yêu cầu xác thực CAPTCHA.", hint: "Admin vào noVNC tại https://shopee-vnc.apps.neooi.com để giải captcha thủ công rồi thử lại." };
}

function createLink(originalLink, subIds) {
  return enqueue(async () => {
    if (!state.ready) return { ok: false, code: "WORKER_NOT_READY", error: "Worker chưa khởi động.", hint: "Thử lại sau vài giây." };
    await ensureOnApp();
    if (!state.loggedIn) { await saveShot(); return { ok: false, code: "NOT_LOGGED_IN", error: "Chưa đăng nhập Shopee.", hint: "Admin cần đăng nhập lại qua noVNC tại /vnc.html." }; }

    const res = await callPage("createLink", { originalLink, subIds });
    if (!isCaptchaError(res)) return res;

    // Tự động phục hồi: chờ, retry, thử giải captcha nếu có UI
    return autoRecoverAndRetry(originalLink, subIds);
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

// Khởi động lại Chrome với proxy mới (hoặc không proxy nếu proxyUrl = null)
async function restartWithProxy(proxyUrl) {
  console.log("[worker] Khởi động lại Chrome với proxy:", proxyUrl || "(không proxy)");
  await shutdown();
  const newConfig = JSON.parse(JSON.stringify(fullCfg));
  if (!newConfig.puppeteer) newConfig.puppeteer = {};
  newConfig.puppeteer.proxy = proxyUrl || "";
  await init(newConfig);
  return getStatus();
}

module.exports = { init, createLink, getReport, navigate, snapshot, showQr, getStatus, shutdown, restartWithProxy, SHOT };
