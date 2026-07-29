---
version: 1
lastUpdated: 2026-07-28T10:26:33.742Z
sourceLang: en
translatedFrom: en
sourceHash: 015a30205d060b97
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:26:33.742Z
codeVerifiedHash: 015a30205d060b97
codeVerifiedClaims: 28
---

# Push Notifications

LumiBase đẩy các event vận hành tới operator của Studio ngay khi chúng xảy ra,
qua hai transport:

1. **In-app realtime** — Durable Object `SiteRoom` theo từng site broadcast một
   frame `notification` tới mọi session WebSocket Studio đang kết nối. Chỉ có trên
   Cloudflare; là một no-op êm ái trên Docker và trong các context background.
2. **Web Push** — gửi có mã hoá (VAPID, RFC 8291/8292) tới mọi browser đã opt-in,
   nên operator vẫn nhận được **dù đã đóng tab**.

Cả hai đều **best-effort và không blocking**: một lỗi ở bất kỳ bên nào cũng không
bao giờ ảnh hưởng tới request đã sinh ra event đó. Vòng poll inbox của
Mission-Control (60s) vẫn là phương án dự phòng, nên không event nào bị mất —
push chỉ giảm độ trễ.

## Các event

| Kind | Phát khi | Mức độ |
|---|---|---|
| `approval` | Một HITL approval được tạo (cần reviewer). | info |
| `veto` | Một lần ghi được staged vào cửa sổ veto L3. | warning |
| `incident` | Một row `agent_incidents` được ghi lại. | warning / critical |
| `run` | Một agent run thành công hoặc thất bại. | info / warning |
| `goal` | Một goal cha chốt lại ở completed/failed. | info / warning |

Mỗi notification mang `{ id, kind, severity, title, body, deepLink, entityId, ts }`
— giống nhau trên cả hai transport để client dedupe được.

## Kiến trúc

- **Broadcaster** — `apps/cms/src/modules/notifications/agent-notifications.ts`
  (`emitAgentNotification`). Các producer chỉ giữ `db` + `siteId` nhận thêm một
  callback `AgentNotifier` tuỳ chọn; caller ở request-context dựng nó bằng
  `buildAgentNotifier(c)` (`notify-context.ts`), hàm này bind namespace DO
  (`SITE_ROOM`) và env VAPID. Caller ở background bỏ nó đi (dùng poll dự phòng).
- **Crypto cho Web Push** — `apps/cms/src/modules/notifications/web-push.ts`,
  hiện thực hoàn toàn trên Web Crypto API nên chạy được trên cả Cloudflare Workers
  và Node (package npm `web-push` chỉ chạy trên Node và cố ý không được dùng).
- **SiteRoom** — `apps/cms/src/realtime/site-room.ts` phơi ra
  `/publish-notification` và broadcast frame `notification` tới mọi session của
  site (không scope theo collection, không bị echo-suppress).
- **Subscriptions** — lưu trong `push_subscriptions` (`site_id`, `user_id`,
  `endpoint`, `p256dh`, `auth`), một row cho mỗi browser trên mỗi site. Những
  endpoint mà push service báo là đã mất (404/410) sẽ bị dọn ở lần fan-out kế tiếp.
- **Studio** — `public/sw.js` (service worker), `src/lib/push.ts` (đăng ký), cái
  chuông ở `src/components/notifications-panel.tsx` (feed in-app + toggle
  bật/tắt), và **Settings → Notifications**
  (`src/modules/settings/notifications-page.tsx`) — một trang check / verify /
  hướng dẫn theo từng tenant.

## API

Tất cả nằm dưới `/api/v1` đã xác thực và scope theo tenant:

- `GET /api/v1/push/vapid-public-key` — trả `{ data: { publicKey } }`, hoặc
  `404 PUSH_NOT_CONFIGURED` khi chưa đặt VAPID key.
- `GET /api/v1/push/status` — `{ data: { vapidConfigured, realtimeAvailable,
  subscriptions } }` cho site đang hoạt động (nuôi panel check trong Settings).
- `POST /api/v1/push/test` — gửi một notification `test` một lần tới site đang
  hoạt động qua cả hai transport; trả về một bản tóm tắt việc gửi. Scope chặt theo
  site.
- `POST /api/v1/push/subscriptions` — body `{ endpoint, keys: { p256dh, auth } }`;
  upsert subscription của caller cho site đang hoạt động.
- `DELETE /api/v1/push/subscriptions` — body `{ endpoint }`; xoá nó đi.

## Multi-tenancy

Push có đúng một **tài nguyên dùng chung ở cấp deployment** và cách ly mọi thứ còn
lại theo từng tenant:

- **Dùng chung — cặp VAPID key** (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
  `VAPID_SUBJECT`). VAPID định danh *application server* với push service
  (FCM/Mozilla/…), không phải tenant, nên một cặp key phục vụ mọi site. VAPID key
  riêng theo tenant sẽ thêm gánh nặng quản lý secret mà **không** có lợi ích cách
  ly nào — việc gửi đã được scope bởi endpoint duy nhất cùng `p256dh`/`auth` của
  từng subscription. Vì vậy `GET /vapid-public-key` trả về cùng một key cho mọi
  tenant, theo đúng thiết kế.
- **Cách ly theo tenant — subscription và việc gửi.** `push_subscriptions` có
  `site_id` và được bảo vệ bởi policy RLS `site_isolation` (`rls-policies.sql`).
  Broadcaster fan-out với `WHERE site_id = <siteId>`; Durable Object SiteRoom là
  một instance cho mỗi `siteId`. Một tenant chỉ có thể đăng ký, liệt kê, test hay
  nhận notification **của chính nó** — không có đường xuyên tenant, và
  `POST /push/test` chỉ chạm tới subscription của site đang gọi.

Nên phần *code* (crypto `web-push`, broadcaster, các route, định danh VAPID) là hạ
tầng dùng chung; còn *dữ liệu và việc fan-out khi gửi* thì scope theo tenant. Đây
là mô hình đúng như dự định.

## Test kết nối

- **Studio** — Settings → Notifications: panel *Server check* hiện trạng thái
  VAPID / realtime / subscription cho tenant hiện tại; *Send test notification*
  gửi một event `test` mà bạn sẽ thấy ở chuông và (nếu đã đăng ký) như một
  notification của hệ điều hành.
- **CLI / CI** — `apps/cms/scripts/push-test.mjs` kiểm tra trạng thái và gửi một
  test cho một tenant cho trước, không cần mở Studio:

  ```bash
  LUMIBASE_URL=https://api.example.com \
  LUMIBASE_TOKEN=<bearer> LUMIBASE_SITE=<siteId> \
  node apps/cms/scripts/push-test.mjs
  ```

## Cấu hình

Web Push cần một cặp VAPID key, cung cấp dưới dạng secret/env var:

```
VAPID_PUBLIC_KEY    base64url của điểm public P-256 thô, 65 byte
VAPID_PRIVATE_KEY   base64url của private scalar 32 byte (d)
VAPID_SUBJECT       URI liên hệ, ví dụ mailto:ops@yourdomain.com
```

Sinh một cặp key (không cần dependency thêm — dùng Web Crypto):

```bash
node apps/cms/scripts/generate-vapid-keys.mjs mailto:ops@yourdomain.com
```

Lưu output thành secret:

- **Cloudflare:** `wrangler secret put VAPID_PRIVATE_KEY` (và `VAPID_PUBLIC_KEY`,
  `VAPID_SUBJECT`); binding Durable Object `SITE_ROOM` cũng phải có mặt để có
  realtime in-app.
- **Docker / Node:** đặt ba env var đó trong environment của container.

Khi thiếu VAPID key, Web Push bị tắt từ đầu tới cuối (toggle trong Studio ẩn đi,
endpoint public-key trả 404, broadcaster bỏ qua nhánh push) — realtime in-app vẫn
chạy ở bất cứ đâu `SITE_ROOM` được bind.

## Hành vi theo runtime

| | Cloudflare | Docker / Node |
|---|---|---|
| Realtime in-app (`SITE_ROOM`) | ✅ | ➖ (không có DO; dùng poll dự phòng) |
| Web Push (đã đặt VAPID) | ✅ | ✅ |
| Poll inbox dự phòng | ✅ | ✅ |

> LƯU Ý: việc gửi Web Push end-to-end phụ thuộc vào một push service đang sống
> (FCM/Mozilla/v.v.) và VAPID key hợp lệ, nên không thể chạy thử trong một test
> harness offline. Phần crypto tất định (base64url, ký VAPID JWT, header message
> theo RFC 8291) được phủ bởi unit test ở
> `apps/cms/src/modules/notifications/__tests__/web-push.test.ts`.
