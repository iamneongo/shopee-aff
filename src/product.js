// Lấy thông tin sản phẩm TRƯỚC khi mua (giá + hoa hồng dự kiến) qua AddLiveTag.
// shopee-aff tự lấy KHÔNG được (Shopee chặn TLS/anti-bot 90309999), nên proxy sang
// AddLiveTag (extension-backed, vượt được tường). Số trả về là DỰ KIẾN (trên giá niêm
// yết + rate hiện tại) — tiền cashback THẬT luôn lấy từ /api/conversions.
const https = require("https");
const { loadConfig } = require("./config");
const linkBuilder = require("./linkBuilder");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function altFetch(itemId, apiKey) {
  return new Promise((resolve, reject) => {
    const headers = { "user-agent": UA, accept: "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;
    const req = https.request(
      { hostname: "data.addlivetag.com", path: `/product-data/product-data.php?item_id=${encodeURIComponent(itemId)}`, method: "GET", headers, timeout: 20000 },
      (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { reject(new Error("AddLiveTag parse lỗi: " + raw.slice(0, 120))); } });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("AddLiveTag timeout")); });
    req.end();
  });
}

async function getProduct({ url, itemId, shopId } = {}) {
  if (!itemId) {
    const ids = url ? linkBuilder.extractIds(String(url)) : null;
    if (ids) { itemId = ids.itemId; shopId = ids.shopId; }
    else if (url) {
      const canon = await linkBuilder.resolveToCanonical(url);
      const m = canon && canon.match(/\/product\/(\d+)\/(\d+)/);
      if (m) { shopId = m[1]; itemId = m[2]; }
    }
  }
  if (!itemId) return { ok: false, code: "MISSING_ITEM", error: "Thiếu itemId hoặc url sản phẩm hợp lệ." };

  let cfg = {}; try { cfg = loadConfig(); } catch {}
  const apiKey = process.env.ADDLIVETAG_API_KEY || cfg.addlivetagApiKey;

  let r;
  try { r = await altFetch(itemId, apiKey); }
  catch (e) { return { ok: false, code: "ALT_ERROR", error: e.message }; }

  const p = r.data && r.data.productInfo;
  if (!p) return { ok: false, code: "ALT_NO_DATA", error: "AddLiveTag không trả dữ liệu sản phẩm.", notice: r.data && r.data.apiKeyNotice };

  return {
    ok: true,
    product: {
      itemId: p.itemId, shopId: p.shopId,
      name: p.productName, shopName: p.shopName,
      price: p.price,              // VND (giá niêm yết)
      sales: p.sales, rating: p.rating, image: p.imageUrl,
      productLink: p.productLink, category: p.catPath,
      commission: p.commission,   // VND — hoa hồng DỰ KIẾN (ước lượng trên giá niêm yết)
      sellerRatePercent: p.sellerRatePercent,
      shopeeRatePercent: p.shopeeRatePercent,
      totalRatePercent: p.totalRatePercent,
      cap: p.cap, isCapped: p.isCapped,
      estimate: true,             // ⚠️ số dự kiến — tiền trả cashback lấy từ /api/conversions
    },
    apiKeyNotice: r.data.apiKeyNotice ? r.data.apiKeyNotice.status : undefined,
  };
}

module.exports = { getProduct };
