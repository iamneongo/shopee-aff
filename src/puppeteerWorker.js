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
// Port trung thực từ shopee-captcha-solver extension v3.0.2. Shopee có 2 loại:
//   1. PUZZLE  (aside[aria-modal]): puzzle slide đơn giản.
//        → /api/v1/puzzle  { puzzleImageB64, pieceImageB64 } → { slideXProportion }
//        → dist = puzzleWidth × slideXProportion. Ảnh là <img> (dùng .src data URL).
//   2. IMAGE_CRAWL (#NEW_CAPTCHA): piece "bò" theo quỹ đạo cong khi kéo slider.
//        Ảnh là <canvas> (dùng .toDataURL()). Cần 2 bước API + quét quỹ đạo:
//        a) /api/v1/shopee-image-crawl-pre-analyze { image_b64 }
//             → { slideXProportion, skipRecommended }
//        b) Giữ chuột, quét slider từ 0→85% ghi lại quỹ đạo piece (vị trí + góc xoay)
//        c) /api/v1/shopee-image-crawl { puzzle_image_b64, piece_image_b64,
//             slide_piece_trajectory } → { pixelsFromSliderOrigin }
//             → thả slider tại buttonCenter.x + pixelsFromSliderOrigin.
// Dùng page.mouse của Puppeteer = input qua CDP (isTrusted=true), không cần extension.

// Selector Image Crawl (theo extension, có fallback nhiều lớp)
const IC_SEL = {
  bg: "#NEW_CAPTCHA canvas[draggable=false], aside canvas[draggable=false], div:not(#puzzleContainer) > img",
  piece: "#NEW_CAPTCHA canvas[draggable=true], aside canvas[draggable=true], #puzzleContainer > #puzzleImgComponent",
  reset: "#NEW_CAPTCHA svg[viewBox='0 0 16 16'], aside svg[viewBox='0 0 16 16']",
};
// Selector Puzzle slide
const PZ_SEL = {
  button: 'aside[aria-modal=true] div[style="width: 40px; height: 40px; transform: translateX(0px);"]',
  bg: "aside[aria-modal=true] div[aria-hidden=true] > div > div > img[draggable=false]",
  piece: "aside[aria-modal=true] div[aria-hidden=true] > div > div > img[draggable=true]",
};

const rnd = (a, b) => a + Math.random() * (b - a);

// POST JSON tới SadCaptcha, trả { status, data, raw } (không reject khi parse lỗi).
function sadPost(apiPath, apiKey, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "www.sadcaptcha.com",
        path: `${apiPath}?licenseKey=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data = null;
          try { data = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, data, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("SadCaptcha: timeout 30s")); });
    req.write(body);
    req.end();
  });
}

const callSadPuzzle = (apiKey, puzzleImageB64, pieceImageB64) =>
  sadPost("/api/v1/puzzle", apiKey, { puzzleImageB64, pieceImageB64 });
const callSadImageCrawlPreAnalyze = (apiKey, image_b64) =>
  sadPost("/api/v1/shopee-image-crawl-pre-analyze", apiKey, { image_b64 });
const callSadImageCrawl = (apiKey, req) =>
  sadPost("/api/v1/shopee-image-crawl", apiKey, req);

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

// Nhận diện loại captcha đang hiện (theo thứ tự extension: image_crawl trước, puzzle sau)
async function detectCaptchaType() {
  return page.evaluate((IC, PZ) => {
    const has = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
    if (has(IC.piece)) return "image_crawl";
    if (has(PZ.piece) || has("aside[aria-modal=true]")) return "puzzle";
    if (has("#NEW_CAPTCHA") || has("#captchaMask")) return "image_crawl";
    return null;
  }, IC_SEL, PZ_SEL).catch(() => null);
}

// Lấy base64 của <canvas> (toDataURL) hoặc <img> (src) theo selector
async function getElementB64(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    try {
      if (el.tagName === "CANVAS") return (el.toDataURL().split(",")[1]) || null;
      if (el.tagName === "IMG") {
        const s = el.src || "";
        return s.startsWith("data:") ? (s.split(",")[1] || null) : null;
      }
    } catch { return null; }
    return null;
  }, selector).catch(() => null);
}

// Lấy bounding box (viewport) của element đầu tiên khớp selector
async function getBox(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector).catch(() => null);
}

// Tìm nút kéo Image Crawl: div chứa trực tiếp 2 svg liền nhau (2 mũi tên). Chọn cái nhỏ nhất.
async function findImageCrawlButton() {
  return page.evaluate(() => {
    const sels = [
      "#NEW_CAPTCHA div:has(> svg + svg)",
      "aside div:has(> svg + svg)",
      "div:has(> svg + svg)",
    ];
    let best = null;
    for (const sel of sels) {
      let els;
      try { els = Array.from(document.querySelectorAll(sel)); } catch { continue; }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width >= 18 && r.width <= 100 && r.height >= 18 && r.height <= 100 && r.x > 0) {
          const area = r.width * r.height;
          if (!best || area < best.area) best = { x: r.x, y: r.y, w: r.width, h: r.height, area };
        }
      }
      if (best) break;
    }
    return best;
  }).catch(() => null);
}

// Bấm nút reset ↺ của Image Crawl và đợi ảnh puzzle đổi (captcha mới)
async function resetImageCrawl() {
  const box = await getBox(IC_SEL.reset);
  const before = await getElementB64(IC_SEL.bg);
  if (box) {
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(rnd(30, 90));
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  }
  // đợi tối đa 4s cho ảnh puzzle thay đổi
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const now = await getElementB64(IC_SEL.bg);
    if (now && now !== before) return true;
  }
  return false;
}

// Nếu trang đang ở trạng thái "Please Try Again Later" → bấm "Try Again" lấy captcha mới
async function clickTryAgain() {
  const clicked = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : "";
    if (!/try again|can't be completed|thử lại/i.test(txt)) return false;
    const btn = Array.from(document.querySelectorAll("button, [role='button']"))
      .find(b => /try again|thử lại/i.test(b.textContent || ""));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (clicked) { await sleep(3000); }
  return clicked;
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
  const result = await page.evaluate(() => {
    const isTimeout = /Verification timed out/i.test(document.body ? document.body.innerText : "");
    // Nếu captcha canvas đang active, không phải thực sự timeout
    const hasCaptchaCanvas = document.querySelectorAll("canvas").length > 0;
    return { isTimeout, hasCaptchaCanvas };
  }).catch(() => ({ isTimeout: false, hasCaptchaCanvas: false }));
  if (!result.isTimeout) return false;
  if (result.hasCaptchaCanvas) {
    console.log("[captcha] 'Verification timed out' text nhưng captcha canvas vẫn active — bỏ qua.");
    return false;
  }
  console.log("[captcha] Phát hiện 'Verification timed out' — đang quay lại...");
  const wentBack = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => /go back/i.test(b.textContent || ""));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (!wentBack) await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await sleep(2000);
  if (/^about:|^chrome:/.test(page.url())) {
    console.log("[captcha] goBack về about:blank — navigate về shopee.vn...");
    await page.goto("https://shopee.vn", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(3000);
  }
  return true;
}

// Kiểm tra captcha đã biến mất chưa (giải thành công)
async function captchaGone() {
  await handleVerifyTimeout();
  const stillOnVerify = /verify|captcha/i.test(page.url());
  const present = await page.evaluate(() => {
    const q = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
    return q("#NEW_CAPTCHA") || q("#captchaMask") || q("aside[aria-modal=true]");
  }).catch(() => false);
  return !stillOnVerify || !present;
}

// ===== Giải Image Crawl (#NEW_CAPTCHA) — piece bò theo quỹ đạo cong =====
async function solveImageCrawl(apiKey) {
  // Bước 1: ảnh puzzle (canvas) lúc nghỉ
  const puzzleB64 = await getElementB64(IC_SEL.bg);
  if (!puzzleB64) return { solved: false, reason: "ic_no_puzzle_image" };

  // Bước 2: pre-analyze → slideXProportion, skipRecommended
  let pre;
  try { pre = await callSadImageCrawlPreAnalyze(apiKey, puzzleB64); }
  catch (e) { return { solved: false, reason: "ic_preanalyze_err:" + e.message }; }
  console.log(`[captcha][ic] pre-analyze (${pre.status}):`, JSON.stringify(pre.data));
  const slideXProportion = pre.data && typeof pre.data.slideXProportion === "number"
    ? pre.data.slideXProportion : null;
  if (!pre.data || pre.status !== 200) {
    return { solved: false, reason: "ic_preanalyze_bad", retryFresh: true, detail: { status: pre.status, raw: (pre.raw || "").slice(0, 200) } };
  }
  if (pre.data.skipRecommended) {
    console.log("[captcha][ic] skipRecommended → reset lấy captcha khác");
    return { solved: false, reason: "ic_skip_recommended", retryFresh: true, detail: { slideXProportion } };
  }

  // Bước 3: ảnh piece (canvas) lúc nghỉ + box nút kéo + box puzzle
  const pieceB64 = await getElementB64(IC_SEL.piece);
  const btnBox = await findImageCrawlButton();
  const puzzleBox = await getBox(IC_SEL.bg);
  if (!pieceB64 || !btnBox || !puzzleBox) {
    return {
      solved: false,
      reason: `ic_missing(piece=${!!pieceB64},btn=${!!btnBox},bg=${!!puzzleBox})`,
      detail: { puzzleB64Len: puzzleB64 ? puzzleB64.length : 0, btnBox, puzzleBox, preStatus: pre.status },
    };
  }
  const cx = btnBox.x + btnBox.w / 2;
  const cy = btnBox.y + btnBox.h / 2;
  const limit = puzzleBox.w * 0.85;
  const mouseStep = 3;

  // Bước 4: giữ chuột, quét slider ghi lại quỹ đạo piece
  await page.mouse.move(cx - rnd(60, 90), cy + rnd(30, 50));
  await sleep(rnd(80, 160));
  await page.mouse.move(cx, cy);
  await sleep(rnd(80, 160));
  await page.mouse.down();
  await sleep(150); // PRESS_SETTLE

  const trajectory = [];
  let curPixel = 0, timesNotMoving = 0, stopPx = null, lastProp = null;
  try {
    for (let pixel = 0; pixel < limit; pixel += mouseStep) {
      await page.mouse.move(cx + pixel, cy);
      curPixel = pixel;
      await sleep(20); // SAMPLE_SETTLE
      const t = await page.evaluate((pieceSel, pbox, px) => {
        const el = document.querySelector(pieceSel);
        if (!el) return null;
        const style = el.getAttribute("style") || "";
        const m = style.match(/rotate\(([-0-9.]+)deg\)/i);
        const rot = m ? parseFloat(m[1]) : 0;
        const r = el.getBoundingClientRect();
        const pcx = r.x + r.width / 2, pcy = r.y + r.height / 2;
        return {
          pixels_from_slider_origin: px,
          piece_rotation_angle: rot,
          piece_center: {
            proportionX: Math.round((pcx - pbox.x) / pbox.w * 1e4) / 1e4,
            proportionY: Math.round((pcy - pbox.y) / pbox.h * 1e4) / 1e4,
          },
        };
      }, IC_SEL.piece, puzzleBox, pixel).catch(() => null);
      if (!t) continue;
      trajectory.push(t);

      // dừng sớm khi piece vượt tỉ lệ mục tiêu + overshoot 15px
      if (slideXProportion != null && t.piece_center.proportionX >= slideXProportion) {
        if (stopPx === null) stopPx = pixel;
        else if (pixel - stopPx >= 15) break;
      }
      // dừng khi piece đứng yên (đã chạm mép)
      if (trajectory.length >= 2) {
        if (t.piece_center.proportionX === lastProp) timesNotMoving++;
        else timesNotMoving = 0;
      }
      lastProp = t.piece_center.proportionX;
      if (trajectory.length > 33 && timesNotMoving >= 3) break;
    }
  } catch (e) {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: "ic_sweep_err:" + e.message };
  }
  console.log(`[captcha][ic] trajectory=${trajectory.length} điểm, curPixel=${curPixel}, limit=${Math.round(limit)}`);
  if (trajectory.length < 12) {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: "ic_short_trajectory", retryFresh: true };
  }

  // Bước 5: gọi /api/v1/shopee-image-crawl (chuột vẫn giữ)
  trajectory.sort((a, b) => a.pixels_from_slider_origin - b.pixels_from_slider_origin);
  let resp;
  try {
    resp = await callSadImageCrawl(apiKey, {
      puzzle_image_b64: puzzleB64,
      piece_image_b64: pieceB64,
      slide_piece_trajectory: trajectory,
    });
  } catch (e) {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: "ic_api_err:" + e.message };
  }
  console.log(`[captcha][ic] shopee-image-crawl (${resp.status}):`, JSON.stringify(resp.data));
  const solution = resp.data && resp.data.pixelsFromSliderOrigin;
  if (typeof solution !== "number") {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: "ic_invalid_solution", retryFresh: true, detail: { status: resp.status, raw: (resp.raw || "").slice(0, 200), traj: trajectory.length } };
  }

  // Bước 6: thả tại cx + solution (+ nhích nhỏ 0.5% theo extension)
  const releasePx = solution + 0.005 * limit;
  const from = curPixel, dist = releasePx - from;
  const steps = Math.max(12, Math.round(Math.abs(dist)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = (1 - Math.cos(t * Math.PI)) / 2;
    await page.mouse.move(cx + from + dist * eased, cy + rnd(-0.8, 0.8));
    await sleep(rnd(2, 6));
  }
  await sleep(rnd(600, 1400)); // pause trước khi thả (human-like)
  await page.mouse.move(cx + releasePx, cy);
  await sleep(rnd(400, 900));
  await page.mouse.up();
  console.log(`[captcha][ic] thả tại +${Math.round(releasePx)}px (solution=${solution})`);

  await sleep(3500);
  await saveShot();
  if (await captchaGone()) return { solved: true, type: "image_crawl", solution };
  return { solved: false, reason: "ic_still_present", retryFresh: true };
}

// ===== Giải Puzzle slide (aside[aria-modal]) =====
async function solvePuzzleType(apiKey) {
  const btnBox = await getBox(PZ_SEL.button);
  if (!btnBox) return { solved: false, reason: "pz_no_button", retryFresh: true };
  const cx = btnBox.x + btnBox.w / 2;
  const cy = btnBox.y + btnBox.h / 2;

  // giữ chuột + kéo trước 10px để piece hiện ra
  await page.mouse.move(cx, cy);
  await sleep(rnd(100, 180));
  await page.mouse.down();
  await sleep(rnd(100, 180));
  for (let i = 1; i < 10; i++) {
    await page.mouse.move(cx + i, cy - Math.log(i) + rnd(0, 3));
    await sleep(rnd(10, 15));
  }

  const puzzleB64 = await getElementB64(PZ_SEL.bg);
  const pieceB64 = await getElementB64(PZ_SEL.piece);
  const puzzleBox = await getBox(PZ_SEL.bg);
  if (!puzzleB64 || !pieceB64 || !puzzleBox) {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: `pz_missing(bg=${!!puzzleB64},piece=${!!pieceB64})`, retryFresh: true };
  }

  let resp;
  try { resp = await callSadPuzzle(apiKey, puzzleB64, pieceB64); }
  catch (e) { await page.mouse.up().catch(() => {}); return { solved: false, reason: "pz_api_err:" + e.message }; }
  console.log(`[captcha][pz] puzzle (${resp.status}):`, JSON.stringify(resp.data));
  const prop = resp.data && resp.data.slideXProportion;
  if (typeof prop !== "number") {
    await page.mouse.up().catch(() => {});
    return { solved: false, reason: "pz_invalid_response", retryFresh: true };
  }

  const distance = puzzleBox.w * prop; // theo computePuzzleSlideDistance
  for (let i = 10; i < distance; i += rnd(3, 8)) {
    await page.mouse.move(cx + i, cy - Math.log(i) + rnd(0, 3));
    await sleep(rnd(10, 15));
  }
  await sleep(rnd(100, 160));
  await page.mouse.move(cx + distance, cy);
  await sleep(rnd(100, 160));
  await page.mouse.up();
  console.log(`[captcha][pz] slideXProportion=${prop}, distance=${Math.round(distance)}px`);

  await sleep(3000);
  await saveShot();
  if (await captchaGone()) return { solved: true, type: "puzzle", slideXProportion: prop };
  return { solved: false, reason: "pz_still_present", retryFresh: true };
}

// Điều phối: nhận diện loại captcha rồi gọi solver tương ứng.
async function solveCaptcha(maxRetries = 3) {
  if (!page) return { solved: false, reason: "no_page" };
  const apiKey = process.env.SADCAPTCHA_API_KEY || (fullCfg.sadcaptcha && fullCfg.sadcaptcha.apiKey);
  if (!apiKey) {
    console.log("[captcha] SADCAPTCHA_API_KEY chưa cấu hình.");
    return { solved: false, reason: "no_apikey" };
  }

  const log = []; // chẩn đoán từng lần thử (trả về cho endpoint debug)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[captcha] === Lần thử ${attempt}/${maxRetries} (url=${page.url().split("?")[0]}) ===`);
    try {
      await handleVerifyTimeout();
      await clickTryAgain(); // thoát trạng thái "Please Try Again Later" nếu có

      // đợi PUZZLE THẬT render (canvas/img), không chỉ vỏ #NEW_CAPTCHA (tối đa ~12s)
      const hasRealPuzzle = await page.waitForFunction(() => {
        const q = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
        return q("#NEW_CAPTCHA canvas") || q("#puzzleImgComponent") || q(".DfwepB")
          || q("aside[aria-modal=true] img[draggable]");
      }, { timeout: 12000 }).then(() => true).catch(() => false);

      // Không có puzzle thật → kiểm tra soft-block ("Please Try Again Later")
      if (!hasRealPuzzle) {
        const soft = await page.evaluate(() => {
          const t = document.body ? document.body.innerText : "";
          return /try again|can't be completed|thử lại|later/i.test(t);
        }).catch(() => false);
        if (attempt === 1) await saveShot();
        if (soft) {
          console.log("[captcha] ⛔ Soft-block của Shopee (IP bị gắn cờ) — không có captcha thật để giải.");
          log.push({ attempt, type: "soft_block", reason: "soft_blocked" });
          return { solved: false, reason: "soft_blocked", attempts: attempt, log,
            hint: "Shopee soft-block IP này (thường do IP datacenter). Đăng nhập lại qua noVNC và/hoặc thêm proxy VN residential/4G." };
        }
      }
      await sleep(1000);

      const type = await detectCaptchaType();
      console.log(`[captcha] Loại captcha: ${type || "không rõ"}`);
      if (!type) {
        if (attempt === 1) await saveShot();
        log.push({ attempt, type: null, reason: "no_captcha" });
        if (attempt < maxRetries) { await sleep(2500); continue; }
        return { solved: false, reason: "no_captcha", attempts: attempt, log };
      }

      const r = type === "image_crawl"
        ? await solveImageCrawl(apiKey)
        : await solvePuzzleType(apiKey);
      log.push({ attempt, type, reason: r.reason || "solved", detail: r.detail });

      if (r.solved) {
        console.log(`[captcha] ✅ Giải thành công lần ${attempt} (type=${r.type}).`);
        return { ...r, attempts: attempt, log };
      }

      console.log(`[captcha] ⚠️ Lần ${attempt} thất bại: ${r.reason}`);
      if (attempt < maxRetries) {
        // lấy captcha mới: image_crawl bấm reset ↺, còn lại dùng refresh chung
        if (type === "image_crawl") await resetImageCrawl();
        else await clickRefreshCaptcha();
        await sleep(1200);
      }
    } catch (e) {
      console.error(`[captcha] Lỗi lần ${attempt}:`, e.message);
      log.push({ attempt, reason: "exception:" + e.message });
      await page.mouse.up().catch(() => {});
      if (attempt < maxRetries) { await sleep(1500); await resetImageCrawl().catch(() => {}); }
    }
  }

  console.log("[captcha] ❌ Thất bại sau", maxRetries, "lần.");
  return { solved: false, reason: "max_retries_exceeded", attempts: maxRetries, log };
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

// Gọi trực tiếp trình giải captcha để test (tùy chọn navigate tới URL verify trước).
function solveCaptchaNow(url) {
  return enqueue(async () => {
    if (!page) return { ok: false, error: "no page" };
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(2000);
    }
    const result = await solveCaptcha();
    await saveShot();
    return { ok: true, url: page.url(), result };
  });
}

async function captchaDebug() {
  // Không dùng enqueue để có thể chạy song song với solve đang chạy
  if (!page) return { ok: false, error: "no page" };
  return (async () => {
    const dom = await inspectCaptchaDOM();

    // Check iframes
    const frames = page.frames();
    const frameInfo = [];
    for (const f of frames) {
      try {
        const fUrl = f.url();
        const fData = await f.evaluate(() => {
          const canvases = Array.from(document.querySelectorAll("canvas")).map(c => {
            const r = c.getBoundingClientRect();
            return { cssW: Math.round(r.width), cssH: Math.round(r.height), iW: c.width, iH: c.height };
          });
          const imgs = Array.from(document.querySelectorAll("img")).filter(i => {
            const r = i.getBoundingClientRect(); return r.width > 20;
          }).map(i => {
            const r = i.getBoundingClientRect();
            return { cssW: Math.round(r.width), draggable: i.draggable, isData: i.src.startsWith("data:") };
          });
          const sliders = Array.from(document.querySelectorAll("[style*='translateX']")).map(el => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), style: (el.getAttribute("style")||"").slice(0,80) };
          });
          // tìm tất cả element lớn có computed background-image
          const divsWithBg = Array.from(document.querySelectorAll("*")).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 60) return false;
            const cs = window.getComputedStyle(el);
            return cs.backgroundImage && cs.backgroundImage !== "none";
          }).map(el => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return { tag: el.tagName, cls: (el.className||"").toString().slice(0,60), w: Math.round(r.width), h: Math.round(r.height), bgImg: cs.backgroundImage.slice(0,80) };
          });
          // Lấy HTML bỏ qua style/script tags
          const bodyClone = document.body ? document.body.cloneNode(true) : null;
          if (bodyClone) { bodyClone.querySelectorAll("style,script,link").forEach(e => e.remove()); }
          const bodyHtml = bodyClone ? bodyClone.innerHTML.slice(0, 4000) : "";
          // Tìm element captcha bằng text content
          const captchaEls = Array.from(document.querySelectorAll("*")).filter(el => {
            const t = el.textContent||""; const id=(el.id||"").toLowerCase(); const cls=(el.className||"").toString().toLowerCase();
            return (t.includes("puzzle") || t.includes("slide") || id.includes("captcha") || cls.includes("captcha") || cls.includes("verify")) && el.getBoundingClientRect().width > 50;
          }).slice(0,5).map(el => ({ tag: el.tagName, id: el.id, cls: (el.className||"").toString().slice(0,80), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), outerHtml: el.outerHTML.slice(0,300) }));
          return { canvases, imgs, sliders, divsWithBg, bodyHtml, captchaEls };
        }).catch(() => null);
        frameInfo.push({ url: fUrl.slice(0, 60), data: fData });
      } catch {}
    }

    const widths = await page.evaluate(() => {
      const slider = document.querySelector('div[style*="transform: translateX"]');
      const trackW = slider && slider.parentElement ? slider.parentElement.getBoundingClientRect().width : 0;
      const aside = document.querySelector("aside[aria-modal=true]");
      const iframes = Array.from(document.querySelectorAll("iframe")).map(f => {
        const r = f.getBoundingClientRect();
        return { src: (f.src||"").slice(0,60), w: Math.round(r.width), h: Math.round(r.height) };
      });
      return { trackW: Math.round(trackW), hasAside: !!aside, iframes };
    }).catch(e => ({ error: e.message }));

    return { ok: true, url: page.url().slice(0, 80), dom, widths, frames: frameInfo };
  })();
}

module.exports = { init, createLink, getReport, navigate, snapshot, showQr, getStatus, shutdown, restartWithProxy, captchaDebug, solveCaptchaNow, SHOT };
