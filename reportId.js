// CLI lấy báo cáo và lọc theo SubID.
// Dùng: node reportId.js [subId1,subId2,...] [số_ngày]
// Ví dụ: node reportId.js web,test 7
// Secrets được đọc từ config.json (không còn hardcode trong file này).
const { getReportBySubId } = require("./src/shopee");

async function main() {
  const subIds = process.argv[2]
    ? process.argv[2].split(",").map((s) => s.trim()).filter(Boolean)
    : ["web", "test", "uTest", "cTest", "v1"];
  const days = process.argv[3] ? Number(process.argv[3]) : 7;

  try {
    const { total, matched } = await getReportBySubId({ subIds, days });

    console.log(`\n→ Tổng đơn trong ${days} ngày: ${total}`);
    console.log(`→ Đơn khớp SubID [${subIds.join(", ")}]: ${matched.length}\n`);

    if (matched.length === 0) {
      console.log("Chưa có đơn nào từ link này (hoặc chưa có người mua).");
      console.log("Hãy đợi khách click link + mua hàng thành công rồi chạy lại.");
      return;
    }

    matched.forEach((item, i) => {
      console.log(`===== Đơn #${i + 1} =====`);
      console.log("Order SN      :", item.order_sn || item.orderId);
      console.log("Sản phẩm      :", item.item_name || item.itemName);
      console.log("Shop          :", item.shop_name || item.shopName);
      console.log("Hoa hồng      :", item.commission || item.estimated_commission);
      console.log("Trạng thái    :", item.order_status || item.display_order_status);
      console.log(
        "Thời gian mua :",
        item.purchase_time
          ? new Date(item.purchase_time * 1000).toLocaleString("vi-VN")
          : "",
      );
      console.log("SubIDs        :", (item.sub_ids || item.subIds || []).join(" | "));
      console.log("");
    });
  } catch (err) {
    console.error("❌ Lỗi lấy report:", err.message);
    process.exit(1);
  }
}

main();
