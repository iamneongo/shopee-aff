// Tự kiểm tra hệ thống: tạo link → kiểm redirect/tracking → đọc report (bắt cookie hết hạn).
// Dùng bởi endpoint GET /api/selfcheck và timer định kỳ (server.js).
const https = require("https");
const linkBuilder = require("./linkBuilder");
const shopee = require("./shopee");
const { loadConfig } = require("./config");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
// Sản phẩm dùng để test tạo link (chỉ để kiểm cơ chế, không mua gì)
const TEST_PRODUCT = "https://shopee.vn/product/711287964/18091949843";
const TEST_SUB = "selfcheck";

function headLocation(url) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    const req = https.request(u, { method: "GET", headers: { "user-agent": UA }, timeout: 15000 }, (res) => {
      res.destroy();
      resolve({ status: res.statusCode, location: res.headers.location || "" });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function runSelfCheck() {
  const checks = [];
  let cfg = {}; try { cfg = loadConfig(); } catch {}
  const affId = process.env.SHOPEE_AFFILIATE_ID || cfg.affiliateId;

  // 1) affiliate_id đã cấu hình?
  checks.push({ name: "affiliate_id", ok: !!affId, detail: affId ? ("…" + String(affId).slice(-4)) : "CHƯA cấu hình (env SHOPEE_AFFILIATE_ID / config.affiliateId)" });

  // 2) Tạo link
  let link = null;
  try {
    const r = await linkBuilder.createAffiliateLink(affId, TEST_PRODUCT, { subId1: TEST_SUB });
    link = r && r.ok ? r.shortLink : null;
    checks.push({ name: "build_link", ok: !!(r && r.ok), detail: r && r.ok ? "ok" : ((r && (r.code + ": " + r.error)) || "fail") });
  } catch (e) { checks.push({ name: "build_link", ok: false, detail: e.message }); }

  // 3) Link redirect + gắn tracking đúng (affiliate_id + sub_id)
  if (link) {
    const hop = await headLocation(link);
    const loc = (hop && hop.location) || "";
    const is301 = hop && hop.status >= 300 && hop.status < 400;
    const hasAff = !!affId && loc.includes("utm_source=an_" + affId);
    const hasSub = loc.includes("utm_content=" + TEST_SUB);
    const ok = !!(is301 && hasAff && hasSub);
    checks.push({ name: "link_tracking", ok, detail: ok ? "301 + utm_source/utm_content đúng" : `status=${hop ? hop.status : "?"} aff=${hasAff} sub=${hasSub}` });
  } else {
    checks.push({ name: "link_tracking", ok: false, detail: "bỏ qua (không tạo được link)" });
  }

  // 4) Cookie report còn sống? (bắt sớm cookie hết hạn)
  try {
    const rep = await shopee.getReport({ days: 1, pageSize: 1 });
    checks.push({ name: "report_cookie", ok: true, detail: `ok (${rep.total} đơn / 1 ngày)` });
  } catch (e) {
    const expired = e.code === shopee.TOKEN_EXPIRED_CODE || e.code === "NO_REPORT_COOKIE";
    checks.push({ name: "report_cookie", ok: false, detail: expired ? "cookie HẾT HẠN/thiếu — cập nhật tại /cookie.html" : (e.message || "lỗi") });
  }

  return { ok: checks.every((c) => c.ok), at: new Date().toISOString(), checks };
}

// Chuỗi tóm tắt các mục lỗi (cho thông báo)
function failSummary(result) {
  return result.checks.filter((c) => !c.ok).map((c) => `• ${c.name}: ${c.detail}`).join("\n");
}

module.exports = { runSelfCheck, failSummary };
