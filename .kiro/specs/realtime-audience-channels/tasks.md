# Implementation Plan: Realtime Audience Channels

## Overview

Bổ sung audience plane (end-user FE, subject/channel addressing) lên nền realtime sẵn có, tách khỏi studio plane. Thứ tự: protocol mở rộng → runtime interface → DO/hub plane+target → ticket audience → notifications wiring → Docker adapter → SDK → scale → chất lượng.

## Tasks

- [ ] 1. Protocol mở rộng (plane / channel / target)
  - [ ] 1.1 `packages/shared/src/realtime/protocol.ts`: Zod `clientMsg`/`serverMsg` thêm join/leave, welcome.plane, joined/left/notification; `RealtimeEvent` + `RealtimeTarget`. Tương thích ngược.
  - [ ] 1.2 Unit test parse/validate + backward compat.

- [ ] 2. Runtime interface `realtime`
  - [ ] 2.1 `packages/runtime/src/interfaces/realtime.ts`: `RealtimeAdapter`; export qua index.ts + runtime.ts (optional).
  - [ ] 2.2 Shared shard resolver (studio=`siteId`, audience=`siteId:aud[:bucket]`).

- [ ] 3. Hub: plane + targeted fan-out
  - [ ] 3.1 `SiteRoom`: principal{plane,userId?,subjectId?} + channels + allowedChannels từ ticket-forwarded context.
  - [ ] 3.2 join/leave enforce allowedChannels; ngoài allowlist → CHANNEL_FORBIDDEN.
  - [ ] 3.3 publish(): match plane→target→collection; skip-echo studio only.
  - [ ] 3.4 Tests hub.

- [ ] 4. Ticket audience + route
  - [ ] 4.1 `POST /realtime/audience-ticket` (authz→subjectId+channels, JWT plane:public).
  - [ ] 4.2 `GET /realtime` đọc plane/subjectId/channels từ ticket, không từ query.
  - [ ] 4.3 Studio ticket giữ nguyên.
  - [ ] 4.4 Tests route.

- [ ] 5. Targeted publish + notifications
  - [ ] 5.1 runtime.realtime.publish từ ItemService.
  - [ ] 5.2 Notification inbox service: insert + publish plane/target.
  - [ ] 5.3 set pushed=true; replay pushed=false on connect.
  - [ ] 5.4 Tests.

- [ ] 6. Dual deployment adapters
  - [ ] 6.1 CF adapter (DO stub /publish, shared resolver).
  - [ ] 6.2 Docker adapter (in-proc hub + @hono/node-ws, bỏ 501); multi-node TODO.
  - [ ] 6.3 Tests adapter.

- [ ] 7. SDK audience client
  - [ ] 7.1 connectAudience(ticket), join/leave, onNotification, onChannelEvent; reconnect + re-join.
  - [ ] 7.2 Tests.

- [ ] 8. Scale & limits
  - [ ] 8.1 rate-limit/heartbeat/idle audience; maxConnectionsPerSubject; bucket shard.
  - [ ] 8.2 Backpressure drop+warn.

- [ ] 9. Chất lượng & Setup Impact
  - [ ] 9.1 recursive typecheck + tests; cập nhật hono-api-spec.md + realtime-websocket-implementation.md.
  - [ ] 9.2 Setup Impact registry (DoD).
