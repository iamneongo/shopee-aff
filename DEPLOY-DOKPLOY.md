# Triển khai lên Dokploy (API + Chrome + noVNC)

Đóng gói **API + Chrome thật + Xvfb + noVNC** vào 1 container. Đăng nhập/giải captcha qua **noVNC** (trình duyệt web), session lưu ở **volume** để không mất khi redeploy.

> ⚠️ **Rủi ro IP datacenter:** Shopee có thể bắt captcha nhiều hơn hẳn so với IP nhà. Nếu bị làm khó liên tục → gắn **proxy residential/4G VN** vào `config.puppeteer.proxy`. Cân nhắc trước khi phụ thuộc production.

## 0. Yêu cầu
- Code đã ở GitHub (`iamneongo/shopee-aff`, nhánh `main`).
- Container cần **~1.5–2GB RAM** (Chrome). Đặt trong Dokploy → Advanced → Resources.

## 1. Tạo Application
Dokploy → **Create Project** → **Create Service → Application**.
- **Source:** GitHub → repo `iamneongo/shopee-aff`, branch `main`.
- **Build Type:** **Dockerfile** (dùng `Dockerfile` sẵn trong repo).

## 2. Volume (giữ đăng nhập) — BẮT BUỘC
Advanced → **Volumes** → Add **Volume Mount**:
- Volume name: `shopee-data`
- Mount path: `/data`

(Profile Chrome nằm ở `/data/chrome-profile` — khớp `config.puppeteer.userDataDir`.)

## 3. config.json — mount qua File Mount
`config.json` không nằm trong repo (đã .gitignore). Advanced → **Volumes** → Add **File Mount**:
- Mount path: `/app/config.json`
- Content: copy từ `config.deploy.example.json`, rồi sửa:
  - `apiKey`: đặt 1 chuỗi mạnh (client phải gửi header `x-api-key`).
  - `notify.telegram`: điền botToken + chatId (nhận cảnh báo captcha).
  - `puppeteer.proxy`: điền nếu cần proxy VN.
  - Giữ `executablePath: "/usr/bin/google-chrome"`, `userDataDir: "/data/chrome-profile"`, `headless: false`, `connectURL: ""`.

## 4. Environment
- `VNC_PASSWORD` = một mật khẩu mạnh (bảo vệ noVNC).
- (PORT=4000 đã đặt trong Dockerfile.)

## 5. Domains (Traefik)
Add 2 domain:
| Domain | Container Port | Ghi chú |
|---|---|---|
| `shopee-api.neooi.com` | `4000` | API. Bật HTTPS. |
| `shopee-vnc.neooi.com` | `6080` | noVNC. **BẮT BUỘC bật Basic Auth** (Dokploy middleware) — nó điều khiển trình duyệt đã đăng nhập! |

## 6. Deploy
Bấm **Deploy**. Xem Logs tới khi thấy `🚀 Shopee Aff API đang chạy`.

## 7. Đăng nhập lần đầu (qua noVNC)
1. Mở `https://shopee-vnc.neooi.com/vnc.html` → **Connect** → nhập `VNC_PASSWORD`.
2. Thấy cửa sổ Chrome đang ở trang đăng nhập Shopee → **đăng nhập** (QR/mật khẩu).
3. Vào `affiliate.shopee.vn/offer/custom_link`, **tạo 1 link qua giao diện → giải captcha 1 lần** (nhận cookie tin cậy).
4. Kiểm tra: `curl -H "x-api-key: <key>" https://shopee-api.neooi.com/api/worker/status` → `loggedIn: true`.

## 8. Dùng API
```bash
curl -X POST https://shopee-api.neooi.com/api/link \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"originalLink":"https://s.shopee.vn/xxxxx","userId":"u12345"}'
```

## Bảo trì
- Mất đăng nhập / captcha → nhận cảnh báo Telegram → vào noVNC xử lý (profile giữ ở volume nên hiếm khi phải làm lại).
- Redeploy KHÔNG mất login (nhờ volume `/data`).
- Nếu Shopee chặn IP server → thêm `proxy` VN trong `config.json` (file mount) rồi Redeploy.

## Bảo mật
- noVNC phải có Basic Auth + mật khẩu VNC mạnh (nó = toàn quyền phiên Shopee của bạn).
- API phải bật `apiKey`.
- `config.json` (file mount) và volume `/data` chứa session — chỉ nằm trên server của bạn.
