const $ = (id) => document.getElementById(id);
const SHOPEE_URL = "https://affiliate.shopee.vn/offer/custom_link";

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

async function findShopeeTab() {
  const tabs = await chrome.tabs.query({ url: "https://affiliate.shopee.vn/*" });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

// Chạy trực tiếp trong trang (dùng cho thao tác thủ công từ popup)
async function runInPage(action, params, btn) {
  const tab = await findShopeeTab();
  if (!tab) {
    $("warn").classList.add("show");
    setStatus("Chưa có tab Shopee Affiliate.", "err");
    return null;
  }
  $("warn").classList.remove("show");
  if (btn) btn.disabled = true;
  setStatus("⏳ Đang xử lý trong trang Shopee...");
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: saffPageFn,
      args: [action, params || {}],
    });
    return (results && results[0] && results[0].result) || { ok: false, error: "Không có kết quả." };
  } catch (e) {
    setStatus("Lỗi: " + e.message + " (thử tải lại trang Shopee).", "err");
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ==== Tạo link ====
$("genBtn").addEventListener("click", async () => {
  const originalLink = $("link").value.trim();
  if (!originalLink) {
    setStatus("Nhập link Shopee gốc trước.", "err");
    return;
  }
  const sub = $("subid").value.trim();
  const subIds = sub ? { subId1: sub } : undefined;

  $("result").classList.remove("show");
  $("raw").style.display = "none";

  const resp = await runInPage("createLink", { originalLink, subIds }, $("genBtn"));
  if (!resp) return;

  if (resp.ok) {
    setStatus("✅ Tạo link thành công!", "ok");
    $("short").value = resp.shortLink || "";
    $("result").classList.add("show");
  } else {
    setStatus("❌ " + resp.error, "err");
    if (resp.raw) {
      $("raw").style.display = "block";
      $("raw").textContent = JSON.stringify(resp.raw, null, 2);
    }
  }
});

// ==== Báo cáo ====
$("reportBtn").addEventListener("click", async () => {
  $("result").classList.remove("show");
  const resp = await runInPage("getReport", { days: 7 }, $("reportBtn"));
  if (!resp) return;
  if (resp.ok) {
    setStatus(`✅ ${resp.total} đơn trong 7 ngày.`, "ok");
    $("raw").style.display = "block";
    $("raw").textContent = JSON.stringify(resp.list, null, 2);
  } else {
    setStatus("❌ " + resp.error, "err");
  }
});

// ==== Copy ====
$("copyBtn").addEventListener("click", async () => {
  const v = $("short").value;
  if (!v) return;
  await navigator.clipboard.writeText(v);
  $("copyBtn").textContent = "✓";
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1200);
});

// ==== Mở Shopee ====
$("openBtn").addEventListener("click", () => chrome.tabs.create({ url: SHOPEE_URL }));

// ==== Trạng thái bridge ====
function refreshBridge() {
  chrome.runtime.sendMessage({ type: "SAFF_BRIDGE_STATUS" }, (resp) => {
    const on = resp && resp.connected;
    $("dot").className = "dot" + (on ? " on" : "");
    $("bridgeText").textContent = on
      ? "Bridge: đã kết nối server ✓"
      : "Bridge: chưa kết nối server";
  });
}

// ==== Lưu URL server ====
$("saveUrlBtn").addEventListener("click", () => {
  const url = $("wsUrl").value.trim();
  if (!url) return;
  chrome.runtime.sendMessage({ type: "SAFF_SET_WS_URL", url }, () => {
    setStatus("Đã lưu URL server, đang kết nối lại...", "ok");
    setTimeout(refreshBridge, 1000);
  });
});

// Khởi tạo
(async () => {
  const tab = await findShopeeTab();
  if (!tab) $("warn").classList.add("show");
  const { wsUrl } = await chrome.storage.local.get("wsUrl");
  $("wsUrl").value = wsUrl || "ws://127.0.0.1:4000/bridge";
  refreshBridge();
})();
