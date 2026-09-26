# shopee-aff

REST API (Node.js + Express) để **tạo affiliate link** và **lấy báo cáo chuyển đổi** từ Shopee Affiliate. Việc tạo link chạy qua **Puppeteer** điều khiển một Chrome thật (đã đăng nhập) — vì Shopee kiểm dấu vân tay TLS của Chrome (post-quantum) nên chỉ trình duyệt thật mới gọi được, không có "native API" thuần.

> ⚠️ Gọi API nội bộ Shopee bằng session của chính bạn. Không phải API chính thức — có thể đổi bất cứ lúc nào.

## Cài đặt

```bash
npm install                          # cài kèm puppeteer-core (cần Chrome đã cài sẵn trên máy)
cp config.example.json config.json   # Windows: copy config.example.json config.json
```

## Chạy (khuyến nghị: chế độ CONNECT)

Node **gắn vào** một Chrome bạn tự mở (ổn định nhất; tránh lỗi cửa sổ Puppeteer trắng trên Windows). `config.puppeteer.connectURL = "http://127.0.0.1:9222"`.

```bash
# 1) Mở Chrome riêng cho bot (cổng debug 9222, profile riêng)
start-chrome.bat        # Windows. (Linux/Mac: xem lệnh trong file)

# 2) Đăng nhập Shopee 1 lần trong cửa sổ Chrome vừa mở
#    Lần đầu: tạo 1 link qua GIAO DIỆN web để giải captcha (Shopee cấp cookie tin cậy).

# 3) Chạy API (server sẽ connect vào Chrome đó)
npm start
```

Kiểm tra: `GET /api/worker/status` → `{ ready, loggedIn, online }`. Khi `loggedIn:true` là tạo link được.

```bash
curl -X POST http://localhost:4000/api/link -H "Content-Type: application/json" \
  -d "{\"originalLink\":\"https://s.shopee.vn/xxxxx\"}"
```

### Chế độ LAUNCH (Node tự mở Chrome)
Đặt `connectURL:""` → server tự mở Chrome (`headless` true/false). Tiện cho VPS (Xvfb) — xem `DEPLOY.md`. Lưu ý: một số máy Windows bị lỗi cửa sổ trắng → dùng chế độ connect.

### Vì sao phải solve captcha 1 lần?
Profile Chrome mới bị Shopee coi là thiết bị lạ → bắt captcha. Tạo 1 link qua giao diện web (giải captcha) → nhận cookie `AC_CERT_D` tin cậy → sau đó API chạy thẳng. Profile giữ trust nên không phải làm lại thường xuyên.

Trang: `http://localhost:4000/` (test) · `/docs.html` (tài liệu).

### Endpoints

| Method | Đường dẫn | Mô tả |
|--------|-----------|-------|
| GET  | `/` | Health check + danh sách endpoint |
| POST | `/api/link` | Tạo affiliate link |
| GET  | `/api/report` | Báo cáo chuyển đổi |
| GET  | `/api/report/by-subid` | Báo cáo lọc theo SubID |

**Tạo link** — chạy qua **extension bridge** (xem `extension/README.md`). Vì Shopee chống bot bằng chữ ký một-lần, server không thể tự tạo link; nó đẩy job xuống extension để trang Shopee tự ký. Cần: extension đã cài + kết nối, và một tab `affiliate.shopee.vn` đã đăng nhập.
```bash
curl -X POST http://localhost:3000/api/link \
  -H "Content-Type: application/json" \
  -d '{"originalLink":"https://s.shopee.vn/xxxxx"}'
```
Kiểm tra extension đã kết nối chưa: `GET /api/bridge/status` → `{ "online": true }`.
Tuỳ chọn truyền `subIds`:
```json
{ "originalLink": "https://...", "subIds": { "subId1": "web", "subId2": "sale" } }
```

**Báo cáo** — `GET /api/report?days=7&page=1&size=50`

**Báo cáo theo SubID** — `GET /api/report/by-subid?subIds=web,test&days=7`

### Bảo vệ API (tuỳ chọn)
Đặt `apiKey` trong `config.json` khác rỗng → mọi request `/api/*` phải kèm header `x-api-key: <key>`.

## Chạy CLI (cách cũ vẫn dùng được)

```bash
npm run link -- "https://s.shopee.vn/xxxxx"
npm run report -- 7                 # báo cáo 7 ngày
npm run report:subid -- web,test 7  # lọc theo SubID
```

## Lấy token / cookie

Các giá trị `Cookie`, `x-sap-sec`, `x-sap-ri`, `af-ac-enc-*`, `csrf-token` được Shopee sinh ra ở trình duyệt và **sẽ hết hạn**. Khi API trả về lỗi `90309999`:

1. Mở `affiliate.shopee.vn`, đăng nhập, mở DevTools → tab **Network**.
2. Thực hiện thao tác (tạo link / mở trang report) để thấy request tương ứng.
3. Copy lại các header + `Cookie` mới, dán vào `config.json` (mục `link` hoặc `report`).
4. Không cần restart server — config được đọc lại mỗi request.

## Cấu trúc

```
src/
  config.js   # đọc config.json
  shopee.js   # logic gọi Shopee (createLink, getReport, getReportBySubId)
  server.js   # Express REST API
getlink.js / report.js / reportId.js   # CLI wrapper dùng chung src/shopee.js
config.json           # secrets — KHÔNG commit (đã .gitignore)
config.example.json   # mẫu cấu hình
```

## ⚠️ Bảo mật

`config.json` chứa session Shopee của bạn — **đã được `.gitignore`**, đừng commit. Nếu lỡ để lộ token, hãy đăng xuất/đăng nhập lại Shopee để vô hiệu hoá token cũ.
