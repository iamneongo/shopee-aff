# AGENTS.md — Hướng dẫn cho AI làm việc ở các phiên sau

> Đọc file này trước khi làm bất cứ việc gì trong repo. Nó tóm tắt kiến trúc, cách chạy, deploy, và các "bẫy" đã tốn nhiều công để tìm ra.
> **BÍ MẬT (apiKey, VNC password, SadCaptcha key) KHÔNG nằm trong repo (repo public).** Xem mục [Secrets](#9-secrets).

## 1. Dự án là gì
API cho **hệ thống cashback Shopee affiliate**: tạo affiliate link **gắn theo từng user** (để quy hoa hồng) và lấy **báo cáo chuyển đổi**. Node.js + Express + Puppeteer.

## 2. Kiến trúc CỐT LÕI hiện tại (v2 — stateless, 2026-09-30)
**Tạo link KHÔNG còn dùng Puppeteer/Chrome.** Dùng endpoint chuyển hướng chính thức của Shopee `s.shopee.vn/an_redir` — chỉ ghép chuỗi:
```
https://s.shopee.vn/an_redir?origin_link=<url SP chuẩn>&affiliate_id=<id tĩnh>&sub_id=<subId1-...-subId5>
```
Khi user click, Shopee tự gắn tracking (`utm_source=an_<id>`, `utm_content=<sub_id>`, `utm_medium=affiliates`) và redirect tới sản phẩm. Đây là cơ chế các network (AccessTrade/Affise) vẫn dùng — hoa hồng quy về đúng `affiliate_id` + `sub_id`. **Không cần trình duyệt/cookie/captcha/proxy/đăng nhập.** Code: `src/linkBuilder.js`.
- `origin_link` PHẢI là URL sản phẩm chuẩn (`...-i.<shop>.<item>` hoặc `/product/<shop>/<item>`); link rút gọn (`s.shopee.vn/xxx`) bị mất tracking → `linkBuilder.resolveToCanonical()` tự follow redirect để chuẩn hoá trước.
- `affiliate_id` là ID TĨNH, công khai (nằm trong mọi link affiliate — lấy bằng cách resolve 1 link của mình rồi đọc `utm_source=an_<id>`). Cấu hình qua `SHOPEE_AFFILIATE_ID` (env) hoặc `config.affiliateId`, hoặc override trong body `/api/link`.
- **Report** (`/api/report`): gọi trực tiếp `affiliate.shopee.vn/api/v3/report/list` bằng **cookie** (`src/shopee.js`, `config.report.headers.Cookie`) — report KHÔNG bị kiểm TLS chặt. Cần cookie tươi khi hết hạn.

### Lịch sử (vì sao bỏ Puppeteer)
Endpoint web nội bộ `batchCustomLink` kiểm **vân tay TLS Chrome** (post-quantum X25519MLKEM768) → không replay được bằng Node/curl (luôn `403/90309999`), từng phải lái Chrome thật + giải captcha (SadCaptcha) + proxy dân cư. IP datacenter bị soft-block liên tục ("Please Try Again Later"). Open API chính thức thì Shopee **không duyệt**. → Chuyển sang `an_redir` (2026-09-30): đơn giản, bền, hết captcha. Toàn bộ stack Puppeteer/Chrome/Xvfb/noVNC/SadCaptcha/proxy **đã gỡ bỏ** (xem git history nếu cần khôi phục).

## 3. Kiến trúc
```
client → POST /api/link  → Express (src/server.js) → linkBuilder → chuỗi an_redir (không gọi mạng nếu link đã chuẩn)
client → GET  /api/report → Express → shopee.js → affiliate.shopee.vn/report/list (cookie)
```
- **src/server.js** — Express API stateless. Route: `/api/link`, `/api/report`, `/api/report/by-subid`, `/api/notify/test`, `/health`. `/api/bridge/status` + `/api/worker/status` giữ lại làm stub (`{online:true}`) cho tương thích trang test.
- **src/linkBuilder.js** — tạo link `an_redir` (ghép chuỗi) + `resolveToCanonical` (chuẩn hoá link rút gọn). KHÔNG cần trình duyệt.
- **src/shopee.js** — `ShopeeError` + `getReport`/`getReportBySubId` (axios + cookie từ `config.report`). `csrf-token` tự suy từ cookie `csrftoken`.
- **src/notifier.js** — Telegram/webhook (chống spam theo `cooldownSec`).
- **src/config.js** — đọc `config.json` (đọc lại mỗi request; sửa config KHÔNG cần restart).
- **public/index.html** (trang test), **public/docs.html** (tài liệu API).
- **Dockerfile** — image Node thuần (node:22-slim). Không còn Chrome/Xvfb/noVNC.

## 4. SubIds cho cashback
`POST /api/link` body: `{ originalLink, userId?, subIds? }`.
- `userId` → gắn vào **subId1** (người nhận cashback). `subIds` ghi đè `defaultSubIds`.
- Quy đơn: `GET /api/report/by-subid?subIds=<userId>&days=30` → đơn + hoa hồng của user đó.
- `defaultSubIds` (config): subId1=guest, subId2=web, subId3=cashback.
- ⚠️ **SubId chỉ chấp nhận `[a-zA-Z0-9]`, tối đa 40 ký tự.** Gạch dưới `_`, khoảng trắng, hay ký tự đặc biệt → Shopee trả `failCode 3`. Server validate trước và trả `400 INVALID_SUBID` ngay — không gọi đến Shopee.

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
- **Env vars:** `PORT=4000`, `VNC_PASSWORD=<xem Secrets>`, `SADCAPTCHA_API_KEY=<xem Secrets>`.
- **Mounts:** Volume `shopee-data → /data` (giữ login qua redeploy) + File `config.json → /app/config.json`.
- **Domains:** `shopee-api.apps.neooi.com → 4000`, `shopee-vnc.apps.neooi.com → 6080` (noVNC), đều HTTPS/Let's Encrypt.
- **Autodeploy:** push lên `main` tự deploy. Sửa secrets/proxy → sửa **File Mount config.json** hoặc Env trong Dokploy rồi Redeploy.
- **Redeploy programmatic:** `POST https://dokploy.neooi.com/api/trpc/application.deploy?batch=1` với body `{"0":{"json":{"applicationId":"uVT3k2qTwom4_nGpQAsQN"}}}` (xem Dokploy tRPC).

### URL production
- API: `https://shopee-api.apps.neooi.com`
- noVNC (đăng nhập/giải captcha): `https://shopee-vnc.apps.neooi.com/vnc.html`

## 7. Vận hành & bảo trì

### Tạo link (`/api/link`)
Stateless, không cần đăng nhập/captcha. Chỉ cần `affiliate_id` đúng của bạn. **Lấy affiliate_id:** resolve 1 link affiliate bất kỳ của mình (`curl -L`) rồi đọc `utm_source=an_<id>` ở URL đích. Cấu hình: env `SHOPEE_AFFILIATE_ID` hoặc `config.affiliateId` (hoặc override `affiliateId` trong body). Hầu như không cần bảo trì.

### Report (`/api/report`) — cần cookie
Đọc report bằng cookie đặt ở `config.report.headers.Cookie`. Cookie hết hạn (~vài ngày–2 tuần) → lấy cookie mới từ trình duyệt đã đăng nhập affiliate.shopee.vn (DevTools → Network → copy header Cookie) → cập nhật File Mount `config.json` → Redeploy (hoặc sửa nóng nếu mount cho đọc lại). Lỗi `90309999` = cookie hết hạn.

### Kiểm tra nhanh
`GET /health` → `{ mode:"stateless", ... }`. `GET /api/worker/status` → stub `{online:true}` (giữ cho trang test cũ).

## 8. Dùng API
```bash
# Tạo link cashback
curl -X POST https://shopee-api.apps.neooi.com/api/link \
  -H "x-api-key: <API_KEY>" -H "Content-Type: application/json" \
  -d '{"originalLink":"https://s.shopee.vn/xxxxx","userId":"u12345"}'

# Trạng thái worker
curl -H "x-api-key: <API_KEY>" https://shopee-api.apps.neooi.com/api/worker/status
```

### Cấu trúc lỗi (tất cả endpoint)
```json
{ "ok": false, "code": "CAPTCHA", "error": "Mô tả lỗi.", "hint": "Hướng xử lý." }
```

| code | HTTP | Ý nghĩa |
|---|---|---|
| `MISSING_LINK` | 400 | Thiếu `originalLink` |
| `INVALID_SUBID` | 400 | SubId chứa ký tự không hợp lệ (cần `[a-zA-Z0-9]`) |
| `WORKER_NOT_READY` | 503 | Chrome chưa khởi động |
| `NOT_LOGGED_IN` | 503 | Chưa đăng nhập Shopee |
| `CAPTCHA` | 503 | Auto-solve thất bại; admin cần vào noVNC |
| `FETCH_ERROR` | 503 | Chrome mất kết nối Shopee |
| `PAGE_NAVIGATED` | 503 | Trang bị đổi giữa chừng; retry ngay |
| `SHOPEE_FAIL_2` | 502 | URL sai định dạng |
| `SHOPEE_FAIL_3` | 502 | Sản phẩm không trong chương trình / sub_id lỗi |
| `SHOPEE_FAIL_4` | 502 | Vượt giới hạn Shopee |

## 9. Secrets
**Không commit giá trị thật vào repo (public).** Giá trị thật nằm ở:
- **Bộ nhớ dự án của AI** (`.claude/.../memory/` — tự nạp ở phiên sau).
- **Dokploy**: Env (`VNC_PASSWORD`, `SADCAPTCHA_API_KEY`) + File Mount `config.json` (`apiKey`).
- `config.json` local (đã `.gitignore`).

Các secret: `apiKey` (header `x-api-key`), `VNC_PASSWORD` (noVNC), `SADCAPTCHA_API_KEY` (auto-solve captcha), `config.notify.telegram.*` (tuỳ chọn).

## 10. Bẫy đã gặp (đừng lặp lại)
- `page.screenshot()` **treo vô hạn** khi cửa sổ Chrome bị ẩn/minimize (headful). Đã bọc timeout 4s trong `saveShot()`. Đừng bỏ timeout đó.
- Cửa sổ Puppeteer **tự launch** trên Windows hay render **trắng/treo** → dùng **connect mode**.
- Profile Chrome mới → Shopee bắt **captcha** (device lạ). Phải giải 1 lần qua UI (nhận `AC_CERT_D`).
- File `.sh` phải LF (đã có `.gitattributes`) để chạy trong container Linux.
- KHÔNG commit `config.json`, `.chrome-profile/`, `worker-screen.png`, `captcha.png` (đã `.gitignore`).
- **SingletonLock (Chrome `Code:21`):** Container bị kill không sạch để lại file `SingletonLock` trong Chrome profile → lần khởi động sau Chrome từ chối mở (`Code:21`), `init()` throw lỗi, `state.ready` mãi `false`. Fix đã có: `init()` tự xóa `SingletonLock/Cookie/Socket` trước `puppeteer.launch()`. Đừng bỏ đoạn này.
- **SubId gạch dưới / ký tự đặc biệt:** `userId` như `"test_u001"` (có `_`) hay `"user 1"` (có khoảng trắng) → Shopee trả `failCode 3`. Server đã validate `[a-zA-Z0-9]` trước khi gọi Shopee, trả `400 INVALID_SUBID`. Đừng thêm `_` vào userId.
- **URL có `%20`:** Link Shopee chứa khoảng trắng đã encode (`%20`) → Shopee trả `failCode 3`. Dùng link có `-` thay thế.
- **SadCaptcha selector:** Shopee hay đổi class tên phần tử captcha. Selector đã có fallback nhiều lớp trong `solveCaptcha()`. Nếu auto-solve báo `captcha_not_found` nhưng nhìn thấy captcha trong screenshot → cần cập nhật selector.
- Lịch sử git commit đầu (`8adffff`) còn cookie cũ hardcode — cân nhắc để repo private hoặc dọn history.

## 11. Tích hợp vào hệ thống cashback
API này là **lớp tạo link + đọc báo cáo**. Hệ thống cashback (backend riêng) đứng TRƯỚC nó và lo phần user/ví/đối soát. API này KHÔNG lưu user, KHÔNG tính tiền — chỉ nhận `userId` để gắn vào SubId.

### Luồng tổng thể
```
User bấm "lấy link" ─▶ Cashback Backend ─POST /api/link {originalLink,userId}─▶ Shopee Aff API ─▶ shortLink
User mua qua shortLink ─▶ Shopee ghi nhận đơn (kèm sub_ids)
Cron đối soát ─GET /api/report─▶ lọc theo sub_ids[0]=userId ─▶ cộng cashback vào ví user
```

### 11.1 Tạo link (khi user yêu cầu)
- Gọi `POST /api/link` với `userId` = mã user trong hệ thống cashback → API gắn vào `subId1`.
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
- Chạy cron (vd mỗi 30–60 phút) gọi `GET /api/report?days=N`.
- Mỗi item có (tên trường có 2 biến thể, dùng `a || b`): `order_sn`/`orderId`, `sub_ids`/`subIds`, `commission`/`estimated_commission`, `order_status`/`display_order_status`, `purchase_time`, `shop_name`, `item_name`.
- **Quy user:** `subId1` (phần tử đầu `sub_ids`) chính là `userId`.
```js
async function reconcile() {
  const r = await fetch(process.env.SHOPEE_API + "/api/report?days=14&size=100",
    { headers: { "x-api-key": process.env.SHOPEE_API_KEY } }).then(x => x.json());
  if (!r.ok) { /* alert admin, KHÔNG retry dồn dập */ return; }
  for (const o of r.list) {
    const orderSn = o.order_sn || o.orderId;
    const subs = o.sub_ids || o.subIds || [];
    const userId = subs[0];
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
- **Trạng thái đơn:** chỉ **trả cashback khi đơn ĐÃ XÁC NHẬN/hoàn tất**; đơn `pending` thì ghi nhận chờ; đơn **bị huỷ → thu hồi (clawback)** cashback nếu đã tạm cộng.

### 11.4 Xử lý lỗi khi tích hợp
| Tình huống | code | HTTP | Backend nên làm |
|---|---|---|---|
| Thiếu `originalLink` | `MISSING_LINK` | 400 | Lỗi input, sửa request |
| userId có ký tự đặc biệt | `INVALID_SUBID` | 400 | Lỗi input, sửa userId (chỉ `[a-zA-Z0-9]`) |
| Sai `x-api-key` | — | 401 | Kiểm tra config |
| Chrome chưa sẵn sàng | `WORKER_NOT_READY` | 503 | Thử lại sau 5–10 giây |
| Chưa đăng nhập | `NOT_LOGGED_IN` | 503 | Báo admin vào noVNC đăng nhập |
| Captcha auto-solve thất bại | `CAPTCHA` | 503 | Báo admin noVNC; **hàng đợi lại link**, đừng spam retry |
| URL sai định dạng | `SHOPEE_FAIL_2` | 502 | Sửa link (dùng shopee.vn trực tiếp) |
| Sản phẩm không hợp lệ | `SHOPEE_FAIL_3` | 502 | Kiểm tra sản phẩm có trong chương trình affiliate |
| timeout | — | 504 | Thử lại 1 lần sau vài giây |

### 11.5 Lưu ý vận hành khi tích hợp
- **Giãn nhịp gọi `/api/link`**: Chrome chạy tuần tự ~1 link/lần; đừng bắn ồ ạt → dễ captcha/cờ tài khoản. Cache thì phần lớn request không chạm API.
- Trước khi tạo link hàng loạt, kiểm tra `GET /api/worker/status` → `loggedIn:true` mới gọi.
- Đặt `SHOPEE_API` + `SHOPEE_API_KEY` ở backend cashback qua biến môi trường.
- Nếu cần **tạo nhiều link/lần**: hiện chưa có endpoint batch — có thể bổ sung `POST /api/links` (mảng) dùng `batchCustomLink` để 1 lần ký tạo N link.
