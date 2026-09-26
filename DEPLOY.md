# Triển khai (Puppeteer headless)

API tạo link bằng Puppeteer điều khiển **Chrome thật** (TLS khớp Chrome → không dính fingerprint của Shopee). Cần Chrome cài sẵn trên máy chạy.

## Vì sao phải là Chrome thật?
Shopee kiểm **dấu vân tay TLS**: Chrome mới dùng trao đổi khoá hậu-lượng-tử **X25519MLKEM768**. Client Node/curl (kể cả thư viện giả-TLS) không tái tạo được → bị chặn `90309999`. Puppeteer dùng chính Chrome → JA4 khớp tuyệt đối (đã xác minh cả headless lẫn headful).

## Chạy local (Windows/Mac)
```bash
npm install
copy config.example.json config.json     # đặt port, ...
npm start
```
- `config.puppeteer.headless: false` cho lần đầu → đăng nhập Shopee trong cửa sổ Chrome hiện ra.
- Đăng nhập xong → đổi `headless: true` (tuỳ chọn) để chạy ẩn. Profile `./.chrome-profile` giữ đăng nhập.

## Chạy trên VPS Linux (không màn hình)
Chrome cần môi trường đồ hoạ ảo để đăng nhập lần đầu:
```bash
sudo apt update
sudo apt install -y google-chrome-stable xvfb x11vnc   # + Node.js
git clone <repo> && cd ShopeeAff && npm install
cp config.example.json config.json     # đặt "headless": false, "executablePath": "/usr/bin/google-chrome"

# Màn hình ảo để đăng nhập 1 lần
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 &
x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever &
PORT=4000 npm start
```
- VNC vào (SSH tunnel: `ssh -L 5900:localhost:5900 user@vps` → VNC client tới `localhost:5900`) và đăng nhập Shopee.
- Hoặc gọi `GET /api/worker/open-login` rồi `GET /api/worker/screenshot.png` để xem màn hình.
- Sau khi `GET /api/worker/status` trả `loggedIn: true` → có thể để `headless: true` cho lần chạy sau (profile đã nhớ).
- Đặt sau reverse proxy TLS (Caddy/Nginx) + bật `apiKey` trong config để bảo vệ `/api/*`.
- Đưa Xvfb + `npm start` vào **systemd** để tự chạy lại khi reboot.

## Bảo trì
- Session Shopee hết hạn (vài ngày–2 tuần) → `loggedIn:false` → VNC vào đăng nhập lại.
- `.chrome-profile/` chứa session — **không commit** (đã .gitignore).

## Endpoints quản trị
| Method | Path | |
|---|---|---|
| GET | `/api/worker/status` | ready / loggedIn / headless |
| GET | `/api/worker/open-login` | điều hướng Chrome tới trang login |
| GET | `/api/worker/screenshot.png` | ảnh màn hình Chrome hiện tại |
