// Gửi thông báo khi cần người vào giải captcha / đăng nhập lại.
// Hỗ trợ Telegram (kèm ảnh chụp) và webhook chung. Có chống spam (cooldown).
const fs = require("fs");
const { loadConfig } = require("./config");

const lastSent = {}; // reason -> timestamp

async function sendTelegram(tg, text, photoPath) {
  const base = "https://api.telegram.org/bot" + tg.botToken;
  // Có ảnh + gửi được -> gửi ảnh kèm caption; nếu lỗi thì fallback text
  if (photoPath && fs.existsSync(photoPath)) {
    try {
      const fd = new FormData();
      fd.append("chat_id", String(tg.chatId));
      fd.append("caption", text);
      fd.append("photo", new Blob([fs.readFileSync(photoPath)]), "captcha.png");
      const r = await fetch(base + "/sendPhoto", { method: "POST", body: fd });
      if (r.ok) return true;
    } catch (_) {}
  }
  const r = await fetch(base + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

async function sendWebhook(url, text, extra) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...extra }),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// reason: khoá để chống spam (vd "captcha", "login"). cooldown lấy từ config.
async function notify(reason, text, photoPath) {
  let cfg = {};
  try { cfg = loadConfig(); } catch {}
  const n = cfg.notify || {};
  if (n.enabled === false) return { ok: false, skipped: "disabled" };

  const cooldownMs = (n.cooldownSec != null ? n.cooldownSec : 300) * 1000;
  const now = Date.now();
  if (lastSent[reason] && now - lastSent[reason] < cooldownMs) {
    return { ok: false, skipped: "cooldown" };
  }
  lastSent[reason] = now;

  const results = [];
  if (n.telegram && n.telegram.botToken && n.telegram.chatId) {
    results.push(await sendTelegram(n.telegram, text, photoPath).catch(() => false));
  }
  if (n.webhook) {
    results.push(await sendWebhook(n.webhook, text, { reason }).catch(() => false));
  }
  const sent = results.some(Boolean);
  return { ok: sent, channels: results.length };
}

// Bỏ cooldown (dùng cho nút test)
async function notifyNow(reason, text, photoPath) {
  delete lastSent[reason];
  return notify(reason, text, photoPath);
}

module.exports = { notify, notifyNow };
