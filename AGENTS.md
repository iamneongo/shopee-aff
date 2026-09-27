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
