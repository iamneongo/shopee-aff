// Service worker: giữ WebSocket tới API server, nhận job và thực thi
// trong tab affiliate.shopee.vn (MAIN world) để được ký chữ ký hợp lệ.
importScripts("pagefn.js"); // định nghĩa saffPageFn

const DEFAULT_WS_URL = "ws://127.0.0.1:4000/bridge";
let ws = null;
let pingTimer = null;

async function getWsUrl() {
  const { wsUrl } = await chrome.storage.local.get("wsUrl");
  return wsUrl || DEFAULT_WS_URL;
}

async function findShopeeTab() {
  const tabs = await chrome.tabs.query({ url: "https://affiliate.shopee.vn/*" });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function handleJob(job) {
  const tab = await findShopeeTab();
  if (!tab) {
    return { ok: false, error: "Chưa mở tab affiliate.shopee.vn trong Chrome." };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: saffPageFn,
      args: [job.action, job.params || {}],
    });
    const result = results && results[0] && results[0].result;
    return result || { ok: false, error: "Không nhận được kết quả từ trang." };
  } catch (e) {
    return { ok: false, error: "executeScript lỗi: " + e.message };
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);
}
function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  const url = await getWsUrl();
  try {
    ws = new WebSocket(url);
  } catch (e) {
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "extension" }));
    startPing();
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "job") {
      const payload = await handleJob(msg);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "result", jobId: msg.jobId, payload }));
      }
    }
  };

  ws.onclose = () => {
    stopPing();
    ws = null;
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

// Kết nối lại định kỳ (service worker có thể bị ngủ)
chrome.alarms.create("saff-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "saff-keepalive") connect();
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

// Cho popup hỏi trạng thái / đổi URL server
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAFF_BRIDGE_STATUS") {
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
    return; // đồng bộ
  }
  if (msg.type === "SAFF_SET_WS_URL") {
    chrome.storage.local.set({ wsUrl: msg.url }, () => {
      try {
        if (ws) ws.close();
      } catch {}
      connect();
      sendResponse({ ok: true });
    });
    return true; // bất đồng bộ
  }
});

connect();
