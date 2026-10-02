// Chuẩn hoá report Shopee thành danh sách phẳng (1 dòng / order) cho backend tiêu thụ.
// - Parse userId từ utm_content (subId1) hoặc override gán tay (mappingStore).
// - Chuẩn hoá trạng thái (COMPLETED/CANCELLED/REFUNDED/PENDING) cho logic clawback.
// - Quy đổi tiền về VND (Shopee lưu ×100000) + trích item (tên SP, giá, hoa hồng, fraud).
const shopee = require("./shopee");
const mappingStore = require("./mappingStore");

const MONEY = 100000; // Shopee lưu tiền ×100000
const money = (n) => Math.round(Number(n || 0)) / MONEY;

function normStatus(order) {
  const s = String(order.order_status || order.display_order_status || "").toUpperCase();
  if (s.includes("CANCEL")) return "CANCELLED";
  if (s.includes("REFUND")) return "REFUNDED";
  if (s.includes("COMPLET")) return "COMPLETED";
  if (s.includes("PEND") || s.includes("WAIT") || s.includes("UNPAID")) return "PENDING";
  return s || "UNKNOWN";
}

async function getConversions(opts = {}) {
  const { list } = await shopee.getReport({
    days: opts.days ?? 30,
    pageNum: opts.pageNum ?? 1,
    pageSize: opts.pageSize ?? 100,
  });
  const overrides = mappingStore.all();
  const out = [];

  for (const co of (list || [])) {
    const uc = (co.utm_content || "").trim();
    const subId1 = (uc && uc !== "----") ? uc.split("-")[0] : "";
    const commission = money(co.estimated_total_commission || co.gross_commission || 0);

    for (const o of (co.orders || [])) {
      const manual = overrides[o.order_sn];
      const userId = subId1 || manual || "";
      const items = (o.items || []).map((it) => ({
        itemId: it.item_id,
        name: it.item_name,
        shopName: it.shop_name,
        price: money(it.item_price),
        actual: money(it.actual_amount),
        refunded: money(it.refunded_amount),
        qty: it.qty,
        commission: money(it.item_commission),
        status: it.display_item_status || it.item_status,
        isFraud: it.is_fraud === 1,
        fraudReason: it.fraud_reason || null,
      }));
      out.push({
        orderSn: o.order_sn,
        checkoutId: co.checkout_id,
        userId,
        subId: uc,
        matched: !!userId,
        manual: !!(manual && !subId1),
        commission,
        status: normStatus(o),
        isFraud: items.some((i) => i.isFraud),
        orderValue: Math.round(items.reduce((s, i) => s + (i.actual || 0), 0) * 100) / 100,
        itemName: items[0] ? items[0].name : null,
        purchaseTime: co.purchase_time,
        completeTime: o.complete_time || co.checkout_complete_time || null,
        device: co.device || null,
        source: co.direct_source || co.last_external_source || null,
        items,
        raw: {
          order_status: o.order_status,
          display_order_status: o.display_order_status,
          conversion_status: co.conversion_status,
          cancel_reason: o.cancel_reason || null,
        },
      });
    }
  }

  let res = out;
  if (opts.unmatchedOnly) res = res.filter((c) => !c.matched);
  if (opts.status) res = res.filter((c) => c.status === String(opts.status).toUpperCase());
  if (opts.userId) res = res.filter((c) => c.userId === opts.userId);

  const summary = {
    total: out.length,
    matched: out.filter((c) => c.matched).length,
    unmatched: out.filter((c) => !c.matched).length,
    commission: Math.round(out.reduce((s, c) => s + c.commission, 0) * 100) / 100,
    byStatus: {},
  };
  out.forEach((c) => { summary.byStatus[c.status] = (summary.byStatus[c.status] || 0) + 1; });

  return { conversions: res, summary };
}

module.exports = { getConversions };
