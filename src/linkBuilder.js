// Tạo affiliate link Shopee KHÔNG cần trình duyệt/cookie/captcha/proxy.
// Dùng endpoint chuyển hướng chính thức của Shopee: s.shopee.vn/an_redir
//   https://s.shopee.vn/an_redir?origin_link=<url SP>&affiliate_id=<id>&sub_id=<subs>
// Shopee tự gắn tracking (utm_source=an_<id>, utm_content=<sub_id>, utm_medium=affiliates)
// tại thời điểm user click. Đây là cơ chế các network (AccessTrade/Affise) vẫn dùng.
// LƯU Ý: origin_link PHẢI là URL sản phẩm chuẩn (-i.shop.item hoặc /product/shop/item);
// nếu là link rút gọn thì tracking KHÔNG gắn đủ → phải resolve về URL chuẩn trước.
const https = require("https");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// Trích shopId + itemId từ URL Shopee (nhiều định dạng)
function extractIds(url) {
  let m = url.match(/-i\.(\d+)\.(\d+)/);                  // ten-san-pham-i.<shop>.<item>
  if (m) return { shopId: m[1], itemId: m[2] };
  m = url.match(/\/(?:product|opaanlp)\/(\d+)\/(\d+)/);   // /product/<shop>/<item>
  if (m) return { shopId: m[1], itemId: m[2] };
  return null;
}

const canonicalFromIds = (ids) => `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;

// Lấy header Location của 1 hop redirect (không tải body)
function headLocation(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const req = https.request(
      u,
      { method: "GET", headers: { "user-agent": UA, accept: "text/html" }, timeout: 12000 },
      (res) => {
        res.destroy(); // chỉ cần headers
        resolve({ status: res.statusCode, location: res.headers.location || null });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Đưa link bất kỳ (chuẩn hoặc rút gọn) về URL sản phẩm chuẩn shopee.vn/product/<shop>/<item>
async function resolveToCanonical(originalLink, maxHops = 6) {
  let url = String(originalLink || "").trim();
  if (!url) return null;
  let ids = extractIds(url);
  if (ids) return canonicalFromIds(ids); // đã chuẩn → khỏi gọi mạng
  for (let i = 0; i < maxHops; i++) {
    const hop = await headLocation(url);
    if (!hop || !hop.location) break;
    try { url = new URL(hop.location, url).href; } catch { url = hop.location; }
    if (/\/verify\/|\/login|\/captcha/i.test(url)) break; // dính chặn → dừng
    ids = extractIds(url);
    if (ids) return canonicalFromIds(ids);
  }
  return null;
}

// Ghép sub_id: subId1..5 nối bằng '-' (bỏ đuôi rỗng). subId1 = userId nhận cashback.
function buildSubIdString(subIds) {
  const arr = [subIds.subId1, subIds.subId2, subIds.subId3, subIds.subId4, subIds.subId5]
    .map((v) => (v == null ? "" : String(v)));
  while (arr.length && arr[arr.length - 1] === "") arr.pop();
  return arr.join("-");
}

function buildAffiliateLink(affiliateId, productUrl, subIds) {
  const params = new URLSearchParams();
  params.set("origin_link", productUrl);
  params.set("affiliate_id", String(affiliateId));
  const sub = buildSubIdString(subIds || {});
  if (sub) params.set("sub_id", sub);
  return `https://s.shopee.vn/an_redir?${params.toString()}`;
}

// Tạo link cashback. Trả cùng cấu trúc như worker.createLink cũ để tương thích.
async function createAffiliateLink(affiliateId, originalLink, subIds) {
  if (!affiliateId) {
    return { ok: false, code: "NO_AFFILIATE_ID", error: "Chưa cấu hình affiliate_id (env SHOPEE_AFFILIATE_ID hoặc config.affiliateId)." };
  }
  if (!originalLink) return { ok: false, code: "MISSING_LINK", error: "Thiếu originalLink." };
  const canonical = await resolveToCanonical(originalLink);
  if (!canonical) {
    return {
      ok: false,
      code: "SHOPEE_FAIL_2",
      error: "Không nhận diện được sản phẩm Shopee từ link.",
      hint: "Dùng link sản phẩm trực tiếp dạng https://shopee.vn/...-i.<shopId>.<itemId> hoặc /product/<shopId>/<itemId>.",
    };
  }
  const shortLink = buildAffiliateLink(affiliateId, canonical, subIds);
  return { ok: true, shortLink, longLink: canonical, productUrl: canonical };
}

module.exports = { createAffiliateLink, resolveToCanonical, buildAffiliateLink, buildSubIdString, extractIds };
