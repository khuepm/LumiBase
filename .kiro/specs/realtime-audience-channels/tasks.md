# Implementation Plan: Realtime Audience Channels

## Overview

Bổ sung audience plane (end-user FE, subject/channel addressing) lên nền realtime sẵn có, tách khỏi studio plane. Thứ tự: protocol mở rộng → runtime interface → DO/hub plane+target → ticket audience → notifications wiring → Docker adapter → SDK → scale → chất lượng.

## Tasks

- [x] 1. Protocol mở rộng (plane / channel / target)
  - [x] 1.1 `packages/shared/src/realtime/protocol.ts`: Zod `clientMsg`/`serverMsg` thêm join/leave, welcome.plane, joined/left/notification; `RealtimeEvent` + `RealtimeTarget`. Tương thích ngược.
  - [x] 1.2 Unit test parse/validate + backward compat.

- [x] 2. Runtime interface `realtime`
  - [x] 2.1 `packages/runtime/src/interfaces/realtime.ts`: `RealtimeAdapter`; export qua index.ts + runtime.ts (optional).
  - [x] 2.2 Shared shard resolver (studio=`siteId`, audience=`siteId:aud[:bucket]`).

- [x] 3. Hub: plane + targeted fan-out
  - [x] 3.1 `SiteRoom`: principal{plane,userId?,subjectId?} + channels + allowedChannels từ ticket-forwarded context.
  - [x] 3.2 join/leave enforce allowedChannels; ngoài allowlist → CHANNEL_FORBIDDEN.
  - [x] 3.3 publish(): match plane→target→collection; skip-echo studio only.
  - [x] 3.4 Tests hub.

- [x] 4. Ticket audience + route
  - [x] 4.1 `POST /realtime/audience-ticket` (authz→subjectId+channels, JWT plane:public).
  - [x] 4.2 `GET /realtime` đọc plane/subjectId/channels từ ticket, không từ query.
  - [x] 4.3 Studio ticket giữ nguyên.
  - [x] 4.4 Tests route.

- [x] 5. Targeted publish + notifications
  - [x] 5.1 runtime.realtime.publish từ ItemService.
  - [x] 5.2 Notification inbox service: insert + publish plane/target.
  - [x] 5.3 set pushed=true; replay pushed=false on connect.
  - [x] 5.4 Tests.

- [x] 6. Dual deployment adapters
  - [x] 6.1 CF adapter (DO stub /publish, shared resolver).
  - [x] 6.2 Docker adapter (in-proc hub + @hono/node-ws, bỏ 501); multi-node TODO.
  - [x] 6.3 Tests adapter.

- [x] 7. SDK audience client
  - [x] 7.1 connectAudience(ticket), join/leave, onNotification, onChannelEvent; reconnect + re-join.
  - [x] 7.2 Tests.

- [x] 8. Scale & limits
  - [x] 8.1 rate-limit/heartbeat/idle audience; maxConnectionsPerSubject; bucket shard.
  - [x] 8.2 Backpressure drop+warn.

- [x] 9. Chất lượng & Setup Impact
  - [x] 9.1 recursive typecheck + tests; cập nhật hono-api-spec.md + realtime-websocket-implementation.md.
  - [x] 9.2 Setup Impact registry (DoD).
