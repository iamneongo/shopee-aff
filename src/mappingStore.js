// Gán tay order_sn → userId (override attribution) khi đơn rụng sub_id.
// Lưu ở volume /data để bền qua redeploy.
const fs = require("fs");
const path = require("path");

function storeFile() {
  if (process.env.MAPPING_STORE) return process.env.MAPPING_STORE;
  for (const dir of ["/data", path.join(__dirname, "..", ".data")]) {
    try { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, "order-map.json"); } catch {}
  }
  return path.join(__dirname, "..", ".data", "order-map.json");
}
const FILE = storeFile();

function all() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { return {}; } }
function get(orderSn) { return all()[orderSn] || null; }
function set(orderSn, userId) {
  const m = all();
  if (userId === null || userId === undefined || userId === "") delete m[orderSn];
  else m[orderSn] = String(userId);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
  fs.writeFileSync(FILE, JSON.stringify(m), "utf8");
  return m;
}

module.exports = { all, get, set, FILE };
