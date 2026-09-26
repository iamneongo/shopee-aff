// Hàm này được inject vào MAIN world của trang affiliate.shopee.vn
// (qua chrome.scripting.executeScript). Vì chạy trong ngữ cảnh trang nên
// fetch của nó được SDK chống bot của Shopee tự ký x-sap-sec hợp lệ.
// PHẢI tự chứa hoàn toàn (không tham chiếu biến ngoài) vì bị serialize.
function saffPageFn(action, params) {
  params = params || {};

  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function createLink(originalLink, subIds) {
    if (!originalLink) return { ok: false, error: "Thiếu link gốc." };
    const body = {
      operationName: "batchGetCustomLink",
      query:
        "\n    query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){\n      batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){\n        shortLink\n        longLink\n        failCode\n      }\n    }\n    ",
      variables: {
        linkParams: [
          { originalLink: String(originalLink).trim(), advancedLinkParams: subIds || {} },
        ],
        sourceCaller: "CUSTOM_LINK_CALLER",
      },
    };
    const res = await fetch(
      "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "affiliate-program-type": "1",
          "csrf-token": getCsrf(),
        },
        body: JSON.stringify(body),
      },
    );
    const data = await res.json();
    const errCode = data && (data.error != null ? data.error : data.err_code);
    if (errCode) {
      return {
        ok: false,
        code: errCode,
        error:
          errCode === 90309999
            ? "Shopee từ chối chữ ký (90309999). Tải lại trang custom_link rồi thử lại."
            : "Shopee trả về lỗi " + errCode + ".",
        raw: data,
      };
    }
    const item =
      data && data.data && data.data.batchCustomLink && data.data.batchCustomLink[0];
    if (!item || (!item.shortLink && item.failCode)) {
      return {
        ok: false,
        error: "Không tạo được link (failCode: " + (item && item.failCode) + ").",
        raw: data,
      };
    }
    return { ok: true, shortLink: item.shortLink, longLink: item.longLink, raw: data };
  }

  async function getReport(opts) {
    opts = opts || {};
    const now = Math.floor(Date.now() / 1000);
    const start = now - (opts.days || 7) * 86400;
    const url =
      "https://affiliate.shopee.vn/api/v3/report/list?page_num=" +
      (opts.pageNum || 1) +
      "&page_size=" +
      (opts.pageSize || 50) +
      "&purchase_time_s=" +
      start +
      "&purchase_time_e=" +
      now +
      "&version=1";
    const res = await fetch(url, {
      credentials: "include",
      headers: { "affiliate-program-type": "1", "csrf-token": getCsrf() },
    });
    const data = await res.json();
    const errCode = data && (data.error != null ? data.error : data.err_code);
    if (errCode) return { ok: false, code: errCode, error: "Shopee lỗi " + errCode + "." };
    const list = (data && data.data && data.data.list) || data.list || [];
    return { ok: true, total: list.length, list };
  }

  if (action === "createLink") return createLink(params.originalLink, params.subIds);
  if (action === "getReport") return getReport(params);
  return Promise.resolve({ ok: false, error: "Hành động không hợp lệ." });
}
