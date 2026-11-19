---
version: 2
lastUpdated: 2026-11-19T04:49:43.404Z
sourceLang: en
translatedFrom: en
sourceHash: abb915a4d020234e
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T04:49:43.404Z
codeVerifiedHash: abb915a4d020234e
codeVerifiedClaims: 4
---

# Realtime / WebSocket

Realtime cho phép client nhận thay đổi item và trạng thái presence qua WebSocket. LumiBase dùng Cloudflare Durable Objects làm hub theo từng site, còn quyền bật/tắt được chia thành nhiều lớp để dễ vận hành.

## Nên bật bằng env hay setting DB?

Dùng cả hai, nhưng mỗi lớp có trách nhiệm khác nhau:

| Lớp | Mục đích | Ai thay đổi | Khuyến nghị |
| --- | --- | --- | --- |
| Env/binding | Bật năng lực hạ tầng và kill switch cấp deploy | Operator/DevOps | Dùng để chặn toàn hệ thống hoặc môi trường không hỗ trợ WebSocket |
| `settings` table | Bật/tắt realtime theo site và cấu hình giới hạn | Admin site | Dùng cho toggle trong Studio |
| `collections.meta` | Chọn collection nào được phép realtime | Người quản trị data model | Dùng opt-in từng collection |

Quyết định mặc định:

- `SITE_ROOM` binding là điều kiện hạ tầng bắt buộc trên Cloudflare Workers.
- `LUMIBASE_REALTIME_ENABLED=false` là kill switch toàn deploy. Khi không đặt hoặc đặt `true`, hệ thống đọc tiếp site setting.
- Setting `realtime.enabled` quyết định site có dùng realtime không.
- Collection chỉ được subscribe khi `collections.meta.realtime.enabled === true`.

Mô hình này tránh việc mọi collection mới tự động phát dữ liệu realtime ngoài ý muốn.

## Cấu hình site

Tạo hoặc cập nhật setting:

```http
POST /api/v1/settings
Content-Type: application/json

{
  "key": "realtime.enabled",
  "value": {
    "enabled": true,
    "maxConnectionsPerUser": 5,
    "maxSubscriptionsPerConnection": 50
  }
}
```

Các giá trị mặc định nên dùng:

| Key | Default | Ghi chú |
| --- | --- | --- |
| `enabled` | `false` | Site phải bật rõ ràng |
| `maxConnectionsPerUser` | `5` | Giới hạn tài nguyên theo user |
| `maxSubscriptionsPerConnection` | `50` | Chống client subscribe tràn lan |
| `heartbeatSeconds` | `30` | Phù hợp với Durable Object hiện tại |
| `idleTimeoutSeconds` | `90` | Đóng kết nối im lặng |

## Bật realtime cho collection

Collection dùng trường JSONB `meta` để lưu opt-in:

```http
PATCH /api/v1/collections/posts
Content-Type: application/json

{
  "meta": {
    "realtime": {
      "enabled": true,
      "events": ["create", "update", "delete"],
      "presence": true
    }
  }
}
```

Nếu collection không có `meta.realtime.enabled: true`, server phải từ chối `subscribe` với lỗi `COLLECTION_REALTIME_DISABLED`, và `ItemService` không publish event cho collection đó.

## Endpoint

```text
wss://<cms-host>/api/v1/realtime?token=<jwt>
```

Browser WebSocket không gửi được `Authorization` header ổn định, nên token được truyền qua query string. Endpoint lấy `siteId` từ tenant middleware, không nên tin `siteId` client tự gửi.

Khi request không phải WebSocket upgrade, endpoint trả JSON trạng thái để health check nhanh:

```json
{
  "status": "realtime_ready",
  "supportedProtocols": ["lumibase-sync-v1"]
}
```

## Protocol

Client gửi:

```json
{ "type": "subscribe", "collection": "posts" }
```

```json
{ "type": "unsubscribe", "collection": "posts" }
```

```json
{ "type": "presence", "collection": "posts", "itemId": "item_123", "meta": { "name": "Ann" }, "focus": "title", "lock": "title" }
```

```json
{ "type": "pong" }
```

Server gửi:

```json
{ "type": "welcome", "sessionId": "abc123" }
```

```json
{ "type": "ping" }
```

```json
{
  "type": "event",
  "collection": "posts",
  "action": "update",
  "itemId": "item_123",
  "payload": { "title": "Published" }
}
```

```json
{
  "type": "presence",
  "users": [
    {
      "sessionId": "abc123",
      "userId": "user_1",
      "collection": "posts",
      "itemId": "item_123",
      "focus": "title",
      "lock": { "field": "title", "since": "2026-06-02T10:00:00.000Z" },
      "lastSeen": "2026-06-02T10:00:00.000Z"
    }
  ]
}
```

```json
{ "type": "error", "code": "FORBIDDEN", "message": "Read access required." }
```

## Presence, focus trường và khoá mềm

Presence là điều một phiên nói về chính nó lần gần nhất: collection và item
đang mở, một object `meta` nhỏ (tên hiển thị, avatar) và, trong trình soạn
item, hai trường tuỳ chọn (#685):

- `focus` — trường người dùng đang focus (`null` khi blur);
- `lock` — trường người dùng đang gõ, như một khoá mềm (`null` để nhả).

Server áp dụng các quy tắc sau trên cả hai runtime (Cloudflare `SiteRoom` và
Node hub mà Docker dùng):

- `userId` lấy từ ticket đã ký, không bao giờ từ message.
- `meta` lớn hơn 2 KB khi tuần tự hoá bị bỏ.
- `focus` và `lock` chỉ tồn tại ở plane studio và chỉ khi có `itemId`; chuyển
  sang item khác sẽ xoá chúng, và giá trị bỏ trống giữ nguyên giá trị trước.
  Tên trường dài 1–128 ký tự thuộc `A-Z a-z 0-9 _ . -`.
- Khi trường bị khoá thay đổi, server đóng dấu `lock.since` bằng đồng hồ của
  chính nó, nên lần giành sau trên cùng trường (một lần "take over") luôn
  thắng bất kể đồng hồ của client.
- Phiên ngắt kết nối, hoặc bị loại sau 90 giây không có heartbeat, rời presence
  ngay, nên focus và khoá của nó được xoá với mọi người.
- Mỗi người nhận chỉ nhận các mục trên collection mà ticket của họ cho phép
  (cộng các mục không thuộc collection nào).

Khoá chỉ mang tính gợi ý: chúng dẫn dắt người biên tập trong Studio (trường
hiện ai đang sửa và chỉ đọc cho tới khi người đó rời trường hoặc có người take
over); API không từ chối ghi vì chúng. Các lần lưu xung đột được bắt bởi
`If-Match`.

## SDK

```ts
import { RealtimeClient } from '@lumibase/sdk/realtime';

const realtime = new RealtimeClient({
  baseUrl: 'https://cms.example.com',
  token,
  siteId,
});

const unsubscribe = realtime.subscribe('posts', (event) => {
  console.log(event.action, event.itemId, event.payload);
});

realtime.onPresence((users) => {
  console.log(users);
});

realtime.connect();

// Later
unsubscribe();
realtime.disconnect();
```

## Permission

Server phải kiểm tra quyền ở hai thời điểm:

1. Khi subscribe: user cần quyền `read` với collection.
2. Khi publish event: payload phải được mask theo field permissions trước khi gửi.

Nếu row-level rule làm user không còn thấy item sau update, server nên gửi event dạng `delete` ảo cho subscriber đó để client xoá item khỏi cache local.

## Giới hạn hiện tại

- Durable Object `SiteRoom` chỉ khả dụng trên Cloudflare Workers. Docker chạy Node hub thay thế, cùng protocol; presence của nó bao phủ các phiên trên một process, nên khi có nhiều replica sau load balancer, hai người biên tập ở hai replica khác nhau không thấy nhau.
- Focus trường và khoá mềm chỉ mang tính gợi ý (xem trên); không có đồng biên tập từng ký tự trong một trường.

Xem tài liệu triển khai chi tiết tại [Realtime WebSocket Implementation](../architecture/realtime-websocket-implementation.md).
