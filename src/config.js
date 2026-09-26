const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

// Đọc config.json mới mỗi lần gọi.
// Nhờ vậy khi token/cookie hết hạn, bạn chỉ cần sửa config.json
// mà KHÔNG phải khởi động lại server.
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `Không đọc được config.json (${CONFIG_PATH}). ` +
        `Hãy copy config.example.json thành config.json rồi điền cookie/token. Chi tiết: ${err.message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json không phải JSON hợp lệ: ${err.message}`);
  }
}

module.exports = { loadConfig, CONFIG_PATH };
