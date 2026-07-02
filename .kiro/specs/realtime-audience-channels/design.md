# Design Document — Realtime Audience Channels

## Overview

Bổ sung **audience plane** (end-user FE) lên nền realtime đã có (`SiteRoom` DO + ticket + `runtime` abstraction), tách khỏi **studio plane** (admin) hiện tại. Trục thiết kế:

1. **Địa chỉ logic độc lập nguồn user** — session mang `principal { plane, userId?, subjectId? }` + `channels`. Fan-out theo `target { userId | subjectId | channel }`, không còn chỉ theo collection. Đây là cái chữa gốc vấn đề Directus: lớp WS có "địa chỉ người nhận" tách rời bảng user.
2. **Authz ở tầng cấp ticket, không ở DO** — route cấp ticket (có DB/runtime) quyết định `subjectId` + allowlist `channels`. DO/hub chỉ enforce allowlist đã được ký trong ticket. Nhất quán với nguyên tắc trong `docs/en/architecture/realtime-websocket-implementation.md` (DO tránh query DB).
3. **Runtime abstraction** — `runtime.realtime.publish()` cho CF (DO) và Docker (Node hub) cùng một API (ADR-002).
4. **Tương thích ngược** — studio plane giữ nguyên protocol & hành vi; audience là phần mở rộng.

## Architecture

### Protocol mở rộng (`packages/shared/src/realtime/protocol.ts`)

Mở rộng `lumibase-sync-v1` (thêm message, không phá cũ). Nếu cần breaking → `lumibase-sync-v2`.

```ts
// client → server (bổ sung cho audience; studio giữ subscribe/unsubscribe)
export const clientMsg = z.discriminatedUnion('type', [
  // studio plane (giữ nguyên)
  z.object({ type: z.literal('subscribe'),   subId: z.string(), collection: z.string(), filter: conditionRuleSchema.optional() }),
  z.object({ type: z.literal('unsubscribe'), subId: z.string() }),
  // audience plane (mới)
  z.object({ type: z.literal('join'),  channel: z.string() }),
  z.object({ type: z.literal('leave'), channel: z.string() }),
  z.object({ type: z.literal('ping') }),
]);

// server → client
export const serverMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), sessionId: z.string(), plane: z.enum(['studio','public']) }),
  z.object({ type: z.literal('ack'),     subId: z.string() }),
  z.object({ type: z.literal('joined'),  channel: z.string() }),
  z.object({ type: z.literal('left'),    channel: z.string() }),
  z.object({ type: z.literal('event'),        subId: z.string().optional(), collection: z.string().optional(),
             action: z.enum(['create','update','delete']).optional(), itemId: z.string().optional(),
             channel: z.string().optional(), payload: z.unknown() }),
  z.object({ type: z.literal('notification'), payload: z.record(z.unknown()) }),
  z.object({ type: z.literal('presence'), users: z.array(presenceEntrySchema) }),
  z.object({ type: z.literal('error'),   subId: z.string().optional(), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
]);
export const PROTOCOL = 'lumibase-sync-v1';
```

### RealtimeEvent (server-side, mở rộng `site-room.ts`)

```ts
export interface RealtimeEvent {
  type: 'event' | 'notification';
  plane: 'studio' | 'public';
  target?: { userId?: string; subjectId?: string; channel?: string }; // rỗng = broadcast theo collection
  collection?: string;
  action?: 'create' | 'update' | 'delete';
  itemId?: string;
  payload: unknown;
  actorUserId?: string; // skip-echo CHỈ cho studio
}
```

### Session principal (mở rộng `SessionMeta`)

```ts
interface SessionMeta {
  ws: WebSocket;
  sessionId: string;
  principal: { plane: 'studio' | 'public'; userId?: string; subjectId?: string };
  subscriptions: Set<string>; // collections (studio)
  channels: Set<string>;      // joined channels (audience)
  allowedChannels: Set<string>; // allowlist từ ticket — chỉ join được trong này
  // presence, rate-limit, heartbeat: giữ nguyên
}
```

### Fan-out matching (thay `SiteRoom.publish`)

```ts
async publish(event: RealtimeEvent): Promise<void> {
  const payload = JSON.stringify(toClientMessage(event));
  for (const s of this.sessions.values()) {
    if (s.principal.plane !== event.plane) continue;          // R1: cô lập plane

    const t = event.target;
    if (t) {                                                   // R2/R3: targeted
      const matchUser    = !!t.userId    && t.userId    === s.principal.userId;
      const matchSubject = !!t.subjectId && t.subjectId === s.principal.subjectId;
      const matchChannel = !!t.channel   && s.channels.has(t.channel);
      if (!matchUser && !matchSubject && !matchChannel) continue;
    } else if (event.collection) {                             // legacy studio broadcast
      if (!s.subscriptions.has(event.collection)) continue;
    } else {
      continue; // không target, không collection → không gửi cho ai
    }

    // skip-echo chỉ cho studio admin
    if (event.actorUserId && s.principal.plane === 'studio'
        && s.principal.userId === event.actorUserId) continue;

    try { s.ws.send(payload); } catch { /* disconnected */ }
  }
}
```

### Ticket flow (mở rộng `routes/realtime.ts`)

**Hai loại ticket, cùng endpoint hoặc tách endpoint:**

```
POST /api/v1/realtime/ticket          → studio ticket (giữ nguyên): payload {plane:'studio', userId, roles, siteId}
POST /api/v1/realtime/audience-ticket → audience ticket (mới):
     - route NÀY chịu trách nhiệm authz: app/route map citizenID→subjectId, quyết định allowlist channels
     - payload {plane:'public', subjectId, channels:[...], siteId, exp:'1m'}
```

> Authz nằm ở route cấp audience-ticket (nơi có DB + biết app context), KHÔNG ở DO. DO chỉ tin `subjectId`/`channels` đã ký trong ticket.

`GET /api/v1/realtime?ticket=...` verify ticket → đọc `plane`/`subjectId`/`channels` → forward DO (CF) hoặc handle in-proc (Docker). Không đọc `subjectId`/`channels` từ query.

### Runtime abstraction (mới — `packages/runtime/src/interfaces/realtime.ts`)

```ts
export interface RealtimeAdapter {
  /** Fan-out targeted/broadcast event vào room của site. */
  publish(siteId: string, event: RealtimeEvent): Promise<void>;
  /** Resolve room cho một WS upgrade (route gọi để forward). */
  resolveRoom(siteId: string, opts?: { plane?: 'studio'|'public'; shardKey?: string }): RealtimeRoomRef;
}
```

- **CF adapter** (`adapters/cloudflare/realtime.ts`): `publish` → `SITE_ROOM.get(idFromName(shardKey)).fetch('/publish', ...)`; `resolveRoom` dùng **shared shard resolver** (R7.2) — publish & connect cùng key.
- **Docker adapter** (`adapters/docker/realtime.ts`): single-node = in-process `EventEmitter` hub per site + `@hono/node-ws` WS server gắn vào `serve.ts`; multi-node (tương lai) = Postgres `LISTEN/NOTIFY` hoặc Redis pub/sub làm transport, mỗi node giữ WS local.

`ItemService` + notification service gọi `runtime.realtime.publish(siteId, event)` — không biết backend.

### Notifications wiring (`notifications` table)

```ts
// sau khi insert notifications row:
await runtime.realtime.publish(siteId, {
  type: 'notification',
  plane: recipientIsAdmin ? 'studio' : 'public',
  target: recipientIsAdmin ? { userId: recipientId } : { subjectId: recipientCitizenId },
  payload: notificationRow,
});
// nếu publish gửi tới ≥1 session → set notifications.pushed = true (callback hoặc optimistic + reconcile)
```

Replay khi reconnect (R5.3): on connect, audience session có thể `join` channel inbox riêng (`inbox:<subjectId>`) hoặc gọi REST `GET /notifications?pushed=false` rồi mark — chọn ở tasks.

## Sequence — end-user FE nhận thông báo cá nhân

```
App FE login end-user (citizenID=C) → BE: POST /realtime/audience-ticket
   route authz: map C→subjectId S, allowlist channels=['order:123']
   → ticket {plane:'public', subjectId:S, channels:['order:123'], siteId}
FE: GET /realtime?ticket=... → DO/hub: session {plane:'public', subjectId:S, allowedChannels:{order:123}}
FE: send {join, channel:'order:123'} → hub: channel∈allowlist → session.channels.add → {joined}

BE event (đơn 123 đổi trạng thái):
   runtime.realtime.publish(siteId, {type:'event', plane:'public', target:{channel:'order:123'}, payload})
   hub: mọi session public có 'order:123' → send
BE thông báo riêng cho C:
   runtime.realtime.publish(siteId, {type:'notification', plane:'public', target:{subjectId:S}, payload})
   hub: session public có subjectId=S → send; set notifications.pushed=true
```

## Quyết định mở

1. **Endpoint riêng vs chung cho audience ticket:** đề xuất tách `/audience-ticket` để authz/khác payload rõ ràng; có thể gộp nếu muốn ít route.
2. **Subject ↔ citizenID mapping:** app FE sở hữu bảng user riêng + cột `citizenID`; route audience-ticket là nơi map → `subjectId`. LumiBase KHÔNG ép schema bảng đó — chỉ nhận `subjectId` đã verify. (Có thể thêm bảng tuỳ chọn `audience_subjects(site_id, subject_id, external_ref)` nếu cần audit/presence — đánh dấu optional.)
3. **Audience subscribe theo collection?** Mặc định cấm (R1.4); nếu app cần public live collection (vd bình luận công khai) → bật qua collection meta `realtime.public = true` + filter — Phase 2.
4. **Docker multi-node transport:** v1 single-node in-proc; Postgres `LISTEN/NOTIFY` (đã có Postgres) ưu tiên hơn thêm Redis — chốt khi implement.
5. **Shard audience:** v1 chưa shard (một room/site/plane); bật bucket shard khi vượt ngưỡng — resolver chung publish/connect.

## Error handling

- Ticket sai/hết hạn → `401 UNAUTHENTICATED`; SDK refetch.
- `join` channel ngoài allowlist → `error code:'CHANNEL_FORBIDDEN'`, không join, giữ kết nối.
- `subjectId`/`channels` xuất hiện trong client message → bỏ qua (chỉ tin ticket).
- Realtime tắt (kill switch / site setting) → `403 REALTIME_DISABLED`.
- publish lỗi → log, không fail mutate/notification gốc.
- Plane mismatch (studio ticket cố nhận public event) → không match, không gửi (mặc định an toàn).

## Testing strategy

- **Plane isolation:** event `plane:'studio'` không tới session `public` và ngược lại.
- **Subject targeting:** `target.subjectId=S` chỉ tới session subjectId=S; nhiều session cùng subject đều nhận; client gửi `subjectId` giả không được tin.
- **Channel authz:** join channel ∈ allowlist → joined; ngoài allowlist → CHANNEL_FORBIDDEN, không nhận event channel đó; leave dừng nhận.
- **Targeted publish:** matching theo thứ tự plane→target→collection; skip-echo chỉ studio.
- **Notifications:** tạo notification → publish đúng plane/target; pushed=true khi gửi được; replay khi reconnect.
- **Dual runtime:** CF adapter (DO stub mock) và Docker adapter (in-proc hub) cùng pass bộ test protocol; shard resolver publish==connect.
- **Scale/limit:** rate-limit, idle-timeout, maxConnectionsPerSubject áp cho audience.
- **Async:** publish không chặn mutate/notification.
- `pnpm typecheck` recursive + `pnpm test` pass.
