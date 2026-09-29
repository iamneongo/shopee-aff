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

const BG_SEL = [
  "img.sesl-puzzle-bg",
  "[class*='puzzle-bg'] img",
  "[class*='puzzle-bg']",
  "[class*='captcha-bg'] img",
  "[class*='verify-panel'] img",
  // Shopee "Verify to Continue" page selectors
  "img.verify-bg-img",
  "[class*='verify-bg'] img",
  "[class*='verify-img'] img",
  "[class*='verify-img-block'] img",
  "[class*='img-bg'] img",
  "img[class*='bg-img']",
].join(", ");

const PIECE_SEL = [
  "img.sesl-puzzle-piece",
  "[class*='puzzle-piece'] img",
  "[class*='puzzle-piece']",
  "[class*='captcha-piece'] img",
  // Shopee "Verify to Continue" page selectors
  "[class*='verify-sub'] img",
  "[class*='sub-block'] img",
  "img.verify-piece-img",
  "[class*='move-piece']",
  "[class*='verify-piece']",
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
  // Shopee "Verify to Continue" page selectors
  "[class*='verify-move']",
  "[class*='move-block']",
  "[class*='drag-block']",
].join(", ");

const REFRESH_SEL = [
  "[class*='refresh']",
  "[class*='reload']",
  "[class*='captcha-refresh']",
  "[class*='verify-refresh']",
  "svg[class*='refresh']",
].join(", ");

// Nhấn nút refresh (↺) để lấy puzzle mới — dùng khi lần giải trước thất bại
async function clickRefreshCaptcha() {
  try {
    // thử selector trực tiếp
    const btn = await page.$(REFRESH_SEL).catch(() => null);
    if (btn) { await btn.click(); await sleep(2000); return true; }
    // fallback: duyệt DOM tìm phần tử có SVG rotate/refresh hoặc title/aria phù hợp
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, span, svg"));
      for (const el of candidates) {
        const cls = (el.className || "").toString().toLowerCase();
        const title = (el.title || el.getAttribute("aria-label") || "").toLowerCase();
        if (cls.includes("refresh") || cls.includes("reload") || title.includes("refresh") || title.includes("reload")) {
          const clickable = el.closest("button, [role='button']") || el;
          clickable.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (clicked) { await sleep(2000); return true; }
  } catch {}
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

// Tự động phát hiện và giải Shopee slider captcha.
// Thử tối đa maxRetries lần: mỗi lần thất bại → refresh puzzle → thử lại.
// Trả về { solved: bool, attempts: number, reason?: string }
async function solveCaptcha(maxRetries = 3) {
  if (!page) return { solved: false, reason: "no_page" };
  const apiKey = process.env.SADCAPTCHA_API_KEY || (fullCfg.sadcaptcha && fullCfg.sadcaptcha.apiKey);
  if (!apiKey) {
    console.log("[captcha] SADCAPTCHA_API_KEY chưa cấu hình — bỏ qua auto-solve.");
    return { solved: false, reason: "no_apikey" };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[captcha] === Lần thử ${attempt}/${maxRetries} ===`);
    try {
      // Nếu đang ở trang "Verification timed out" → quay lại captcha trước
      await handleVerifyTimeout();

      // Đợi captcha load (trang có thể đang navigate sau khi API trả 90309999)
      await page.waitForSelector(BG_SEL, { timeout: 6000 }).catch(() => {});

      let [bgHandle, pieceHandle, sliderHandle] = await Promise.all([
        page.$(BG_SEL).catch(() => null),
        page.$(PIECE_SEL).catch(() => null),
        page.$(SLIDER_SEL).catch(() => null),
      ]);

      // Fallback: captcha Shopee thường render bằng <canvas>, không phải <img>
      if (!bgHandle && /verify|captcha/i.test(page.url())) {
        // Ưu tiên canvas (Shopee "Verify to Continue" dùng canvas)
        const allCanvas = await page.$$("canvas").catch(() => []);
        const visibleCanvas = [];
        for (const c of allCanvas) {
          const box = await c.boundingBox().catch(() => null);
          if (box && box.width > 50 && box.height > 30) visibleCanvas.push({ img: c, area: box.width * box.height });
        }
        visibleCanvas.sort((a, b) => b.area - a.area);
        console.log(`[captcha] Fallback: ${allCanvas.length} canvas (${visibleCanvas.length} visible), page=${page.url().split("?")[0]}`);

        if (visibleCanvas.length >= 1) {
          bgHandle = visibleCanvas[0].img;
          pieceHandle = visibleCanvas.length >= 2 ? visibleCanvas[1].img : null;
          console.log(`[captcha] Dùng fallback canvas (bg=${visibleCanvas[0] && visibleCanvas[0].area}px²).`);
        } else {
          // Thử img nếu không có canvas
          const allImgs = await page.$$("img").catch(() => []);
          const visibleImgs = [];
          for (const img of allImgs) {
            const box = await img.boundingBox().catch(() => null);
            if (box && box.width > 50 && box.height > 30) visibleImgs.push({ img, area: box.width * box.height });
          }
          visibleImgs.sort((a, b) => b.area - a.area);
          console.log(`[captcha] Fallback: ${allImgs.length} img (${visibleImgs.length} visible).`);
          if (visibleImgs.length >= 1) {
            bgHandle = visibleImgs[0].img;
            pieceHandle = visibleImgs.length >= 2 ? visibleImgs[1].img : null;
            console.log(`[captcha] Dùng fallback img (bg=${visibleImgs[0] && visibleImgs[0].area}px²).`);
          }
        }
      }

      if (!bgHandle) {
        console.log(`[captcha] Không tìm thấy puzzle (url=${page.url()}) — không có captcha hoặc selector cần cập nhật.`);
        return { solved: false, reason: "captcha_not_found", attempts: attempt };
      }

      console.log("[captcha] Phát hiện puzzle, đang chụp ảnh...");
      const bgB64 = await bgHandle.screenshot({ encoding: "base64" }).catch(() => null);
      const pieceB64 = pieceHandle ? await pieceHandle.screenshot({ encoding: "base64" }).catch(() => null) : null;

      if (!bgB64) {
        console.log("[captcha] Chụp ảnh thất bại.");
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "screenshot_failed", attempts: attempt };
      }

      console.log("[captcha] Gọi SadCaptcha API...");
      let sadResult;
      try {
        sadResult = await callSadCaptchaApi(apiKey, bgB64, pieceB64);
      } catch (e) {
        console.error("[captcha] SadCaptcha API lỗi:", e.message);
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: e.message, attempts: attempt };
      }

      if (!sadResult || typeof sadResult.slideXPixels !== "number") {
        console.error("[captcha] SadCaptcha response không hợp lệ:", JSON.stringify(sadResult));
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "invalid_response", attempts: attempt };
      }

      if (!sliderHandle) {
        console.log("[captcha] Không tìm thấy slider handle.");
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "no_slider_handle", attempts: attempt };
      }
      const box = await sliderHandle.boundingBox().catch(() => null);
      if (!box) {
        console.log("[captcha] Slider không visible.");
        if (attempt < maxRetries) { await clickRefreshCaptcha(); continue; }
        return { solved: false, reason: "slider_not_visible", attempts: attempt };
      }

      const dist = sadResult.slideXPixels;
      console.log(`[captcha] Offset: ${dist}px — đang kéo slider...`);

      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

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

      // Kiểm tra kết quả
      const timedOut = await handleVerifyTimeout();
      const stillPresent = await page.$(BG_SEL).catch(() => null);

      if (!stillPresent && !timedOut) {
        console.log(`[captcha] ✅ Giải thành công lần ${attempt}!`);
        return { solved: true, slideXPixels: dist, attempts: attempt };
      }

      console.log(`[captcha] ⚠️ Lần ${attempt} thất bại${timedOut ? " (Shopee timeout)" : " (puzzle vẫn còn)"}.`);
      if (attempt < maxRetries) await clickRefreshCaptcha();

    } catch (e) {
      console.error(`[captcha] Lỗi lần ${attempt}:`, e.message);
      if (attempt < maxRetries) { await sleep(1500); await clickRefreshCaptcha(); }
    }
  }

  console.log(`[captcha] ❌ Thất bại sau ${maxRetries} lần.`);
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
