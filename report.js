// CLI lấy báo cáo chuyển đổi (7 ngày gần nhất).
// Dùng: node report.js [số_ngày]
// Secrets được đọc từ config.json (không còn hardcode trong file này).
const { getReport } = require("./src/shopee");

async function main() {
  const days = process.argv[2] ? Number(process.argv[2]) : 7;

  try {
    const { total, list } = await getReport({ days, pageSize: 50 });
    console.log(`\n→ Tìm thấy ${total} đơn hàng trong ${days} ngày:`);
    list.forEach((item, i) => {
      console.log(`\n#${i + 1}`);
      console.log("  Order SN     :", item.order_sn || item.orderId);
      console.log("  Sản phẩm     :", item.item_name || item.itemName);
      console.log("  Hoa hồng     :", item.commission || item.estimated_commission);
      console.log("  Trạng thái   :", item.order_status || item.display_order_status);
      console.log(
        "  Thời gian    :",
        item.purchase_time
          ? new Date(item.purchase_time * 1000).toLocaleString("vi-VN")
          : "",
      );
      console.log("  SubID        :", item.sub_ids || item.subIds);
    });
  } catch (err) {
    console.error("❌ Lỗi lấy report:", err.message);
    process.exit(1);
  }
}

main();
