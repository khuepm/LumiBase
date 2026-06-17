# Design Document — Realtime Subscriptions

## Overview

Chuẩn hoá subscription trên nền WS+ticket+DO sẵn có: protocol message chung (Zod ở shared), DO `SiteRoom` quản subscription + filter + permission, broadcast item mutation async, client SDK reconnect/re-subscribe, Studio live updates. Trục: **protocol là contract chung** (FE/DO cùng schema), **permission nhất quán** (subscribe + broadcast đều qua PermissionService), **filter tái dùng** `conditions.ts`.

## Architecture

### Protocol chung (`packages/shared/src/realtime/protocol.ts`)

```ts
// client → server
export const clientMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), subId: z.string(), collection: z.string(), filter: conditionRuleSchema.optional() }),
  z.object({ type: z.literal('unsubscribe'), subId: z.string() }),
  z.object({ type: z.literal('ping') }),
]);
// server → client
export const serverMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), subId: z.string() }),
  z.object({ type: z.literal('event'), subId: z.string(), collection: z.string(), action: z.enum(['create','update','delete']), key: z.string(), payload: z.record(z.unknown()).nullable() }),
  z.object({ type: z.literal('error'), subId: z.string().optional(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);
export const PROTOCOL = 'lumibase-sync-v1';
```

### Site_Room Durable Object

```ts
// state per connection: { ws, userId, roles, subs: Map<subId, { collection, filter? }> }
onMessage(ws, raw):
  msg = clientMsg.parse(raw)            // sai → send error, không ngắt
  subscribe:
     assertCanRead(userId/roles, collection)   // PermissionService — thiếu quyền → error
     subs.set(subId, { collection, filter }); send ack
  unsubscribe: subs.delete(subId)
  ping: send pong

broadcast(ev: { collection, action, key, payload }):   // gọi từ event ingest
  for each conn, for each sub matching ev.collection:
     if sub.filter && !evaluateRule(sub.filter, ev.payload) continue
     if !stillCanRead(conn, ev.collection) continue
     payload' = filterFieldsByPermission(conn, ev.payload)    // field-level (Req 3.5)
     send event { subId, collection, action, key, payload: payload' }
```

### Event ingest từ ItemService

Giống flow event dispatch — sau commit mutate item, gửi event vào DO của site:

```ts
// apps/cms/src/services/realtime-dispatch.ts
export async function publishItemEvent(env, siteId, ev) {
  const room = env.runtime.realtimeRoom(siteId);   // abstraction: CF → DO stub; Docker → in-proc hub
  await room.broadcast(ev);                          // async, không block response
}
```
Runtime abstraction: CF dùng DO stub (`SITE_ROOM.get(idFromName(siteId))`), Docker dùng in-process pub/sub hub. Business logic gọi `env.runtime.realtimeRoom(siteId).broadcast(...)` — không biết backend.

### Routes (giữ + nhỏ)

```
(giữ) POST /api/v1/realtime/ticket   — JWT 1m
(giữ) GET  /api/v1/realtime          — WS upgrade → DO
```
Không cần endpoint mới; subscription qua WS message.

### Client SDK (`packages/sdk/src/realtime.ts`)

```ts
export interface RealtimeClient {
  connect(): Promise<void>;
  subscribe(collection, opts: { filter?: ConditionRule, onEvent: (ev) => void }): { unsubscribe(): void };
  status: 'connecting'|'open'|'closed';
  on(status, cb): void;
}
// nội bộ: lấy ticket → WS(region) → gửi subscribe; reconnect backoff; re-subscribe subs đang mở; ticket hết hạn → refetch
```

## Component tree (Studio)

```
lib/realtime.ts            — khởi tạo RealtimeClient singleton từ SDK
modules/content/
├─ item-list.tsx (sửa)     — useRealtimeCollection(collection): subscribe → patch/invalidate React Query
├─ item-detail.tsx (sửa)   — subscribe item đang mở → banner "đã được cập nhật" khi update event
components/app-shell.tsx    — connection status dot (status từ RealtimeClient)
hooks/use-realtime.ts       — useRealtimeCollection(collection, onEvent)
```

## Sequence — subscribe + live update

```
Studio item-list mount → RealtimeClient.subscribe('posts', {onEvent})
   SDK: (đã connect) ws.send {subscribe, subId, collection:'posts'}
   DO: assertCanRead → subs.set → send ack
User B sửa post → ItemService.update (commit) → publishItemEvent(siteId, {collection:'posts',action:'update',key,payload})
   DO.broadcast → conn A có sub 'posts' (filter pass, canRead) → send event
   SDK onEvent → React Query: patch item trong cache list → UI cập nhật
```

## Quyết định mở

1. **Docker realtime hub:** in-process EventEmitter pub/sub per-site (đủ cho single-node Docker); multi-node Docker cần Redis pub/sub — ghi là tương lai, v1 single-node.
2. **Field-level filter (Req 3.5):** tái dùng PermissionService field projection; nếu quá đắt per-broadcast, cache quyền theo (userId, collection) trong DO connection state.
3. **Backpressure:** nếu client chậm, giới hạn buffer / drop với cảnh báo — ghi rõ ngưỡng khi implement.

## Error handling

- Message sai schema → `error`, giữ kết nối.
- Subscribe collection không có quyền → `error`, không lưu sub.
- Ticket hết hạn khi reconnect → SDK refetch ticket; thất bại → status `closed` + retry backoff.
- DO/hub lỗi broadcast → log, không ảnh hưởng mutate item (đã commit).

## Testing strategy

- Protocol schema: parse/validate client/server msg; reject sai shape.
- DO: subscribe lưu sub + ack; unsubscribe ngừng nhận; filter chặn event không khớp; permission chặn subscribe; nhiều sub đồng thời.
- Broadcast: chỉ conn khớp nhận; cross-site không nhận (DO per-site); field-level lọc.
- SDK: reconnect backoff + re-subscribe; ticket refresh; status transitions.
- FE: useRealtimeCollection patch cache khi nhận event; banner editor; status dot.
- Async: mutate item không chờ broadcast.
