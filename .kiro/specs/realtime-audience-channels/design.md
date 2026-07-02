# Design Document — Realtime Audience Channels

## Overview

Bổ sung **audience plane** (end-user FE) lên nền realtime đã có (`SiteRoom` DO + ticket + `runtime` abstraction), tách khỏi **studio plane** (admin) hiện tại. Trục thiết kế:

1. **Địa chỉ logic độc lập nguồn user** — session mang `principal { plane, userId?, subjectId? }` + `channels`. Fan-out theo `target { userId | subjectId | channel }`, không còn chỉ theo collection. Đây là cái chữa gốc vấn đề Directus: lớp WS có "địa chỉ người nhận" tách rời bảng user.
2. **Authz ở tầng cấp ticket, không ở DO** — route cấp ticket (có DB/runtime) quyết định `subjectId` + allowlist `channels`. DO/hub chỉ enforce allowlist đã được ký trong ticket. Nhất quán với nguyên tắc trong `docs/en/architecture/realtime-websocket-implementation.md` (DO tránh query DB).
3. **Runtime abstraction** — `runtime.realtime.publish()` cho CF (DO) và Docker (Node hub) cùng một API (ADR-002).
4. **Tương thích ngược** — studio plane giữ nguyên protocol & hành vi; audience là phần mở rộng.

## Architecture

### Protocol mở rộng (`packages/shared/src/realtime/protocol.ts`)

Mở rộng `lumibase-sync-v1` (thêm message, không phá cũ).

```ts
// client → server
//   studio (giữ nguyên): subscribe / unsubscribe / presence / pong
//   audience (mới):      join / leave / pong
// server → client
//   welcome(sessionId, plane) / ack / joined / left / event / notification / presence / error / ping / pong
export const PROTOCOL = 'lumibase-sync-v1';
```

### RealtimeEvent (server-side, mở rộng `site-room.ts` + shared)

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
  ws, sessionId,
  principal: { plane: 'studio' | 'public'; userId?: string; subjectId?: string };
  subscriptions: Set<string>;   // collections (studio)
  channels: Set<string>;        // joined channels (audience)
  allowedChannels: Set<string>; // allowlist từ ticket — chỉ join được trong này
  // presence, rate-limit, heartbeat: giữ nguyên
}
```

### Fan-out matching (thay `SiteRoom.publish`)

```
plane khớp?  →  target? (user|subject|channel)  :  collection subscription
skip-echo chỉ áp studio (actorUserId === principal.userId)
```

### Ticket flow (mở rộng `routes/realtime.ts`)

```
POST /realtime/ticket          → studio ticket (giữ nguyên): {plane:'studio', userId, roles, siteId}
POST /realtime/audience-ticket → audience ticket (mới): route authz map citizenID→subjectId + allowlist channels
                                 → {plane:'public', subjectId, channels:[...], maxConnectionsPerSubject?, siteId}
GET  /realtime?ticket=...       → verify ticket → đọc plane/subjectId/channels → forward DO/hub (không đọc từ query)
```

### Runtime abstraction (mới — `packages/runtime/src/interfaces/realtime.ts`)

```ts
export interface RealtimeAdapter {
  publish(siteId: string, event: RealtimeEvent): Promise<void>;
  resolveRoom(siteId: string, opts?: { plane?; shardKey? }): RealtimeRoomRef;
}
```

- CF adapter: `publish` → DO stub `/publish`; shared shard resolver (publish & connect cùng key).
- Docker adapter: single-node in-proc `EventEmitter` hub + `@hono/node-ws`; multi-node (Postgres LISTEN/NOTIFY) tương lai.

### Notifications wiring (`notifications` table)

Service inbox mới: insert row → `runtime.realtime.publish(siteId, {type:'notification', plane, target})`; nếu gửi được ≥1 session → set `pushed=true`; replay `pushed=false` khi reconnect.

## Quyết định mở

1. Endpoint audience-ticket tách riêng (authz/payload khác studio).
2. Subject ↔ citizenID mapping do route audience-ticket đảm nhận; LumiBase KHÔNG ép schema bảng user FE.
3. Audience subscribe theo collection mặc định cấm; bật qua collection meta là Phase 2.
4. Docker multi-node = Postgres LISTEN/NOTIFY (ưu tiên hơn Redis) — tương lai.
5. Shard audience v1 chưa bật; resolver chung sẵn sàng khi cần.

## Error handling

- Ticket sai/hết hạn → 401; join ngoài allowlist → `error CHANNEL_FORBIDDEN` (không ngắt); subjectId/channels từ client → bỏ qua; realtime tắt → 403; publish lỗi → log, không fail gốc; plane mismatch → không gửi.

## Testing strategy

- Plane isolation; subject targeting (multi-session, chống mạo danh); channel authz join/leave; targeted publish thứ tự match; skip-echo chỉ studio; notifications plane/target + pushed + replay; dual runtime (CF DO mock + Docker in-proc) cùng bộ test; scale/limit; async không chặn mutate. `pnpm typecheck` recursive + `pnpm test`.
