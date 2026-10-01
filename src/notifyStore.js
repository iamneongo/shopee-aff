// Lưu cấu hình thông báo (Telegram/webhook) ở volume /data để cập nhật nhanh qua API,
// không phải sửa config.json trên Dokploy. Ghi đè lên config.notify khi có.
const fs = require("fs");
const path = require("path");

function storeFile() {
  if (process.env.NOTIFY_STORE) return process.env.NOTIFY_STORE;
  for (const dir of ["/data", path.join(__dirname, "..", ".data")]) {
    try { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, "notify-config.json"); } catch {}
  }
  return path.join(__dirname, "..", ".data", "notify-config.json");
}
const FILE = storeFile();

function get() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return null; }
}

// patch merge nông (telegram merge riêng để giữ botToken/chatId cũ nếu chỉ đổi 1 cái)
function set(patch) {
  const cur = get() || {};
  const data = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  if (patch && patch.telegram) data.telegram = { ...(cur.telegram || {}), ...patch.telegram };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
  fs.writeFileSync(FILE, JSON.stringify(data), "utf8");
  return data;
}

module.exports = { get, set, FILE };
