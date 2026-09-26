// Cầu nối WebSocket giữa API server và extension trình duyệt.
// Server đẩy "job" xuống extension; extension chạy trong trang Shopee
// (chữ ký anti-bot hợp lệ) rồi trả kết quả về.
const { WebSocketServer } = require("ws");

const sockets = new Set();
const pending = new Map(); // jobId -> { resolve, timer }
let jobSeq = 0;

function attach(server) {
  const wss = new WebSocketServer({ server, path: "/bridge" });

  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.isAlive = true;

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.type === "pong" || msg.type === "ping" || msg.type === "hello") {
        ws.isAlive = true;
        return;
      }
      if (msg.type === "result" && pending.has(msg.jobId)) {
        const p = pending.get(msg.jobId);
        clearTimeout(p.timer);
        pending.delete(msg.jobId);
        p.resolve(msg.payload);
      }
    });

    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));

    ws.send(JSON.stringify({ type: "hello", role: "server" }));
  });

  // Ping định kỳ để dọn kết nối chết
  setInterval(() => {
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) {
        sockets.delete(ws);
        continue;
      }
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        sockets.delete(ws);
      }
    }
  }, 20000).unref?.();
}

function firstOpenSocket() {
  for (const ws of sockets) if (ws.readyState === ws.OPEN) return ws;
  return null;
}

function isOnline() {
  return !!firstOpenSocket();
}

// Gửi một job xuống extension và chờ kết quả
function runJob(action, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = firstOpenSocket();
    if (!ws) {
      const err = new Error(
        "Extension chưa kết nối. Hãy mở Chrome (đã cài extension) và một tab affiliate.shopee.vn đã đăng nhập.",
      );
      err.status = 503;
      return reject(err);
    }
    const jobId = "j" + ++jobSeq;
    const timer = setTimeout(() => {
      pending.delete(jobId);
      const err = new Error("Extension không phản hồi kịp (timeout).");
      err.status = 504;
      reject(err);
    }, timeoutMs);
    pending.set(jobId, { resolve, timer });
    ws.send(JSON.stringify({ type: "job", jobId, action, params }));
  });
}

module.exports = { attach, isOnline, runJob };
