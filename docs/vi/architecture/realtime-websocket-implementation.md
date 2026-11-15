---
version: 2
lastUpdated: 2026-09-01T19:25:55.469Z
sourceLang: en
translatedFrom: en
sourceHash: 08e616cc9431daf2
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T03:53:46.416Z
codeVerifiedHash: 08e616cc9431daf2
codeVerifiedClaims: 26
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

- ~~Docker realtime adapter chưa có~~ — đã ship trong `realtime-audience-channels` (xem bên dưới).
- ~~Publish và connect cần dùng chung shard resolver~~ — đã ship dưới dạng `resolveRoomName()` trong `apps/cms/src/realtime/shard-config.ts`.
- Permission-aware per-subscriber payload masking nên được tách thành Phase 2 nếu cần ship nhanh Phase 1.

## Audience plane (realtime cho frontend end-user)

Các mục ở trên mô tả **studio plane** — admin user (bảng `users`) subscribe theo collection. Spec `realtime-audience-channels` (`.kiro/specs/realtime-audience-channels/`) thêm một **audience plane** thứ hai, tách biệt, dành cho end-user của frontend nằm trong một bảng do app sở hữu (khoá theo ví dụ một `citizenID`), không phải `users`.

Các thành phần chính:

- **Protocol** (`@lumibase/contracts` `realtime/protocol.ts`): Zod schema dùng chung `lumibase-sync-v1`, được mở rộng thêm frame `join`/`leave`, frame `notification`, `welcome.plane`, và envelope `RealtimeEvent` có đích `{ plane, target: { userId | subjectId | channel } }`. Frame của studio vẫn tương thích từng byte.
- **Runtime provider** (`RealtimeProvider`, ADR-002): `runtime.realtime.publish(siteId, event)`. Trên Cloudflare, lệnh này chuyển tiếp tới DO `SiteRoom`; trên Docker, nó publish vào một hub trong process làm nền cho server `ws` (`apps/cms/src/realtime/node-hub.ts`), được gắn trong `serve.ts`. Docker nhiều node (Postgres `LISTEN/NOTIFY` hoặc Redis) là việc của tương lai.
- **Fan-out** (`apps/cms/src/realtime/fan-out.ts`, `shouldDeliver`): plane → target (userId/subjectId/channel) → subscription theo collection. Bỏ echo chỉ áp dụng cho studio. Hai plane cách ly nghiêm ngặt.
- **Ticket** (`POST /api/v1/realtime/audience-ticket`): phân quyền nằm ở route, qua `resolveAudienceGrant` — hàm này ánh xạ principal frontend đã xác thực sang một `subjectId` và một allowlist channel lấy từ các claim đã được verify. Ticket đã ký mang `plane:'public'`, `subjectId`, `channels`; DO/hub tin các giá trị này và không bao giờ đọc danh tính từ client.
- **Notification** (`NotificationService`): lưu một dòng `notifications` và fan-out tới các session của người nhận (`userId` cho studio, `subjectId` cho public), bật cờ `pushed`, và cung cấp `listUndelivered`/`markPushed` để phát lại khi reconnect.
- **SDK** (`AudienceClient`): lấy audience ticket, join/leave channel, trả ra event của channel cùng notification, reconnect có backoff và join lại các channel.
- **Scale**: rate-limit/heartbeat/idle theo từng session áp dụng cho cả hai plane; `LUMIBASE_REALTIME_MAX_CONNECTIONS_PER_SUBJECT` giới hạn số session trên mỗi subject; `resolveRoomName`/`subjectBucket` hỗ trợ chia shard audience theo bucket (v1 mặc định dùng một room duy nhất `{siteId}:aud`).

Lý do thiết kế: việc bảng end-user tách khỏi `users` là có chủ ý và đúng. Cách giải quyết cho "realtime không lọc được end-user" là một địa chỉ **subject** logic, tách khỏi nguồn user, được resolve phía server từ một ticket đã verify — không phải gộp bảng.
