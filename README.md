# shopee-aff

REST API (Node.js + Express) để **tạo affiliate link** và **lấy báo cáo chuyển đổi** từ Shopee Affiliate. Vẫn giữ được cách chạy CLI cũ.

> ⚠️ Tool này gọi API nội bộ của Shopee bằng cookie/session của chính bạn. Không phải API chính thức — Shopee có thể đổi bất cứ lúc nào.

## Cài đặt

```bash
npm install
cp config.example.json config.json   # Windows: copy config.example.json config.json
```

Rồi mở `config.json`, dán **cookie + các token** lấy từ trình duyệt (xem phần "Lấy token" bên dưới).

## Chạy API

```bash
npm start        # chạy server (mặc định cổng 3000)
npm run dev      # chạy kèm auto-reload khi sửa code
```

Sau khi chạy, mở trình duyệt:
- `http://localhost:3000/` → **trang test** (bấm nút gọi API, xem kết quả ngay)
- `http://localhost:3000/docs.html` → **trang tài liệu API**

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
