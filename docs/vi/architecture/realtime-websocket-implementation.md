---
version: 1
lastUpdated: 2026-07-25T08:11:35.843Z
sourceLang: en
translatedFrom: en
sourceHash: 0582bd39b6bfd061
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:11:35.843Z
codeVerifiedHash: 0582bd39b6bfd061
codeVerifiedClaims: 20
---

# Realtime WebSocket Implementation

Tài liệu này mô tả cách hoàn thiện tích hợp WebSocket trong codebase hiện tại. Repo đã có nền tảng ban đầu:

- Route upgrade: `apps/cms/src/routes/realtime.ts`
- Durable Object hub: `apps/cms/src/realtime/site-room.ts`
- Publish từ item mutations: `apps/cms/src/services/item-service.ts`
- SDK client: `packages/sdk/src/realtime/index.ts`

Mục tiêu của phần implement còn lại là thêm enablement rõ ràng, opt-in theo collection, kiểm tra permission đầy đủ và tài liệu vận hành.

## Quyết định cấu hình

Không chọn riêng env hoặc DB setting. Dùng cấu hình 3 lớp:

1. Env/binding: kiểm soát hạ tầng và kill switch.
2. Site setting: bật/tắt theo site và giới hạn runtime.
3. Collection meta: opt-in collection cụ thể.

Thứ tự kiểm tra:

```text
SITE_ROOM binding exists
  -> LUMIBASE_REALTIME_ENABLED !== "false"
  -> settings["realtime.enabled"].value.enabled === true
  -> collections.meta.realtime.enabled === true
  -> user has read permission on collection
```

Nếu bước nào fail, server trả lỗi rõ ràng và không mở subscription.

## Data contract

### Env

Thêm vào `apps/cms/src/env.ts`:

```ts
LUMIBASE_REALTIME_ENABLED?: string;
```

Ý nghĩa:

- `false`: tắt toàn bộ realtime cho deploy.
- unset hoặc `true`: cho phép realtime nếu site setting bật.

### Site setting

Key: `realtime.enabled`

Value:

```ts
type RealtimeSiteSetting = {
  enabled: boolean;
  maxConnectionsPerUser?: number;
  maxSubscriptionsPerConnection?: number;
  heartbeatSeconds?: number;
  idleTimeoutSeconds?: number;
};
```

Default runtime:

```ts
{
  enabled: false,
  maxConnectionsPerUser: 5,
  maxSubscriptionsPerConnection: 50,
  heartbeatSeconds: 30,
  idleTimeoutSeconds: 90
}
```

### Collection meta

Không cần migration mới vì `collections.meta` đã là JSONB.

```ts
type CollectionRealtimeMeta = {
  realtime?: {
    enabled?: boolean;
    events?: Array<'create' | 'update' | 'delete'>;
    presence?: boolean;
  };
};
```

Default: disabled.

## Backend implementation

<!-- verify-code-refs: planned apps/cms/src/services/realtime-config.ts -->

### 1. Thêm realtime config service

Tạo helper nhỏ, ví dụ `apps/cms/src/services/realtime-config.ts`:

- `getRealtimeSiteConfig(db, siteId)`
- `isRealtimeDeployEnabled(env)`
- `isCollectionRealtimeEnabled(collection)`
- `assertCollectionRealtimeEnabled(db, siteId, collectionName, action?)`

Helper này đọc `settings` table và `collections.meta`, không tự kiểm tra user permission.

### 2. Cập nhật `/api/v1/realtime`

Trong `apps/cms/src/routes/realtime.ts`:

- Nếu `Upgrade` không phải websocket, trả trạng thái gồm `enabled` và lý do nếu disabled.
- Trước khi forward tới Durable Object, kiểm tra:
  - Có binding `SITE_ROOM`.
  - Env kill switch không tắt.
  - Site setting bật.
- Không lấy `siteId` từ query string. Dùng `c.get('siteId')`.
- Truyền xuống Durable Object thông tin config cần thiết qua query hoặc header nội bộ.

Lỗi đề xuất:

| Code | HTTP/WS close | Khi nào |
| --- | --- | --- |
| `REALTIME_NOT_AVAILABLE` | HTTP 501 | Thiếu `SITE_ROOM` binding |
| `REALTIME_DISABLED` | HTTP 403 | Env hoặc site setting tắt |
| `UNAUTHORIZED` | HTTP 401 | Token không hợp lệ |

### 3. Cập nhật `SiteRoom`

Trong `apps/cms/src/realtime/site-room.ts`:

- Lưu `siteId`, `userId` và giới hạn subscription trong session.
- Khi nhận `subscribe`, gọi route/service nội bộ hoặc nhận danh sách collection được phép từ Worker để kiểm tra:
  - collection opt-in realtime
  - quyền `read`
  - số lượng subscription không vượt limit
- Gửi ack:

```json
{ "type": "subscribed", "collection": "posts" }
```

- Gửi lỗi:

```json
{ "type": "error", "code": "COLLECTION_REALTIME_DISABLED", "message": "Realtime is disabled for this collection." }
```

Durable Object không nên tự query DB nếu tránh được. Worker route có DB/runtime context tốt hơn; DO nên là hub kết nối và fan-out.

### 4. Cập nhật `ItemService.publishRealtimeEvent`

Trong `apps/cms/src/services/item-service.ts`:

- Trước publish, kiểm tra:
  - deploy realtime enabled
  - site setting enabled
  - collection meta enabled
  - action nằm trong `meta.realtime.events` nếu có khai báo
- Dùng cùng shard key như route realtime. Hiện route có multi-region shard key, nhưng publish đang dùng `idFromName(siteId)`. Cần gom logic resolve DO vào helper chung để connection và publish gặp cùng room.
- Publish sau DB commit và sau khi dữ liệu đã decrypt/mask phù hợp.

Điểm quan trọng: lỗi realtime không được làm fail mutation chính.

### 5. Permission và field mask

MVP có thể kiểm tra `read` khi subscribe. Bước hoàn chỉnh cần mask payload theo từng subscriber trước khi gửi:

- Lấy permission của subscriber.
- Re-evaluate row rule với item sau mutation.
- Nếu không match, gửi `delete` ảo.
- Nếu match, mask fields theo permission rồi gửi `event`.

Vì Durable Object không có DB context tiện lợi, có hai hướng:

| Hướng | Ưu điểm | Nhược điểm |
| --- | --- | --- |
| Worker pre-compute payload theo permission group rồi publish nhiều envelope | DO đơn giản, không query DB | Cần group subscriber theo permission fingerprint |
| DO gọi Worker internal API để authorize từng event | Chính xác, dễ hiểu | Nhiều roundtrip, dễ tốn latency |

Khuyến nghị Phase 1: kiểm tra permission khi subscribe và chỉ publish payload đã qua service mask cơ bản. Phase 2: permission-aware fan-out theo subscriber.

### 6. Studio UI

Thêm UI ở Data Model collection detail:

- Toggle `Realtime enabled`.
- Checkbox event: create, update, delete.
- Toggle `Presence enabled`.

API dùng `PATCH /api/v1/collections/:name` và merge `meta.realtime`, không overwrite toàn bộ `meta` nếu có key khác.

Thêm settings page:

- Toggle site `realtime.enabled`.
- Number input `maxConnectionsPerUser`.
- Number input `maxSubscriptionsPerConnection`.

## Test plan

Backend tests:

- `GET /api/v1/realtime` không upgrade trả health JSON.
- Thiếu `SITE_ROOM` trả `REALTIME_NOT_AVAILABLE`.
- Env kill switch trả `REALTIME_DISABLED`.
- Site setting tắt trả `REALTIME_DISABLED`.
- Subscribe collection chưa opt-in trả `COLLECTION_REALTIME_DISABLED`.
- Subscribe collection opt-in nhưng thiếu quyền read trả `FORBIDDEN`.
- Mutation collection không opt-in không gọi DO publish.
- Mutation collection opt-in gọi đúng DO shard key.

SDK tests:

- Reconnect giữ lại subscriptions.
- `ping` trả `pong`.
- `subscribe()` trả unsubscribe function.
- Presence listener nhận payload đúng shape.

Manual verification:

1. Deploy Worker có `SITE_ROOM`.
2. Bật `realtime.enabled` cho site.
3. Bật `meta.realtime.enabled` cho collection `posts`.
4. Mở hai client SDK.
5. Client A subscribe `posts`.
6. Client B update item.
7. Client A nhận event đúng action/itemId.
8. Tắt collection realtime và xác nhận subscribe mới bị từ chối.

## Rollout

1. Ship env kill switch với default an toàn.
2. Ship site setting default disabled.
3. Ship collection opt-in UI.
4. Enable trên staging cho một collection không nhạy cảm.
5. Theo dõi connection count, error rate và DO logs.
6. Enable production theo từng site/collection.

## Open items

- Docker realtime adapter chưa có, nên tài liệu hiện tại xem realtime production là Cloudflare-only.
- Publish và connect cần dùng chung shard resolver để tránh lệch room khi bật multi-region.
- Permission-aware per-subscriber payload masking nên được tách thành Phase 2 nếu cần ship nhanh Phase 1.
