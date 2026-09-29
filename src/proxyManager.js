// Quản lý proxy: lấy danh sách proxy VN miễn phí từ ProxyScrape + GeoNode,
// test từng cái bằng TCP connect, trả về proxy URL đầu tiên hoạt động.
// proxy5.net dùng Cloudflare → không scrape được bằng HTTP thuần.
const https = require("https");
const http = require("http");
const net = require("net");

// Nguồn proxy VN — đều trả kết quả không cần JS/browser
const SOURCES = [
  {
    url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=vn&protocol=http&proxy_format=ipport&format=text&timeout=5000",
    parse: parseTextList,  // dạng IP:PORT mỗi dòng
  },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&country=VN&protocols=http,https",
    parse: parseGeoNode,   // dạng JSON {data:[{ip,port},...]}
  },
];

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: { "user-agent": "curl/8.0", "accept": "*/*" },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Dạng ProxyScrape: "IP:PORT\nIP:PORT\n..."
function parseTextList(text) {
  const results = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$/);
    if (!m) continue;
    const ip = m[1]; const port = parseInt(m[2]);
    if (!validIp(ip) || port < 80 || port > 65535) continue;
    const key = `${ip}:${port}`;
    if (!seen.has(key)) { seen.add(key); results.push({ ip, port }); }
  }
  return results;
}

// Dạng GeoNode: {"data":[{"ip":"...","port":"..."},...]}
function parseGeoNode(text) {
  const results = [];
  const seen = new Set();
  try {
    const j = JSON.parse(text);
    for (const item of (j.data || [])) {
      const ip = item.ip; const port = parseInt(item.port);
      if (!ip || !validIp(ip) || port < 80 || port > 65535) continue;
      const key = `${ip}:${port}`;
      if (!seen.has(key)) { seen.add(key); results.push({ ip, port }); }
    }
  } catch {}
  return results;
}

function validIp(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => n >= 0 && n <= 255);
}

// Kiểm tra proxy bằng TCP connect — nhanh, không cần thư viện ngoài
function testProxyTCP(ip, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

// Tải danh sách từ tất cả nguồn, test song song theo batch,
// trả về URL proxy đầu tiên hoạt động (hoặc null nếu không có)
async function getWorkingProxy({ maxTest = 40, concurrency = 10 } = {}) {
  console.log("[proxy] Tải danh sách proxy VN...");
  let proxies = [];

  for (const src of SOURCES) {
    try {
      const text = await fetchText(src.url);
      const found = src.parse(text);
      console.log(`[proxy] Nguồn ${new URL(src.url).hostname} → ${found.length} proxy`);
      proxies = proxies.concat(found);
    } catch (e) {
      console.error(`[proxy] Lỗi tải ${src.url}:`, e.message);
    }
  }

  // Deduplicate toàn bộ
  const seen = new Set();
  proxies = proxies.filter((p) => {
    const key = `${p.ip}:${p.port}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  if (!proxies.length) {
    console.log("[proxy] Không lấy được proxy nào.");
    return null;
  }

  const toTest = proxies.slice(0, maxTest);
  console.log(`[proxy] Test ${toTest.length} proxy (concurrency=${concurrency})...`);

  // Test theo batch, dừng ngay khi tìm được proxy đầu tiên
  for (let i = 0; i < toTest.length; i += concurrency) {
    const batch = toTest.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (p) => ({ ...p, ok: await testProxyTCP(p.ip, p.port) }))
    );
    const working = results.filter((p) => p.ok);
    if (working.length) {
      const pick = working[0];
      const proxyUrl = `http://${pick.ip}:${pick.port}`;
      console.log(`[proxy] ✅ Proxy khả dụng: ${proxyUrl}`);
      return proxyUrl;
    }
  }

  console.log("[proxy] Không có proxy nào vượt TCP test.");
  return null;
}

module.exports = { getWorkingProxy, testProxyTCP };
