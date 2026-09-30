const path = require("path");
const express = require("express");
const { loadConfig } = require("./config");
const worker = require("./puppeteerWorker");
const notifier = require("./notifier");
const { ShopeeError } = require("./shopee");
const proxyManager = require("./proxyManager");

const app = express();
app.use(express.json());

// Phục vụ giao diện test + trang docs (public/index.html, public/docs.html)
app.use(express.static(path.join(__dirname, "..", "public")));

// ===== (Tuỳ chọn) Bảo vệ API bằng API key =====
// Nếu config.apiKey khác rỗng thì mọi request /api/* phải kèm header: x-api-key
app.use("/api", (req, res, next) => {
  let apiKey = "";
  try {
    apiKey = loadConfig().apiKey || "";
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
  if (apiKey && req.header("x-api-key") !== apiKey) {
    return res.status(401).json({ ok: false, error: "Sai hoặc thiếu x-api-key." });
  }
  next();
});

// Helper: bọc handler async để bắt lỗi tập trung
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err instanceof ShopeeError && err.status ? err.status : 500;
    res.status(status).json({ ok: false, code: err.code || "INTERNAL_ERROR", error: err.message });
  });

// ===== Health check =====
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "shopee-aff-api",
    mode: "puppeteer",
    endpoints: [
      "POST /api/link            { originalLink, subIds? }",
      "GET  /api/report          ?days=7&page=1&size=50",
      "GET  /api/report/by-subid ?subIds=web,test&days=7",
      "GET  /api/worker/status",
      "GET  /api/worker/open-login   (mở/điều hướng trang đăng nhập)",
      "GET  /api/worker/rotate-proxy (lấy proxy VN miễn phí + restart Chrome)",
      "GET  /api/worker/screenshot.png",
    ],
  });
});

// ===== Trạng thái worker =====
// Giữ path /api/bridge/status để tương thích trang test (banner trạng thái)
function statusPayload() {
  const s = worker.getStatus();
  return { ok: true, mode: "puppeteer", online: s.ready && s.loggedIn, ...s };
}
app.get("/api/bridge/status", (req, res) => res.json(statusPayload()));
app.get("/api/worker/status", (req, res) => res.json(statusPayload()));

// Điều hướng Chrome tới trang đăng nhập (dùng khi cần login lại)
app.get(
  "/api/worker/open-login",
  wrap(async (req, res) => {
    const r = await worker.navigate(req.query.url || "https://affiliate.shopee.vn/offer/custom_link");
    res.json(r);
  }),
);

// Tự động lấy proxy VN miễn phí từ proxy5.net rồi khởi động lại Chrome với proxy đó.
// Dùng khi IP bị Shopee bắt captcha liên tục. Chrome sẽ tắt ~5-10 giây rồi mở lại.
app.get(
  "/api/worker/rotate-proxy",
  wrap(async (req, res) => {
    const proxyUrl = await proxyManager.getWorkingProxy();
    if (!proxyUrl) {
      return res.status(503).json({ ok: false, code: "NO_PROXY", error: "Không tìm thấy proxy VN nào hoạt động từ proxy5.net." });
    }
    const status = await worker.restartWithProxy(proxyUrl);
    res.json({ ok: true, proxy: proxyUrl, ...status });
  }),
);

// Gỡ proxy: khởi động lại Chrome KHÔNG proxy (dùng khi proxy free hỏng, mất kết nối).
app.get(
  "/api/worker/clear-proxy",
  wrap(async (req, res) => {
    const status = await worker.restartWithProxy(null);
    res.json({ ok: true, proxy: null, ...status });
  }),
);

// Ảnh chụp màn hình Chrome hiện tại (để xem/đăng nhập từ xa)
app.get("/api/worker/screenshot.png", (req, res) => {
  worker.snapshot().then(() => {
    res.sendFile(worker.SHOT, (err) => {
      if (err) res.status(404).json({ ok: false, error: "Chưa có ảnh." });
    });
  });
});

// Hiện mã QR đăng nhập rồi trả ảnh (quét bằng app Shopee)
app.get("/api/worker/qr.png", (req, res) => {
  worker.showQr().then(() => {
    res.sendFile(worker.SHOT, (err) => {
      if (err) res.status(404).json({ ok: false, error: "Chưa lấy được QR." });
    });
  });
});

// Gửi thử thông báo (kiểm tra cấu hình Telegram/webhook)
app.get(
  "/api/notify/test",
  wrap(async (req, res) => {
    const r = await notifier.notifyNow("test", "✅ Test thông báo Shopee Aff API — cấu hình notify OK.", worker.SHOT);
    res.json({ ok: r.ok, detail: r });
  }),
);

// Sub_Id Shopee chỉ chấp nhận [a-zA-Z0-9], tối đa 40 ký tự
const SUBID_RE = /^[a-zA-Z0-9]{1,40}$/;
function validateSubId(value, field) {
  if (!value) return;
  if (!SUBID_RE.test(value)) {
    throw new ShopeeError(
      `${field} không hợp lệ: "${value}". Chỉ được dùng chữ và số [a-zA-Z0-9], tối đa 40 ký tự, không dấu gạch dưới hay ký tự đặc biệt.`,
      { status: 400, code: "INVALID_SUBID" },
    );
  }
}

// HTTP status phù hợp cho từng mã lỗi worker
const ERROR_STATUS = {
  WORKER_NOT_READY: 503,
  NOT_LOGGED_IN:    503,
  CAPTCHA:          503,
  FETCH_ERROR:      503,
  PAGE_NAVIGATED:   503,
  MISSING_LINK:     400,
  INVALID_SUBID:    400,
};

// ===== Tạo affiliate link (cashback) =====
// POST /api/link  body: { originalLink, userId?, subIds? }
// - userId: mã người dùng nhận cashback -> gắn vào subId1, chỉ [a-zA-Z0-9].
// - subIds: ghi đè/bổ sung subId1..subId5 (ưu tiên hơn defaultSubIds; userId thắng subId1).
app.post(
  "/api/link",
  wrap(async (req, res) => {
    const { originalLink, userId, subIds } = req.body || {};
    if (!originalLink) throw new ShopeeError("Thiếu originalLink.", { status: 400, code: "MISSING_LINK" });

    // Validate trước khi gọi Shopee
    if (userId != null) validateSubId(String(userId).trim(), "userId");
    if (subIds && typeof subIds === "object") {
      for (const [k, v] of Object.entries(subIds)) {
        if (v) validateSubId(String(v), k);
      }
    }

    let cfg = {};
    try { cfg = loadConfig(); } catch {}
    const finalSubIds = { ...(cfg.defaultSubIds || {}), ...(subIds || {}) };
    if (userId != null && String(userId).trim() !== "") {
      finalSubIds.subId1 = String(userId).trim();
    }
    // bỏ subId rỗng để Shopee không nhận giá trị trống
    Object.keys(finalSubIds).forEach((k) => { if (!finalSubIds[k]) delete finalSubIds[k]; });

    const result = await worker.createLink(originalLink, finalSubIds);
    if (!result || !result.ok) {
      const code = (result && result.code) || "SHOPEE_ERROR";
      // Báo động để admin vào giải captcha / đăng nhập lại
      if (code === "CAPTCHA") {
        notifier.notify("captcha", "⚠️ Shopee bắt CAPTCHA. Vào noVNC tạo 1 link qua giao diện để giải, rồi thử lại.", worker.SHOT);
      } else if (code === "NOT_LOGGED_IN") {
        notifier.notify("login", "⚠️ Shopee CHƯA ĐĂNG NHẬP. Mở noVNC và đăng nhập lại.", worker.SHOT);
      }
      const status = ERROR_STATUS[code] || 502;
      return res.status(status).json({
        ok: false,
        code,
        error: (result && result.error) || "Không tạo được link.",
        ...(result && result.hint ? { hint: result.hint } : {}),
      });
    }
    res.json({
      ok: true,
      userId: finalSubIds.subId1 || null,
      subIds: finalSubIds,
      shortLink: result.shortLink,
      longLink: result.longLink,
    });
  }),
);

// ===== Báo cáo chuyển đổi =====
app.get(
  "/api/report",
  wrap(async (req, res) => {
    const r = await worker.getReport({
      days: req.query.days ? Number(req.query.days) : undefined,
      pageNum: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.size ? Number(req.query.size) : undefined,
    });
    if (!r || r.ok === false) {
      const code = (r && r.code) || "SHOPEE_ERROR";
      return res.status(ERROR_STATUS[code] || 502).json({ ok: false, code, error: (r && r.error) || "Lỗi lấy báo cáo.", ...(r && r.hint ? { hint: r.hint } : {}) });
    }
    res.json({ ok: true, total: r.total, list: r.list });
  }),
);

// ===== Báo cáo lọc theo SubID =====
app.get(
  "/api/report/by-subid",
  wrap(async (req, res) => {
    const subIds = (req.query.subIds || "").split(",").map((s) => s.trim()).filter(Boolean);
    const days = req.query.days ? Number(req.query.days) : 7;
    const r = await worker.getReport({ days, pageSize: 100 });
    if (!r || r.ok === false) {
      const code = (r && r.code) || "SHOPEE_ERROR";
      return res.status(ERROR_STATUS[code] || 502).json({ ok: false, code, error: (r && r.error) || "Lỗi lấy báo cáo.", ...(r && r.hint ? { hint: r.hint } : {}) });
    }
    const matched = (r.list || []).filter((item) => {
      const subs = item.sub_ids || item.subIds || [];
      return subIds.some((id) => subs.includes(id));
    });
    res.json({ ok: true, total: r.total, matchedCount: matched.length, subIds, matched });
  }),
);

// Debug DOM captcha (tạm thời)
app.get("/api/captcha/debug", wrap(async (req, res) => {
  const r = await worker.captchaDebug();
  res.json(r);
}));

// Test trực tiếp trình giải captcha. ?url= để navigate tới trang verify trước.
app.get("/api/captcha/solve", wrap(async (req, res) => {
  const r = await worker.solveCaptchaNow(req.query.url);
  res.json(r);
}));

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: "Không tìm thấy endpoint." }));

// Chỉ khởi động khi chạy trực tiếp (node src/server.js)
if (require.main === module) {
  const port = process.env.PORT || loadConfig().port || 3000;
  (async () => {
    console.log("🧭 Mode: puppeteer — đang mở Chrome...");
    try {
      const st = await worker.init(loadConfig());
      console.log(`   Chrome sẵn sàng | headless: ${st.headless} | đăng nhập Shopee: ${st.loggedIn ? "OK" : "CHƯA (gọi /api/worker/open-login để login)"}`);
    } catch (e) {
      console.error("   Puppeteer init lỗi:", e.message);
    }
    app.listen(port, () => {
      console.log(`🚀 Shopee Aff API đang chạy tại http://localhost:${port}`);
    });

    // Health-loop: tự phát hiện mất đăng nhập -> báo động (mỗi 60s)
    let wasLoggedIn = worker.getStatus().loggedIn;
    setInterval(() => {
      const s = worker.getStatus();
      if (wasLoggedIn && !s.loggedIn) {
        notifier.notify("login", "⚠️ Chrome bot vừa MẤT ĐĂNG NHẬP Shopee. Vào đăng nhập lại để tiếp tục tạo link.", worker.SHOT);
      }
      wasLoggedIn = s.loggedIn;
    }, 60000).unref?.();
  })();
}

module.exports = { app };
