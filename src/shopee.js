const axios = require("axios");
const { loadConfig } = require("./config");
const cookieStore = require("./cookieStore");

// Lỗi đặc thù của Shopee khi token/cookie hết hạn
const TOKEN_EXPIRED_CODE = 90309999;

// Tự sinh csrf-token từ cookie: header csrf-token = giá trị cookie csrftoken.
// Nhờ vậy chỉ cần giữ Cookie tươi, khỏi cập nhật riêng csrf-token.
function csrfFromCookie(cookie) {
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Trả về bản headers đã tự điền csrf-token lấy từ Cookie (nếu có)
function withDerivedCsrf(headers = {}) {
  const csrf = csrfFromCookie(headers.Cookie);
  return csrf ? { ...headers, "csrf-token": csrf } : { ...headers };
}

class ShopeeError extends Error {
  constructor(message, { code, status, data } = {}) {
    super(message);
    this.name = "ShopeeError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

// Gói lỗi axios -> ShopeeError để API trả về gọn gàng
function wrapError(err) {
  const data = err.response?.data;
  const code = data?.error ?? data?.err_code;
  let message = err.message;

  if (code === TOKEN_EXPIRED_CODE) {
    message =
      "Token/cookie đã hết hạn (90309999). Hãy lấy lại header + cookie mới từ trình duyệt và cập nhật config.json.";
  } else if (data) {
    message = typeof data === "string" ? data : JSON.stringify(data);
  }

  return new ShopeeError(message, {
    code,
    status: err.response?.status,
    data,
  });
}

/**
 * Tạo affiliate link từ 1 link Shopee gốc.
 * @param {string} originalLink - link Shopee cần tạo affiliate
 * @param {object} [subIds] - { subId1..subId5 }, mặc định lấy từ config.defaultSubIds
 * @returns {Promise<{shortLink:string, longLink:string, failCode:any, raw:object}>}
 */
async function createLink(originalLink, subIds) {
  if (!originalLink || typeof originalLink !== "string") {
    throw new ShopeeError("Thiếu originalLink (link Shopee cần tạo).", {
      status: 400,
    });
  }

  const config = loadConfig();
  const linkCfg = config.link || {};
  const advancedLinkParams = subIds || config.defaultSubIds || {};

  const body = {
    operationName: "batchGetCustomLink",
    query: `
      query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller) {
        batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller) {
          shortLink
          longLink
          failCode
        }
      }
    `,
    variables: {
      linkParams: [
        {
          originalLink: originalLink.trim(),
          advancedLinkParams,
        },
      ],
      sourceCaller: "CUSTOM_LINK_CALLER",
    },
  };

  try {
    const res = await axios.request({
      method: "post",
      url: linkCfg.url,
      maxBodyLength: Infinity,
      headers: linkCfg.headers,
      data: JSON.stringify(body),
    });

    // Shopee thường trả HTTP 200 kèm mã lỗi bên trong body khi token sai/hết hạn
    const errCode = res.data?.error ?? res.data?.err_code;
    if (errCode) {
      throw new ShopeeError(
        errCode === TOKEN_EXPIRED_CODE
          ? "Token/cookie đã hết hạn (90309999). Hãy lấy lại header + cookie mới từ trình duyệt và cập nhật config.json (mục 'link')."
          : `Shopee trả về lỗi ${errCode}.`,
        { code: errCode, data: res.data },
      );
    }

    const item = res.data?.data?.batchCustomLink?.[0];
    if (!item || (!item.shortLink && item.failCode)) {
      throw new ShopeeError(
        `Shopee không trả về link (failCode: ${item?.failCode ?? "?"}).`,
        { data: res.data },
      );
    }

    return {
      shortLink: item.shortLink,
      longLink: item.longLink,
      failCode: item.failCode,
      raw: res.data,
    };
  } catch (err) {
    if (err instanceof ShopeeError) throw err;
    throw wrapError(err);
  }
}

/**
 * Lấy báo cáo chuyển đổi (conversion report).
 * @param {object} [opts]
 * @param {number} [opts.days=7] - số ngày gần nhất
 * @param {number} [opts.pageNum=1]
 * @param {number} [opts.pageSize=50]
 * @param {number} [opts.purchaseTimeStart] - unix giây (ghi đè days nếu có)
 * @param {number} [opts.purchaseTimeEnd] - unix giây
 * @returns {Promise<{total:number, list:Array, raw:object}>}
 */
const REPORT_URL_DEFAULT = "https://affiliate.shopee.vn/api/v3/report/list";

async function getReport(opts = {}) {
  const config = loadConfig();
  const reportCfg = config.report || {};

  // Cookie report: ưu tiên cookie store (cập nhật qua /cookie.html), rồi config.
  const cookie = cookieStore.getCookie() || config.reportCookie || (reportCfg.headers && reportCfg.headers.Cookie) || "";
  if (!cookie) {
    throw new ShopeeError(
      "Chưa cấu hình cookie để đọc report. Mở /cookie.html để dán cookie affiliate.shopee.vn.",
      { status: 503, code: "NO_REPORT_COOKIE" },
    );
  }
  const url = reportCfg.url || REPORT_URL_DEFAULT;
  const headers = withDerivedCsrf({
    accept: "application/json, text/plain, */*",
    "affiliate-program-type": "1",
    "content-type": "application/json; charset=UTF-8",
    origin: "https://affiliate.shopee.vn",
    referer: "https://affiliate.shopee.vn/report/conversion_report",
    ...(reportCfg.headers || {}),
    Cookie: cookie,
  });

  const now = Math.floor(Date.now() / 1000);
  const days = opts.days ?? 7;
  const purchaseTimeStart =
    opts.purchaseTimeStart ?? now - days * 24 * 60 * 60;
  const purchaseTimeEnd = opts.purchaseTimeEnd ?? now;

  try {
    const res = await axios.get(url, {
      params: {
        page_num: opts.pageNum ?? 1,
        page_size: opts.pageSize ?? 50,
        purchase_time_s: purchaseTimeStart,
        purchase_time_e: purchaseTimeEnd,
        version: 1,
      },
      headers,
      maxBodyLength: Infinity,
    });

    const errCode = res.data?.error ?? res.data?.err_code;
    if (errCode) {
      throw new ShopeeError(
        errCode === TOKEN_EXPIRED_CODE
          ? "Token/cookie đã hết hạn (90309999). Hãy lấy lại header + cookie mới từ trình duyệt và cập nhật config.json (mục 'report')."
          : `Shopee trả về lỗi ${errCode}.`,
        { code: errCode, data: res.data },
      );
    }

    const list = res.data?.data?.list || res.data?.list || [];
    return { total: list.length, list, raw: res.data };
  } catch (err) {
    if (err instanceof ShopeeError) throw err;
    throw wrapError(err);
  }
}

/**
 * Lấy báo cáo và lọc theo SubID.
 * @param {object} [opts]
 * @param {string[]} opts.subIds - danh sách SubID cần lọc
 * @param {number} [opts.days=7]
 * @param {number} [opts.pageSize=100]
 * @returns {Promise<{total:number, matched:Array, days:number, subIds:string[]}>}
 */
async function getReportBySubId(opts = {}) {
  const subIds = opts.subIds || [];
  const days = opts.days ?? 7;

  const { list } = await getReport({
    days,
    pageNum: 1,
    pageSize: opts.pageSize ?? 100,
  });

  const matched = list.filter((item) => {
    const subs = item.sub_ids || item.subIds || [];
    return subIds.some((id) => subs.includes(id));
  });

  return { total: list.length, matched, days, subIds };
}

module.exports = {
  createLink,
  getReport,
  getReportBySubId,
  ShopeeError,
  TOKEN_EXPIRED_CODE,
};
