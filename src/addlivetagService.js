// AddLiveTag Data API — tạo Shopee affiliate link không cần Chrome/captcha
// Endpoint: GET https://data.addlivetag.com/product-data/product-data.php
// Docs: https://github.com/bcat95/shopee-aff/blob/main/product-data-api.md
const https = require("https");

const BASE = "https://data.addlivetag.com/product-data/product-data.php";

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, raw }));
    }).on("error", reject);
  });
}

async function createLink(originalLink, subIds = {}, cfg = {}) {
  const alt = cfg.addlivetag || {};
  const apiKey = alt.apiKey || "";
  const affid  = alt.affid  || "";

  if (!affid)  return { ok: false, code: "NO_AFFID",  error: "Chưa cấu hình addlivetag.affid." };
  if (!apiKey) return { ok: false, code: "NO_APIKEY", error: "Chưa cấu hình addlivetag.apiKey." };

  const params = { url: originalLink, affid };
  if (subIds.subId1) params.sub1 = subIds.subId1;
  if (subIds.subId2) params.sub2 = subIds.subId2;
  if (subIds.subId3) params.sub3 = subIds.subId3;
  if (subIds.subId4) params.sub4 = subIds.subId4;
  if (subIds.subId5) params.sub5 = subIds.subId5;

  const reqUrl = `${BASE}?${qs(params)}`;
  console.log(`[addlivetag] GET ${reqUrl.replace(affid, "***")}`);

  let resp;
  try {
    resp = await httpGet(reqUrl, { "X-API-Key": apiKey });
  } catch (e) {
    return { ok: false, code: "NETWORK_ERROR", error: e.message };
  }

  let data;
  try {
    data = JSON.parse(resp.raw);
  } catch {
    return { ok: false, code: "PARSE_ERROR", error: `HTTP ${resp.status} — không parse được response.` };
  }

  if (resp.status === 401) return { ok: false, code: "INVALID_API_KEY", error: "AddLiveTag API key không hợp lệ hoặc đã hết hạn." };
  if (resp.status === 429) return { ok: false, code: "RATE_LIMIT", error: "AddLiveTag rate limit — thử lại sau." };

  if (data.status !== "success") {
    return { ok: false, code: "API_ERROR", error: data.message || data.error || "AddLiveTag trả lỗi.", raw: data };
  }

  const info = data.productInfo || {};
  const affLink = info.affLink;

  if (!affLink) {
    return {
      ok: false,
      code: "NO_AFF_LINK",
      error: "API không trả về affLink — URL có thể không phải product URL hoặc affid sai.",
      raw: info,
    };
  }

  console.log(`[addlivetag] ✅ affLink: ${affLink}`);
  return {
    ok: true,
    shortLink: affLink,
    longLink: info.originLink || info.productLink || null,
    productName: info.productName || null,
  };
}

module.exports = { createLink };
