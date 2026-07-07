# Implementation Plan: Realtime Subscriptions

## Overview

Gap-focused trên nền WS+ticket+DO sẵn có. Thứ tự: protocol chung → DO subscription+filter+permission → event ingest → SDK client → Studio live → chất lượng.

## Tasks

- [x] 1. Protocol chung
  - [x] 1.1 `packages/shared/src/realtime/protocol.ts`: `clientMsg`/`serverMsg` (Zod discriminated union), `PROTOCOL`, filter dùng `conditionRuleSchema`
    - _Requirements: 1.1, 1.2, 1.3, 6.1_
  - [x] 1.2 Unit test: parse/validate client+server msg; reject sai shape — done: `apps/cms/src/realtime/__tests__/protocol.test.ts`
    - **Validates: Requirements 1.3, 1.4**

- [ ] 2. Site_Room subscription
  - [ ] 2.1 DO `SiteRoom`: lưu subs per-connection; subscribe (permission check qua PermissionService) → ack; unsubscribe; ping/pong; msg sai → error không ngắt — **làm một phần**: subscribe/unsubscribe/ping-pong ✅ (`site-room.ts` + `node-hub.ts`); KHÔNG có permission check qua PermissionService khi subscribe (mô hình audience-grant/plane-isolation thay thế)
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 1.4_
  - [ ] 2.2 `broadcast(ev)`: gửi tới conn khớp collection + filter (`evaluateRule`) + còn quyền; field-level lọc payload
    - _Requirements: 2.3, 3.2, 3.5, 6.2_ — **P1 (2026-07-07) — field masking ĐÃ đóng theo hướng khác**: studio collection-broadcast nay **signal-only** (`publishRealtimeEvent` gửi `payload:null`, chỉ `collection/action/itemId`); client re-fetch qua `/items` (RBAC + field mask enforced) → không row-data nào rời server chưa qua kiểm quyền (mask đúng-by-construction). CÒN THIẾU: filter `evaluateRule` per-sub + read-gate lúc subscribe (cần db trong hub — follow-up)
  - [ ] 2.3 Test DO: subscribe/ack, unsubscribe, filter chặn, permission chặn, nhiều sub, cross-site không nhận — **làm một phần**: fan-out tests (plane isolation, subject targeting) ✅; thiếu case filter chặn + permission chặn
    - **Validates: Requirements 2.1, 2.2, 2.3, 3.3**

- [ ] 3. Event ingest
  - [x] 3.1 `realtime-dispatch.ts`: `publishItemEvent(env, siteId, ev)` qua `env.runtime.realtimeRoom(siteId).broadcast` (CF DO stub / Docker in-proc hub) — done khác tên: publish qua `RealtimeProvider` (ADR-002), không phải `realtime-dispatch.ts`
    - _Requirements: 3.1, 3.3_
  - [x] 3.2 Thêm `realtimeRoom` vào runtime abstraction (CF + Docker) — done: `RealtimeProvider` trong runtime abstraction (CF DO / Docker hub)
    - _Requirements: 6.4_
  - [x] 3.3 Móc `publishItemEvent` vào ItemService sau commit — async, không block
    - _Requirements: 3.1, 3.4_
  - [ ] 3.4 Test: mutate không chờ broadcast; event tới đúng site — **chưa verify**: không thấy test "mutate không chờ broadcast" + đúng site
    - **Validates: Requirements 3.1, 3.4**

- [ ] 4. Client SDK
  - [x] 4.1 `packages/sdk/src/realtime.ts`: connect (ticket→WS region), subscribe/unsubscribe (quản subId), status
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 4.2 Reconnect backoff + re-subscribe subs đang mở; ticket hết hạn → refetch — done: exponential backoff + re-join (audience.ts + index.ts)
    - _Requirements: 4.3_
  - [ ] 4.3 Test: reconnect + re-subscribe; ticket refresh; status transitions — **chưa rà chi tiết**: `packages/sdk/src/realtime/__tests__/` tồn tại nhưng chưa đối chiếu coverage reconnect/ticket-refresh/status
    - **Validates: Requirements 4.3, 4.4**

- [ ] 5. Studio live updates
  - [x] 5.1 `hooks/use-realtime.ts` + `lib/realtime.ts` singleton; `item-list.tsx` subscribe collection → patch/invalidate React Query
    - _Requirements: 5.1_
  - [ ] 5.2 `item-detail.tsx` banner "đã cập nhật" khi update event item đang mở; `app-shell.tsx` connection status dot — **chưa làm**: không có banner "đã cập nhật" ở item-detail, không có status dot ở app-shell
    - _Requirements: 5.2, 5.3_
  - [ ] 5.3 Component test: useRealtimeCollection patch cache; banner; status dot — **chưa làm**
    - **Validates: Requirements 5.1, 5.2**

- [ ] 6. Chất lượng & Setup Impact
  - [ ] 6.1 `pnpm typecheck` + `pnpm test` pass; runtime abstraction; cập nhật `docs/en/api/hono-api-spec.md` (protocol message) — **làm một phần**: typecheck ✅; docs protocol message trong hono-api-spec chưa verify
    - _Requirements: 6.3, 6.4_
  - [ ] 6.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. DO binding `SITE_ROOM` đã có; lưu ý DO sqlite class trên free plan ([[do-sqlite-classes-free-plan]]) nếu thêm DO mới. Dự kiến `n/a` về seed/flag. Thêm dòng registry sau — **chưa làm**: spec này CHƯA có dòng Setup Impact Registry (DoD §2 yêu cầu kể cả n/a)
    - _Requirements: DoD_
