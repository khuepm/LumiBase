# Implementation Plan: Realtime Audience Channels

## Overview

Bổ sung audience plane (end-user FE, subject/channel addressing) lên nền realtime sẵn có, tách khỏi studio plane. Phụ thuộc: nên triển khai SAU/song song với `realtime-subscriptions` (cùng đụng `protocol.ts`, `SiteRoom`, runtime abstraction). Thứ tự: protocol mở rộng → runtime interface → DO/hub plane+target → ticket audience → notifications wiring → Docker adapter → SDK → chất lượng.

## Tasks

- [x] 1. Protocol mở rộng (plane / channel / target)
  - [x] 1.1 `packages/shared/src/realtime/protocol.ts`: thêm `join`/`leave` (client), `welcome.plane`/`joined`/`left`/`notification` (server); `RealtimeEvent` thêm `plane`/`target`. Không phá message studio hiện có
    - _Requirements: 1.3, 3.1, 8.1_
  - [x] 1.2 Unit test: parse/validate message mới; studio message cũ vẫn hợp lệ (tương thích ngược)
    - **Validates: Requirements 1.3, 8.1**

- [x] 2. Runtime interface `realtime`
  - [x] 2.1 `packages/runtime/src/interfaces/realtime.ts`: `RealtimeAdapter { publish(siteId, event); resolveRoom(...) }`; export qua `interfaces/index.ts` + `runtime.ts`
    - _Requirements: 6.1_
  - [x] 2.2 Shared shard resolver (publish & connect cùng key); studio = `siteId`, audience = `siteId:aud[:bucket]`
    - _Requirements: 7.2_

- [x] 3. Hub: plane + targeted fan-out
  - [x] 3.1 `SiteRoom` (`apps/cms/src/realtime/site-room.ts`): `SessionMeta.principal{plane,userId?,subjectId?}` + `channels` + `allowedChannels`; đọc từ ticket-forwarded context, KHÔNG từ query/client
    - _Requirements: 1.1, 2.1, 2.4, 3.5_
  - [x] 3.2 Xử lý `join`/`leave`: enforce `allowedChannels`; ngoài allowlist → `error CHANNEL_FORBIDDEN`, không ngắt
    - _Requirements: 3.2, 3.4, 8.2_
  - [x] 3.3 Viết lại `publish()`: match plane → target(user/subject/channel) → collection (legacy); skip-echo chỉ studio
    - _Requirements: 1.2, 2.2, 2.3, 4.2, 4.3_
  - [x] 3.4 Test hub: plane isolation; subject targeting (nhiều session/subject, mạo danh bị chặn); channel authz join/leave; legacy collection broadcast vẫn chạy
    - **Validates: Requirements 1.2, 2.2, 3.2, 3.3**

- [x] 4. Ticket audience + route
  - [x] 4.1 `POST /api/v1/realtime/audience-ticket` (`routes/realtime.ts`): authz tại route — map citizenID→subjectId, quyết định allowlist channels; ký JWT `{plane:'public', subjectId, channels, siteId, exp:'1m'}`
    - _Requirements: 2.1, 3.1, 5(authz), 8.2_
  - [x] 4.2 `GET /api/v1/realtime`: verify ticket → đọc `plane`/`subjectId`/`channels` → forward DO/hub; KHÔNG đọc subject/channels từ query
    - _Requirements: 2.4, 3.5_
  - [x] 4.3 Studio ticket giữ nguyên (`plane:'studio'`) — backward compat
    - _Requirements: 1.3_
  - [x] 4.4 Test: audience ticket cấp đúng allowlist; ticket giả/hết hạn → 401; subject từ query bị bỏ qua
    - **Validates: Requirements 2.4, 3.5**

- [x] 5. Targeted publish + notifications wiring
  - [x] 5.1 `runtime.realtime.publish(siteId, event)` gọi từ business logic (thay đường gọi DO trực tiếp trong `ItemService.publishRealtimeEvent`)
    - _Requirements: 4.1, 4.4_
  - [x] 5.2 Notification service: khi insert `notifications` row → publish `{type:'notification', plane, target}` (admin=userId, end-user=subjectId)
    - _Requirements: 5.1, 5.4_
  - [x] 5.3 Set `notifications.pushed=true` khi gửi tới ≥1 session; replay `pushed=false` khi (re)connect
    - _Requirements: 5.2, 5.3_
  - [x] 5.4 Test: notification đúng plane/target; pushed flag; replay; cross-site cô lập
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [x] 6. Dual deployment adapters
  - [x] 6.1 CF adapter (`adapters/cloudflare/realtime.ts`): `publish`→DO stub `/publish`; `resolveRoom` dùng shared resolver
    - _Requirements: 6.2, 7.2_
  - [x] 6.2 Docker adapter (`adapters/docker/realtime.ts`): single-node in-proc hub + `@hono/node-ws` WS server gắn `serve.ts`; bỏ `501 REALTIME_NOT_AVAILABLE` khi cấu hình; multi-node (Postgres LISTEN/NOTIFY) ghi TODO
    - _Requirements: 6.3, 6.4_
  - [x] 6.3 Test adapter: cùng bộ protocol test pass trên CF (DO mock) và Docker (in-proc); shard publish==connect
    - **Validates: Requirements 6.2, 6.3, 6.5**

- [x] 7. SDK audience client
  - [x] 7.1 `packages/sdk/src/realtime`: hỗ trợ `connectAudience(ticket)`, `join(channel)`/`leave(channel)`, `onNotification`, `onChannelEvent`; reconnect + re-join channels đang mở
    - _Requirements: 4(SDK reuse), 3.4_
  - [x] 7.2 Test: re-join sau reconnect; nhận event channel + notification; ticket refresh
    - **Validates: Requirements 3.4**

- [x] 8. Scale & limit (audience)
  - [x] 8.1 Áp rate-limit/heartbeat/idle cho audience; `maxConnectionsPerSubject`; bucket shard (sau ngưỡng) qua shared resolver
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [x] 8.2 Backpressure: drop + cảnh báo khi session chậm trong channel fan-out lớn
    - _Requirements: 7.5_

- [x] 9. Chất lượng & Setup Impact
  - [x] 9.1 `pnpm typecheck` (recursive — [[typecheck-recursive-vs-per-package]]) + `pnpm test` pass; cập nhật `docs/en/api/hono-api-spec.md` (audience ticket + protocol mới) và bổ sung audience plane vào `docs/en/architecture/realtime-websocket-implementation.md`
    - _Requirements: 8.3, 8.4_
  - [x] 9.2 **Setup Impact** (DoD): rà 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md`. Lưu ý: thêm site setting realtime audience (kill switch/limit) có thể cần seed/UI; nếu thêm DO mới cho audience shard → DO sqlite class free-plan ([[do-sqlite-classes-free-plan]]). Ghi kết quả vào Registry (kể cả `n/a`)
    - _Requirements: 8.5_
