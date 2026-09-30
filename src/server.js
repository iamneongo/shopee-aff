const path = require("path");
const express = require("express");
const { loadConfig } = require("./config");
const linkBuilder = require("./linkBuilder");
const shopee = require("./shopee");
const cookieStore = require("./cookieStore");
const notifier = require("./notifier");
const { ShopeeError } = shopee;

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
    mode: "stateless", // tạo link bằng s.shopee.vn/an_redir — không cần trình duyệt
    endpoints: [
      "POST /api/link            { originalLink, userId?, subIds?, affiliateId? }",
      "GET  /api/report          ?days=7&page=1&size=50   (cần cookie)",
      "GET  /api/report/by-subid ?subIds=web,test&days=7",
      "POST /api/report/cookie   { cookie }   (UI: /cookie.html)",
      "GET  /api/notify/test",
    ],
  });
});

// Trạng thái (giữ path cũ cho tương thích trang test) — API không còn trạng thái browser.
const statusPayload = () => ({ ok: true, mode: "stateless", online: true });
app.get("/api/bridge/status", (req, res) => res.json(statusPayload()));
app.get("/api/worker/status", (req, res) => res.json(statusPayload()));

// Gửi thử thông báo (kiểm tra cấu hình Telegram/webhook)
app.get(
  "/api/notify/test",
  wrap(async (req, res) => {
    const r = await notifier.notifyNow("test", "✅ Test thông báo Shopee Aff API — cấu hình notify OK.");
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

// HTTP status phù hợp cho từng mã lỗi
const ERROR_STATUS = {
  MISSING_LINK:    400,
  INVALID_SUBID:   400,
  NO_AFFILIATE_ID: 500,
  SHOPEE_FAIL_2:   502,
};

// ===== Tạo affiliate link (cashback) =====
// POST /api/link  body: { originalLink, userId?, subIds?, affiliateId? }
// - userId: mã người dùng nhận cashback -> gắn vào subId1, chỉ [a-zA-Z0-9].
// - subIds: ghi đè/bổ sung subId1..subId5 (ưu tiên hơn defaultSubIds; userId thắng subId1).
// Dùng endpoint chuyển hướng chính thức Shopee (s.shopee.vn/an_redir) — chỉ ghép chuỗi,
// KHÔNG cần Chrome/cookie/captcha/proxy. affiliate_id lấy từ config/env (hoặc body override).
app.post(
  "/api/link",
  wrap(async (req, res) => {
    const { originalLink, userId, subIds, affiliateId } = req.body || {};
    if (!originalLink) throw new ShopeeError("Thiếu originalLink.", { status: 400, code: "MISSING_LINK" });

    if (userId != null) validateSubId(String(userId).trim(), "userId");
    if (subIds && typeof subIds === "object") {
      for (const [k, v] of Object.entries(subIds)) {
        if (v) validateSubId(String(v), k);
      }
    }

    let cfg = {};
    try { cfg = loadConfig(); } catch {}
    const affId = affiliateId || process.env.SHOPEE_AFFILIATE_ID || cfg.affiliateId;
    const finalSubIds = { ...(cfg.defaultSubIds || {}), ...(subIds || {}) };
    if (userId != null && String(userId).trim() !== "") {
      finalSubIds.subId1 = String(userId).trim();
    }
    Object.keys(finalSubIds).forEach((k) => { if (!finalSubIds[k]) delete finalSubIds[k]; });

    const result = await linkBuilder.createAffiliateLink(affId, originalLink, finalSubIds);
    if (!result || !result.ok) {
      const code = (result && result.code) || "SHOPEE_ERROR";
      return res.status(ERROR_STATUS[code] || 502).json({
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

// Cảnh báo khi cookie report hết hạn/thiếu (chống spam bằng cooldown trong notifier)
function alertCookieIfExpired(err) {
  if (err && (err.code === shopee.TOKEN_EXPIRED_CODE || err.code === "NO_REPORT_COOKIE")) {
    notifier.notify(
      "report-cookie",
      "⚠️ Cookie đọc báo cáo Shopee đã HẾT HẠN/thiếu. Vào /cookie.html để dán cookie mới.\n" +
        "Trang: https://shopee-api.apps.neooi.com/cookie.html",
    );
  }
}

// ===== Cập nhật cookie report (dùng bởi trang /cookie.html) =====
app.get("/api/report/cookie", (req, res) => {
  const j = cookieStore.get();
  res.json({ ok: true, configured: !!j, length: j ? j.cookie.length : 0, updatedAt: j ? j.updatedAt : null });
});
app.post(
  "/api/report/cookie",
  wrap(async (req, res) => {
    const cookie = ((req.body && req.body.cookie) || "").trim();
    if (!cookie) throw new ShopeeError("Thiếu cookie.", { status: 400, code: "MISSING_COOKIE" });
    const saved = cookieStore.set(cookie);
    res.json({ ok: true, length: saved.cookie.length, updatedAt: saved.updatedAt });
  }),
);

// ===== Báo cáo chuyển đổi (đọc bằng cookie) =====
app.get(
  "/api/report",
  wrap(async (req, res) => {
    try {
      const r = await shopee.getReport({
        days: req.query.days ? Number(req.query.days) : undefined,
        pageNum: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.size ? Number(req.query.size) : undefined,
      });
      res.json({ ok: true, total: r.total, list: r.list });
    } catch (err) { alertCookieIfExpired(err); throw err; }
  }),
);

// ===== Báo cáo lọc theo SubID =====
app.get(
  "/api/report/by-subid",
  wrap(async (req, res) => {
    try {
      const subIds = (req.query.subIds || "").split(",").map((s) => s.trim()).filter(Boolean);
      const days = req.query.days ? Number(req.query.days) : 7;
      const r = await shopee.getReportBySubId({ subIds, days, pageSize: 100 });
      res.json({ ok: true, total: r.total, matchedCount: r.matched.length, subIds, matched: r.matched });
    } catch (err) { alertCookieIfExpired(err); throw err; }
  }),
);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: "Không tìm thấy endpoint." }));

// Chỉ khởi động khi chạy trực tiếp (node src/server.js)
if (require.main === module) {
  const port = process.env.PORT || loadConfig().port || 3000;
  app.listen(port, () => {
    console.log(`🚀 Shopee Aff API (stateless) đang chạy tại http://localhost:${port}`);
    console.log("   Tạo link qua s.shopee.vn/an_redir — không cần Chrome/captcha/proxy.");
  });
}

module.exports = { app };
