const path = require("path");
const express = require("express");
const { loadConfig } = require("./config");
const worker = require("./puppeteerWorker");
const notifier = require("./notifier");
const { ShopeeError } = require("./shopee");

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
    res.status(status).json({ ok: false, error: err.message, code: err.code, raw: err.data });
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

// ===== Tạo affiliate link (cashback) =====
// POST /api/link  body: { originalLink, userId?, subIds? }
// - userId: mã người dùng nhận cashback -> gắn vào subId1 để quy đơn khi có báo cáo.
// - subIds: ghi đè/bổ sung subId1..subId5 (ưu tiên hơn defaultSubIds; userId thắng subId1).
app.post(
  "/api/link",
  wrap(async (req, res) => {
    const { originalLink, userId, subIds } = req.body || {};
    if (!originalLink) throw new ShopeeError("Thiếu originalLink.", { status: 400 });

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
      // Báo động để bạn vào giải captcha / đăng nhập lại
      if (result && result.code === 90309999) {
        notifier.notify("captcha", "⚠️ Shopee bắt CAPTCHA (90309999). Vào Chrome bot tạo 1 link qua giao diện để giải, rồi thử lại.", worker.SHOT);
      } else if (result && /đăng nhập/i.test(result.error || "")) {
        notifier.notify("login", "⚠️ Shopee CHƯA ĐĂNG NHẬP. Mở Chrome bot và đăng nhập lại.", worker.SHOT);
      }
      throw new ShopeeError((result && result.error) || "Không tạo được link.", {
        code: result && result.code, data: result && result.raw, status: 502,
      });
    }
    res.json({
      ok: true,
      userId: finalSubIds.subId1 || null,
      subIds: finalSubIds,
      shortLink: result.shortLink,
      longLink: result.longLink,
      raw: result.raw,
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
    if (!r || r.ok === false) throw new ShopeeError((r && r.error) || "Lỗi lấy báo cáo.", { code: r && r.code, status: 502 });
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
    if (!r || r.ok === false) throw new ShopeeError((r && r.error) || "Lỗi lấy báo cáo.", { code: r && r.code, status: 502 });
    const matched = (r.list || []).filter((item) => {
      const subs = item.sub_ids || item.subIds || [];
      return subIds.some((id) => subs.includes(id));
    });
    res.json({ ok: true, total: r.total, matchedCount: matched.length, subIds, matched });
  }),
);

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
