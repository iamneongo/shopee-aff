// CLI tạo affiliate link.
// Dùng: node getlink.js "https://s.shopee.vn/xxxxx"
// Secrets được đọc từ config.json (không còn hardcode trong file này).
const readline = require("readline");
const { createLink } = require("./src/shopee");

async function getOriginalLink() {
  if (process.argv[2]) return process.argv[2].trim();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("Nhập link Shopee cần tạo affiliate: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const originalLink = await getOriginalLink();
  if (!originalLink) {
    console.error("❌ Bạn chưa nhập link!");
    process.exit(1);
  }

  console.log("→ Đang tạo link cho:", originalLink);
  try {
    const result = await createLink(originalLink);
    console.log("\n✅ Kết quả:");
    console.log(JSON.stringify(result.raw, null, 2));
    if (result.shortLink) console.log("\n🔗 Short link:", result.shortLink);
  } catch (error) {
    console.error("❌ Lỗi:", error.message);
    process.exit(1);
  }
}

main();
