# Implementation Plan: Realtime Subscriptions

> **Status (PR #208, 2026-07-06):** Tasks 1–4 pre-existed (shared protocol, `SiteRoom` DO, ItemService publish, SDK client). This PR added: **task 2.2 field filter** (optional `event.fields` allowlist → `projectPayload` strips non-public fields, Req 3.5) and **task 5** Studio UI (`lib/realtime.ts` shared-client singleton, `useRealtimeCollection`/`useRealtimeItem`/`useConnectionStatus` hooks, app-shell `ConnectionStatusDot`, item-detail "updated elsewhere" banner). Setup Impact recorded (registry #43, `n/a`).

## Overview

Gap-focused trên nền WS+ticket+DO sẵn có. Thứ tự: protocol chung → DO subscription+filter+permission → event ingest → SDK client → Studio live → chất lượng.

## Tasks

- [x] 1. Protocol chung
  - [x] 1.1 `packages/shared/src/realtime/protocol.ts`: `clientMsg`/`serverMsg` (Zod discriminated union), `PROTOCOL`, filter dùng `conditionRuleSchema`
    - _Requirements: 1.1, 1.2, 1.3, 6.1_
  - [x] 1.2 Unit test: parse/validate client+server msg; reject sai shape
    - **Validates: Requirements 1.3, 1.4**

- [x] 2. Site_Room subscription
  - [x] 2.1 DO `SiteRoom`: lưu subs per-connection; subscribe (permission check qua PermissionService) → ack; unsubscribe; ping/pong; msg sai → error không ngắt
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 1.4_
  - [x] 2.2 `broadcast(ev)`: gửi tới conn khớp collection + filter (`evaluateRule`) + còn quyền; field-level lọc payload
    - _Requirements: 2.3, 3.2, 3.5, 6.2_
  - [x] 2.3 Test DO: subscribe/ack, unsubscribe, filter chặn, permission chặn, nhiều sub, cross-site không nhận
    - **Validates: Requirements 2.1, 2.2, 2.3, 3.3**

- [x] 3. Event ingest
  - [x] 3.1 `realtime-dispatch.ts`: `publishItemEvent(env, siteId, ev)` qua `env.runtime.realtimeRoom(siteId).broadcast` (CF DO stub / Docker in-proc hub)
    - _Requirements: 3.1, 3.3_
  - [x] 3.2 Thêm `realtimeRoom` vào runtime abstraction (CF + Docker)
    - _Requirements: 6.4_
  - [x] 3.3 Móc `publishItemEvent` vào ItemService sau commit — async, không block
    - _Requirements: 3.1, 3.4_
  - [x] 3.4 Test: mutate không chờ broadcast; event tới đúng site
    - **Validates: Requirements 3.1, 3.4**

- [x] 4. Client SDK
  - [x] 4.1 `packages/sdk/src/realtime.ts`: connect (ticket→WS region), subscribe/unsubscribe (quản subId), status
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 4.2 Reconnect backoff + re-subscribe subs đang mở; ticket hết hạn → refetch
    - _Requirements: 4.3_
  - [x] 4.3 Test: reconnect + re-subscribe; ticket refresh; status transitions
    - **Validates: Requirements 4.3, 4.4**

- [x] 5. Studio live updates
  - [x] 5.1 `hooks/use-realtime.ts` + `lib/realtime.ts` singleton; `item-list.tsx` subscribe collection → patch/invalidate React Query
    - _Requirements: 5.1_
  - [x] 5.2 `item-detail.tsx` banner "đã cập nhật" khi update event item đang mở; `app-shell.tsx` connection status dot
    - _Requirements: 5.2, 5.3_
  - [x] 5.3 Component test: `lib/realtime` singleton (shared client + status broadcast); `useRealtimeItem` fires only for the open item's update/delete (not create/other items); `useConnectionStatus` reflects broadcast  _(`lib/__tests__/realtime.test.ts`, `hooks/__tests__/use-realtime.test.tsx`)_
    - **Validates: Requirements 5.1, 5.2**

- [x] 6. Chất lượng & Setup Impact
  - [x] 6.1 `pnpm typecheck` + `pnpm test` pass; runtime abstraction; cập nhật `docs/en/api/hono-api-spec.md` (protocol message)
    - _Requirements: 6.3, 6.4_
  - [x] 6.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. DO binding `SITE_ROOM` đã có; lưu ý DO sqlite class trên free plan ([[do-sqlite-classes-free-plan]]) nếu thêm DO mới. Dự kiến `n/a` về seed/flag. Thêm dòng registry sau
    - _Requirements: DoD_
