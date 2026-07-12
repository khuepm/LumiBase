# Implementation Plan: Realtime Subscriptions

> **Status (PR #208, 2026-07-06):** Tasks 1–4 pre-existed (shared protocol, `SiteRoom` DO, ItemService publish, SDK client). This PR added: **task 2.2 field filter** (optional `event.fields` allowlist → `projectPayload` strips non-public fields, Req 3.5) and **task 5** Studio UI (`lib/realtime.ts` shared-client singleton, `useRealtimeCollection`/`useRealtimeItem`/`useConnectionStatus` hooks, app-shell `ConnectionStatusDot`, item-detail "updated elsewhere" banner). Setup Impact recorded (registry #43, `n/a`).

## Overview

Gap-focused trên nền WS+ticket+DO sẵn có. Thứ tự: protocol chung → DO subscription+filter+permission → event ingest → SDK client → Studio live → chất lượng.

## Tasks

- [x] 1. Protocol chung
  - [x] 1.1 `packages/shared/src/realtime/protocol.ts`: `clientMsg`/`serverMsg` (Zod discriminated union), `PROTOCOL`, filter dùng `conditionRuleSchema`
    - _Requirements: 1.1, 1.2, 1.3, 6.1_
  - [x] 1.2 Unit test: parse/validate client+server msg; reject sai shape — done: `apps/cms/src/realtime/__tests__/protocol.test.ts`
    - **Validates: Requirements 1.3, 1.4**

- [x] 2. Site_Room subscription
  - [x] 2.1 DO `SiteRoom`: lưu subs per-connection; subscribe (permission check qua PermissionService) → ack; unsubscribe; ping/pong; msg sai → error không ngắt (deviation có chủ đích: permission check chạy tại **route phát ticket** — `readableCollections(bundle)` từ PermissionService nhúng allowlist collections vào ticket ký, DO/hub enforce `canSubscribe` fail-closed, mirror mô hình audience-grant; ticket TTL 1 phút chặn staleness; không ack frame — subscribe từ chối trả `SUBSCRIBE_FORBIDDEN`)
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 1.4_
  - [x] 2.2 `broadcast(ev)`: gửi tới conn khớp collection + filter (`evaluateRule`) + còn quyền; field-level lọc payload
    - _Requirements: 2.3, 3.2, 3.5, 6.2_ — field masking đóng qua **signal-only** (P1 2026-07-07: `payload:null`, client re-fetch `/items` — mask đúng-by-construction) + `projectPayload` allowlist (`fields`) khi có payload; filter `evaluateRule` per-sub ĐÃ làm (protocol `subscribe.filter`, đánh giá trên envelope `collection/action/itemId` vì wire signal-only không có row data); read-gate subscribe ĐÃ làm qua ticket allowlist (không cần db trong hub)
  - [x] 2.3 Test DO: subscribe/ack, unsubscribe, filter chặn, permission chặn, nhiều sub, cross-site không nhận (fan-out tests: plane isolation, subject targeting, filter chặn/khớp, `canSubscribe` fail-closed; node-hub e2e: read-gate allowlist + fail-closed no-claim + filter envelope; `studio-grant.test.ts`: bundle→allowlist)
    - **Validates: Requirements 2.1, 2.2, 2.3, 3.3**

- [x] 3. Event ingest
  - [x] 3.1 `realtime-dispatch.ts`: `publishItemEvent(env, siteId, ev)` qua `env.runtime.realtimeRoom(siteId).broadcast` (CF DO stub / Docker in-proc hub) — done khác tên: publish qua `RealtimeProvider` (ADR-002), không phải `realtime-dispatch.ts`
    - _Requirements: 3.1, 3.3_
  - [x] 3.2 Thêm `realtimeRoom` vào runtime abstraction (CF + Docker) — done: `RealtimeProvider` trong runtime abstraction (CF DO / Docker hub)
    - _Requirements: 6.4_
  - [x] 3.3 Móc `publishItemEvent` vào ItemService sau commit — async, không block
    - _Requirements: 3.1, 3.4_
  - [x] 3.4 Test: mutate không chờ broadcast; event tới đúng site
    - **Validates: Requirements 3.1, 3.4**

- [x] 4. Client SDK
  - [x] 4.1 `packages/sdk/src/realtime.ts`: connect (ticket→WS region), subscribe/unsubscribe (quản subId), status
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 4.2 Reconnect backoff + re-subscribe subs đang mở; ticket hết hạn → refetch — done: exponential backoff + re-join (audience.ts + index.ts)
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
  - [x] 6.1 `pnpm typecheck` + `pnpm test` pass; runtime abstraction; cập nhật `docs/en/api/hono-api-spec.md` (protocol message) (typecheck ✅; §9 hono-api-spec cập nhật khớp protocol thật: ticket exchange, `subscribe.filter`, event signal-only, `SUBSCRIBE_FORBIDDEN`)
    - _Requirements: 6.3, 6.4_
  - [x] 6.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. DO binding `SITE_ROOM` đã có; lưu ý DO sqlite class trên free plan ([[do-sqlite-classes-free-plan]]) nếu thêm DO mới. Dự kiến `n/a` về seed/flag. Thêm dòng registry sau (registry #30 `n/a` thêm 2026-07-07; cập nhật 2026-07-12 khi đóng filter + read-gate — vẫn không ảnh hưởng setup)
    - _Requirements: DoD_
