// Lưu cookie report ở file trên volume bền (/data) để cập nhật nhanh qua UI/endpoint
// mà KHÔNG phải sửa config.json trên Dokploy mỗi lần cookie hết hạn.
const fs = require("fs");
const path = require("path");

// Đường dẫn file: env COOKIE_STORE > /data (volume) > ./.data (local dev)
function storeFile() {
  if (process.env.COOKIE_STORE) return process.env.COOKIE_STORE;
  for (const dir of ["/data", path.join(__dirname, "..", ".data")]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, "report-cookie.json");
    } catch {}
  }
  return path.join(__dirname, "..", ".data", "report-cookie.json");
}

const FILE = storeFile();

function get() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const j = JSON.parse(raw);
    return j && j.cookie ? j : null; // { cookie, updatedAt }
  } catch {
    return null;
  }
}

function getCookie() {
  const j = get();
  return j ? j.cookie : null;
}

function set(cookie) {
  const data = { cookie: String(cookie).trim(), updatedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
  fs.writeFileSync(FILE, JSON.stringify(data), "utf8");
  return data;
}

module.exports = { get, getCookie, set, FILE };
