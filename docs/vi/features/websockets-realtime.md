# Realtime / WebSocket

> Dùng **Cloudflare Durable Objects** làm coordination cho realtime per `site_id` (hoặc per "hot" collection).

## 1. Mục tiêu

- Subscribe thay đổi item: create/update/delete.
- Presence: ai đang xem/edit item nào.
- Collaborative cursors (Phase 2): patch op nhỏ trên field text/wysiwyg.
- Server push: notifications, permission changed, settings changed.

## 2. Protocol

- Endpoint `wss://api.../realtime?site=<id>&token=<jwt>`.
- Frame JSON:

### Client → Server
```json
{ "type": "subscribe", "id": "s1", "collection": "posts", "query": { "filter": {...}, "fields": ["id","title","status"] } }
{ "type": "unsubscribe", "id": "s1" }
{ "type": "presence", "scope": "items/posts/abc123" }
{ "type": "ping" }
```

### Server → Client
```json
{ "type": "subscribed", "id": "s1" }
{ "type": "event", "id": "s1", "action": "create" | "update" | "delete", "key": "posts/abc123", "data": {...} | null }
{ "type": "presence", "scope": "items/posts/abc123", "users": [{ "id":"u1", "name":"Khue" }] }
{ "type": "error", "id": "s1", "code": "FORBIDDEN" }
{ "type": "pong" }
```

## 3. Permission

- Khi subscribe: server đánh giá permission `read` của user cho collection → trả `FORBIDDEN` nếu không có.
- Trước khi push event tới client: re-evaluate row-level rule + field mask; nếu data thay đổi khiến mất quyền → push `delete` virtual.

## 4. Durable Object design

- `class SiteRoom`: 1 instance per `site_id`.
  - Maintain: `connections: Map<wsId, ConnectionState>`, `subscriptions: Map<topic, Set<wsId>>`, `presence: Map<scope, Set<userId>>`.
  - Receive event qua `fetch(/publish)` từ ItemService sau commit DB.
  - Fan-out tới connection match topic + permission.
- Hot collection có thể tách Durable Object riêng nếu lưu lượng lớn (Phase 2 — sharding).

## 5. Backpressure & limits

- Per connection: max 50 subscriptions, max 30 msg/s.
- Heartbeat 30s; idle 120s → close.
- `settings.realtime.maxConnectionsPerUser` default 5.

## 6. Integration với mutation pipeline

- Mỗi mutation thành công trong `ItemService.commit()`:
  1. Ghi `activity`.
  2. Invalidate KV cache + Next.js `revalidateTag`.
  3. POST tới Durable Object `/publish` payload `{ collection, action, item, before, after, siteId }`.

## 7. SDK client (`packages/sdk`)

```ts
const client = createLumiClient({ url, token, siteId });
const sub = client.realtime.subscribe('posts', { filter: { status: { _eq: 'published' } } });
sub.on('event', e => store.apply(e));
sub.on('error', e => ...);
sub.unsubscribe();
```

## 8. Tasks: Phase MVP-E.
