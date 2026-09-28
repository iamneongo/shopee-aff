# AGENTS.md — Hướng dẫn cho AI làm việc ở các phiên sau

> Đọc file này trước khi làm bất cứ việc gì trong repo. Nó tóm tắt kiến trúc, cách chạy, deploy, và các "bẫy" đã tốn nhiều công để tìm ra.
> **BÍ MẬT (apiKey, VNC password) KHÔNG nằm trong repo (repo public).** Xem mục [Secrets](#secrets).

## 1. Dự án là gì
API cho **hệ thống cashback Shopee affiliate**: tạo affiliate link **gắn theo từng user** (để quy hoa hồng) và lấy **báo cáo chuyển đổi**. Node.js + Express + Puppeteer.

## 2. Ràng buộc CỐT LÕI (đừng phá vỡ)
Shopee kiểm **dấu vân tay TLS của Chrome** (post-quantum X25519MLKEM768) ở endpoint tạo link (`batchCustomLink`). Hệ quả đã kiểm chứng bằng thực nghiệm:
- ❌ **KHÔNG** thể tạo link bằng Node/curl thuần (kể cả giả TLS `node-tls-client`, HTTP/2, cookie tươi đầy đủ) → luôn `403 / error 90309999`.
- ❌ `x-sap-sec`/`af-ac-enc-*` KHÔNG cần (test: bỏ/để rác vẫn chạy trong browser). ServiceWorker chỉ là Workbox cache.
- ✅ **CHỈ** tạo được khi `fetch` chạy TRONG một Chrome THẬT đã đăng nhập (Puppeteer lái). TLS khớp → qua.
- `/api/report*` thì gọi trực tiếp bằng cookie được (không bị kiểm TLS chặt) — nhưng bản hiện tại route report qua Puppeteer luôn cho đồng nhất.

→ **Đừng lại đi làm "native API thuần". Đã chứng minh bất khả thi.** Giữ Puppeteer.

## 3. Kiến trúc
```
client → POST /api/link → Express (src/server.js) → puppeteerWorker → Chrome thật (đã login) → shortLink
```
- **src/server.js** — Express API. Route: `/api/link`, `/api/report`, `/api/report/by-subid`, `/api/worker/{status,open-login,screenshot.png,qr.png}`, `/api/notify/test`, `/health`. `/api/bridge/status` giữ lại cho tương thích trang test.
- **src/puppeteerWorker.js** — lái Chrome. 2 chế độ (config.puppeteer):
  - `connectURL` có giá trị → **connect** vào Chrome người dùng tự mở (`--remote-debugging-port`). Dùng khi máy local bị lỗi cửa sổ Puppeteer trắng (Windows).
  - `connectURL` rỗng → **launch** Chrome (headless true/false). Dùng cho server/VPS + Xvfb.
- **src/notifier.js** — Telegram/webhook báo khi captcha/mất login (chống spam theo `cooldownSec`).
- **src/shopee.js** — còn `ShopeeError` + helper csrf (report). `csrf-token` = giá trị cookie `csrftoken` (tự suy ra).
- **src/config.js** — đọc `config.json` (đọc lại mỗi request; sửa config KHÔNG cần restart).
- **public/index.html** (trang test), **public/docs.html** (tài liệu API).
- **Dockerfile + entrypoint.sh** — 1 container: Xvfb + x11vnc + noVNC + Chrome + Node.

## 4. SubIds cho cashback
`POST /api/link` body: `{ originalLink, userId?, subIds? }`.
- `userId` → gắn vào **subId1** (người nhận cashback). `subIds` ghi đè `defaultSubIds`.
- Quy đơn: `GET /api/report/by-subid?subIds=<userId>&days=30` → đơn + hoa hồng của user đó.
- `defaultSubIds` (config): subId1=guest, subId2=web, subId3=cashback.

## 5. Chạy local
Cần Chrome cài sẵn. `npm install` rồi `cp config.example.json config.json`.
- **Connect mode (khuyến nghị trên Windows — cửa sổ Puppeteer tự mở hay bị trắng):**
  ```
  start-chrome.bat        # mở Chrome debug cổng 9222, profile C:\shopee-bot-profile
  # đăng nhập Shopee 1 lần trong cửa sổ đó
  npm start               # config.puppeteer.connectURL = "http://127.0.0.1:9222"
  ```
- **Launch mode:** đặt `connectURL:""`, `headless:false` → `npm start` (Chrome tự mở).
- Lần đầu 1 profile mới: tạo 1 link qua GIAO DIỆN web để **giải captcha** → nhận cookie tin cậy `AC_CERT_D`.

## 6. Production — Dokploy (dokploy.neooi.com, Neo Company)
Đã deploy sẵn. Chi tiết dựng lại trong `DEPLOY-DOKPLOY.md`. Tóm tắt cấu hình hiện có:
- Project **shopee-aff** > app **api**. Nguồn: Git HTTPS `github.com/iamneongo/shopee-aff` (public), branch `main`, Build type **Dockerfile**.
- Env: `PORT=4000`, `VNC_PASSWORD=<xem Secrets>`.
- Mounts: Volume `shopee-data → /data` (giữ login qua redeploy) + File `config.json → /app/config.json`.
- Domains: `shopee-api.apps.neooi.com → 4000`, `shopee-vnc.apps.neooi.com → 6080` (noVNC), đều HTTPS/Let's Encrypt.
- Redeploy: push lên `main` (Autodeploy bật) hoặc bấm Deploy trong Dokploy. Sửa secrets/proxy → sửa **File Mount config.json** trong Dokploy rồi Redeploy.

### URL production
- API: `https://shopee-api.apps.neooi.com`
- noVNC (đăng nhập/giải captcha): `https://shopee-vnc.apps.neooi.com/vnc.html`

## 7. Vận hành & bảo trì
- **Đăng nhập/giải captcha:** mở noVNC → nhập VNC password → trong Chrome, đăng nhập Shopee + tạo 1 link qua giao diện để giải captcha 1 lần. Profile lưu ở volume `/data` nên bền qua redeploy.
- **Kiểm tra:** `GET /api/worker/status` → `{ ready, loggedIn, headless }`. `loggedIn:false` = cần đăng nhập lại.
- **⚠️ IP datacenter:** server hay bị Shopee bắt captcha hơn IP nhà. Nếu bị làm khó liên tục → thêm **proxy residential/4G VN** vào `config.puppeteer.proxy` (sửa File Mount → Redeploy).
- **Session Shopee** hết hạn ~vài ngày–2 tuần → đăng nhập lại qua noVNC.
- Bật Telegram: điền `config.notify.telegram.botToken/chatId` → nhận cảnh báo captcha.

## 8. Dùng API
```bash
# Tạo link cashback
curl -X POST https://shopee-api.apps.neooi.com/api/link \
  -H "x-api-key: <API_KEY>" -H "Content-Type: application/json" \
  -d '{"originalLink":"https://s.shopee.vn/xxxxx","userId":"u12345"}'

# Trạng thái worker
curl -H "x-api-key: <API_KEY>" https://shopee-api.apps.neooi.com/api/worker/status
```

## 9. Secrets
**Không commit giá trị thật vào repo (public).** Giá trị thật nằm ở:
- **Bộ nhớ dự án của AI** (`.claude/.../memory/` — tự nạp ở phiên sau).
- **Dokploy**: File Mount `config.json` (apiKey) + Env `VNC_PASSWORD`.
- `config.json` local (đã .gitignore).

Tên các secret: `apiKey` (header `x-api-key` gọi API), `VNC_PASSWORD` (đăng nhập noVNC), `config.notify.telegram.*` (tuỳ chọn).

## 10. Bẫy đã gặp (đừng lặp lại)
- `page.screenshot()` **treo vô hạn** khi cửa sổ Chrome bị ẩn/minimize (headful). Đã bọc timeout trong `saveShot()`. Đừng bỏ timeout đó.
- Cửa sổ Puppeteer **tự launch** trên Windows hay render **trắng/treo** → dùng **connect mode** (user tự mở Chrome).
- Profile Chrome mới → Shopee bắt **captcha** (device lạ). Phải giải 1 lần qua UI (nhận `AC_CERT_D`).
- File `.sh` phải LF (đã có `.gitattributes`) để chạy trong container Linux.
- KHÔNG commit `config.json`, `.chrome-profile/`, `worker-screen.png`, `captcha.png` (đã .gitignore).
- Lịch sử git commit đầu (`8adffff`) còn cookie cũ hardcode — cân nhắc để repo private hoặc dọn history.

## 11. Tích hợp vào hệ thống cashback
API này là **lớp tạo link + đọc báo cáo**. Hệ thống cashback (backend riêng của bạn) đứng TRƯỚC nó và lo phần user/ví/đối soát. API này KHÔNG lưu user, KHÔNG tính tiền — chỉ nhận `userId` để gắn vào SubId.

### Luồng tổng thể
```
User bấm "lấy link" ─▶ Cashback Backend ─POST /api/link {originalLink,userId}─▶ Shopee Aff API ─▶ shortLink
User mua qua shortLink ─▶ Shopee ghi nhận đơn (kèm sub_ids)
Cron đối soát ─GET /api/report─▶ lọc theo sub_ids[0]=userId ─▶ cộng cashback vào ví user
```

### 11.1 Tạo link (khi user yêu cầu)
- Gọi `POST /api/link` với `userId` = mã user trong hệ thống cashback bạn → API gắn vào `subId1`.
- **Nên cache/dedupe**: lưu `(userId, originalLink) → shortLink` ở DB của bạn; lần sau trả từ cache, KHÔNG gọi lại API (giảm tải Chrome + tránh anti-bot). Link Shopee là vĩnh viễn.
```js
async function getCashbackLink(userId, originalLink) {
  const cached = await db.links.findOne({ userId, originalLink });
  if (cached) return cached.shortLink;
  const r = await fetch(process.env.SHOPEE_API + "/api/link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.SHOPEE_API_KEY },
    body: JSON.stringify({ originalLink, userId }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("link fail: " + j.error + " (code " + j.code + ")");
  await db.links.insert({ userId, originalLink, shortLink: j.shortLink, at: Date.now() });
  return j.shortLink;
}
```

### 11.2 Đối soát & cộng cashback (cron định kỳ)
- Chạy cron (vd mỗi 30–60 phút) gọi `GET /api/report?days=N` (hoặc `/api/report/by-subid?subIds=<userId>` cho 1 user).
- Mỗi item trong `list` có (tên trường có 2 biến thể, dùng `a || b`): `order_sn`/`orderId`, `sub_ids`/`subIds`, `commission`/`estimated_commission`, `order_status`/`display_order_status`, `purchase_time`, `shop_name`, `item_name`.
- **Quy user:** `subId1` (phần tử đầu `sub_ids`) chính là `userId`.
```js
async function reconcile() {
  const r = await fetch(process.env.SHOPEE_API + "/api/report?days=14&size=100",
    { headers: { "x-api-key": process.env.SHOPEE_API_KEY } }).then(x => x.json());
  if (!r.ok) { /* alert admin, KHÔNG retry dồn dập */ return; }
  for (const o of r.list) {
    const orderSn = o.order_sn || o.orderId;
    const subs = o.sub_ids || o.subIds || [];
    const userId = subs[0];                     // = subId1
    const commission = Number(o.commission || o.estimated_commission || 0);
    const status = o.order_status || o.display_order_status;
    if (!orderSn || !userId) continue;
    await upsertOrder(orderSn, userId, commission, status); // idempotent theo orderSn
  }
}
```

### 11.3 Sổ cái cashback (gợi ý)
- Bảng `cashback_orders`: `order_sn` (UNIQUE), `user_id`, `commission`, `status`, `cashback_amount`, `paid`(bool), `updated_at`.
- **Idempotent theo `order_sn`**: mỗi lần cron chạy là UPSERT, không cộng trùng.
- **Trạng thái đơn:** chỉ **trả cashback khi đơn ĐÃ XÁC NHẬN/hoàn tất**; đơn `pending` thì ghi nhận chờ; đơn **bị huỷ → thu hồi (clawback)** cashback nếu đã tạm cộng. `commission` lúc pending là *ước tính*, có thể đổi khi Shopee chốt.
- **Tỉ lệ cashback:** `cashback_amount = commission * tỉ_lệ_chia_cho_user` (do bạn định, vd 70%).

### 11.4 Xử lý lỗi khi tích hợp
| Tình huống | Response | Backend nên làm |
|---|---|---|
| Thiếu `originalLink` | 400 | Lỗi input, sửa request |
| Sai `x-api-key` | 401 | Kiểm tra config |
| `90309999` (captcha) | 502, `code:90309999` | Báo admin vào noVNC giải; **hàng đợi lại link đó**, đừng spam retry |
| "Chưa đăng nhập" | 502 | Báo admin đăng nhập lại qua noVNC |
| timeout | 504 | Thử lại 1 lần sau vài giây |

### 11.5 Lưu ý vận hành khi tích hợp
- **Giãn nhịp gọi `/api/link`** (Chrome chạy tuần tự, ~1 link/lần; đừng bắn ồ ạt → dễ captcha/cờ tài khoản). Có cache thì phần lớn request không chạm API.
- Trước khi tạo link hàng loạt, kiểm tra `GET /api/worker/status` → `loggedIn:true` mới gọi.
- Đặt `SHOPEE_API` + `SHOPEE_API_KEY` ở backend cashback qua biến môi trường (đừng hardcode).
- Nếu cần **tạo nhiều link/lần**: hiện chưa có endpoint batch — có thể bổ sung `POST /api/links` (mảng) dùng `batchCustomLink` để 1 lần ký tạo N link (xem mục nâng cấp tương lai).
