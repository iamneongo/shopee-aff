const path = require("path");
const http = require("http");
const express = require("express");
const { loadConfig, saveConfig } = require("./config");
const { parseCurl } = require("./curlParser");
const bridge = require("./bridge");
const {
  createLink,
  getReport,
  getReportBySubId,
  ShopeeError,
} = require("./shopee");

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
    const status =
      err instanceof ShopeeError && err.status ? err.status : 500;
    res.status(status).json({
      ok: false,
      error: err.message,
      code: err.code,
      raw: err.data, // nội dung gốc Shopee trả về (để chẩn lỗi)
    });
  });

// ===== Health check =====
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "shopee-aff-api",
    endpoints: [
      "POST /api/link          { originalLink, subIds? }",
      "GET  /api/report        ?days=7&page=1&size=50",
      "GET  /api/report/by-subid ?subIds=web,test&days=7",
    ],
  });
});

// ===== Import config từ cURL =====
// POST /api/config/import-curl  body: { curl: "...", target: "auto"|"link"|"report" }
// Tự tách headers/cookie/token và ghi vào config.json.
app.post(
  "/api/config/import-curl",
  wrap(async (req, res) => {
    const { curl, target = "auto" } = req.body || {};
    if (!curl || !curl.trim()) {
      throw new ShopeeError("Chưa dán lệnh cURL.", { status: 400 });
    }

    const parsed = parseCurl(curl);
    if (Object.keys(parsed.headers).length === 0) {
      throw new ShopeeError(
        "Không tách được header nào. Kiểm tra lại: hãy copy dạng 'Copy as cURL (bash)'.",
        { status: 400 },
      );
    }

    // Xác định endpoint: link hay report
    let dest = target;
    if (dest === "auto") {
      const u = parsed.url || "";
      if (u.includes("batchCustomLink")) dest = "link";
      else if (u.includes("report/list")) dest = "report";
      else {
        throw new ShopeeError(
          "Không tự nhận diện được endpoint từ URL. Hãy chọn 'link' hoặc 'report'.",
          { status: 400 },
        );
      }
    }
    if (!["link", "report"].includes(dest)) {
      throw new ShopeeError("target phải là 'link', 'report' hoặc 'auto'.", {
        status: 400,
      });
    }

    const config = loadConfig();
    config[dest] = config[dest] || {};
    if (parsed.url) config[dest].url = parsed.url;
    config[dest].headers = parsed.headers;
    saveConfig(config);

    const cookie = parsed.headers.Cookie || "";
    res.json({
      ok: true,
      target: dest,
      url: config[dest].url,
      headerCount: Object.keys(parsed.headers).length,
      headerKeys: Object.keys(parsed.headers).filter((k) => k !== "Cookie"),
      hasCookie: !!cookie,
      cookiePreview: cookie ? cookie.slice(0, 50) + "…" : null,
    });
  }),
);

// ===== Trạng thái bridge (extension đã kết nối chưa) =====
app.get("/api/bridge/status", (req, res) => {
  res.json({ ok: true, online: bridge.isOnline() });
});

// ===== Tạo affiliate link (qua extension bridge) =====
// POST /api/link  body: { "originalLink": "...", "subIds": { "subId1": "web", ... } }
// Đẩy job xuống extension để trang Shopee tự ký chữ ký anti-bot hợp lệ.
app.post(
  "/api/link",
  wrap(async (req, res) => {
    const { originalLink, subIds } = req.body || {};
    if (!originalLink) {
      throw new ShopeeError("Thiếu originalLink.", { status: 400 });
    }
    const result = await bridge.runJob("createLink", { originalLink, subIds });
    if (!result || !result.ok) {
      throw new ShopeeError(
        (result && result.error) || "Extension không tạo được link.",
        { code: result && result.code, data: result && result.raw, status: 502 },
      );
    }
    res.json({
      ok: true,
      shortLink: result.shortLink,
      longLink: result.longLink,
      raw: result.raw,
    });
  }),
);

// ===== Báo cáo chuyển đổi =====
// GET /api/report?days=7&page=1&size=50
app.get(
  "/api/report",
  wrap(async (req, res) => {
    const result = await getReport({
      days: req.query.days ? Number(req.query.days) : undefined,
      pageNum: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.size ? Number(req.query.size) : undefined,
    });
    res.json({ ok: true, total: result.total, list: result.list });
  }),
);

// ===== Báo cáo lọc theo SubID =====
// GET /api/report/by-subid?subIds=web,test&days=7
app.get(
  "/api/report/by-subid",
  wrap(async (req, res) => {
    const subIds = (req.query.subIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const result = await getReportBySubId({
      subIds,
      days: req.query.days ? Number(req.query.days) : undefined,
    });
    res.json({
      ok: true,
      total: result.total,
      matchedCount: result.matched.length,
      subIds: result.subIds,
      matched: result.matched,
    });
  }),
);

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Không tìm thấy endpoint." });
});

// Tạo HTTP server + gắn bridge WebSocket (đường /bridge)
const server = http.createServer(app);
bridge.attach(server);

// Chỉ khởi động server khi chạy trực tiếp (node src/server.js)
if (require.main === module) {
  const port = process.env.PORT || loadConfig().port || 3000;
  server.listen(port, () => {
    console.log(`🚀 Shopee Aff API đang chạy tại http://localhost:${port}`);
    console.log(`   Bridge WebSocket: ws://localhost:${port}/bridge`);
  });
}

module.exports = { app, server };
