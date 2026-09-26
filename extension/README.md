# Shopee Aff Bridge (Chrome Extension)

Extension đóng vai trò **cầu nối (bridge)** cho Shopee Aff API. Khi API server nhận yêu cầu tạo link, nó đẩy "job" xuống extension qua WebSocket; extension chạy request **ngay trong trang `affiliate.shopee.vn`** nên SDK chống bot của Shopee tự ký chữ ký `x-sap-sec` hợp lệ → **không còn lỗi 90309999**.

```
client → POST /api/link → API server ──WebSocket(/bridge)──▶ Extension (background.js)
                                                                 │ executeScript → trang Shopee (MAIN world)
        client ◀── shortLink ◀── API server ◀───────────────────┘
```

## Cài đặt

1. Chạy API server trước: `npm start` (mặc định cổng 4000 nếu đặt `PORT=4000`, hoặc `port` trong config.json).
2. Chrome → `chrome://extensions` → bật **Developer mode**.
3. **Load unpacked** → chọn thư mục `extension/` này.
4. Mở & đăng nhập **affiliate.shopee.vn** (giữ tab này mở).
5. Bấm icon extension → dòng **Bridge: đã kết nối server ✓** nghĩa là sẵn sàng.

> Nếu server không chạy ở `ws://127.0.0.1:4000/bridge`, mở popup → **Cấu hình server** → đổi URL → Lưu.

## Hai cách dùng

**A. Qua API (chính):** gọi `POST /api/link` từ bất kỳ đâu — server tự nhờ extension tạo link.
```
curl -X POST http://localhost:4000/api/link -H "Content-Type: application/json" \
  -d '{"originalLink":"https://s.shopee.vn/xxxxx"}'
```

**B. Thủ công trong popup:** dán link gốc → **Tạo affiliate link** → Copy. (Hữu ích để test nhanh.)

## Yêu cầu để job chạy được
- Server đang chạy và extension hiển thị **đã kết nối**.
- Có **một tab affiliate.shopee.vn đã đăng nhập** đang mở (extension chạy request trong tab đó).

## File
| File | Vai trò |
|---|---|
| `background.js` | Service worker: giữ WebSocket tới server, nhận job, executeScript vào tab Shopee |
| `pagefn.js` | Hàm `saffPageFn` chạy trong MAIN world của trang (fetch được ký hợp lệ) |
| `popup.html` / `popup.js` | Giao diện: trạng thái bridge, tạo link thủ công, cấu hình server |
| `manifest.json` | MV3, quyền: tabs, scripting, alarms, storage; host: shopee + localhost |

## Bảo mật
Extension chỉ chạy trên `affiliate.shopee.vn` và kết nối `localhost`. Không gửi cookie ra ngoài; mọi thứ chạy cục bộ.
