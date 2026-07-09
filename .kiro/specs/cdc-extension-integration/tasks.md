# Implementation Plan — CDC Extension Integration (Change Feed & Connectors)

> Trace: mỗi task ghi requirement liên quan (Req n). Tuân non-negotiable rules `CLAUDE.md` (nanoid/uuidv7, siteId, runtime abstraction, HITL, response format, TS strict). Property tests dùng `fast-check` (≥100 iterations), đánh số theo design §12.
>
> **Trạng thái:** spec đã duyệt, CHƯA triển khai (tạo 2026-07-03).

## Phase A — Data model & shared schemas

- [ ] 1. Schema bảng mới (Req 1.1, 3.1, 4.6, 7.1)
  - [ ] 1.1 `packages/database/src/schema/cdc.ts`: thêm `cdcChangeEvents` (uuidv7 PK), `cdcSubscriptions` (nanoid PK), `cdcDeliveries` (uuidv7 PK) + index theo design §3. Mọi bảng có `siteId`. **Tên vật lý bảng PHẢI mang prefix `lumibase_` theo ADR-010** (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`); export Drizzle giữ camelCase.
  - [ ] 1.2 Export ở barrel `packages/database/src/schema/index.ts`.
  - [ ] 1.3 Migration: sinh incremental bằng `pnpm -F @lumibase/database db:generate` (drizzle-kit) → file kế tiếp `0007_cdc_change_feed.sql` (chồng lên `0000_lumibase_init`, KHÔNG sửa init; số thứ tự thực tế theo main lúc merge) + journal entry + thêm 3 bảng (tên `lumibase_`-prefixed) vào `rls-policies.sql` (site_isolation). Đảm bảo tương thích `migration-guard.ts` (ADR-010): chỉ tạo bảng prefixed, không đụng bảng legacy.
  - [ ] 1.4 Zod schemas `packages/shared/src/schemas/cdc-feed.ts`: `EventEnvelopeSchema`, `SubscriptionCreateSchema`/`PatchSchema`, `AckSchema`, `ReplaySchema`, `FeedQuerySchema` (limit ≤ 500, retention 1–90) + export ở index.
  - [ ] 1.5 Property test **P3 Envelope round-trip** + unit test biên Zod (limit, retentionDays, name ≤ 128). (Req 2.1, 6.1)

## Phase B — Capture (outbox writer)

- [ ] 2. Outbox writer (Req 1.2–1.6)
  - [ ] 2.1 `modules/cdc/change-feed/outbox-writer.ts`: build Change_Event từ mutation context (collection, itemId, operation, actor từ auth principal, source); masking field `pii`/`phi` theo `fields.classification` trước khi ghi.
  - [ ] 2.2 Site-flag cache (CacheProvider, key prefix `siteId`, TTL 60s) — skip ghi khi site không bật feed; invalidate khi Subscription CRUD / setting `cdc_feed` đổi. (Req 1.5)
  - [ ] 2.3 Tích hợp vào `ItemService.create/update/delete`: bọc mutation + INSERT outbox trong `db.transaction` khi driver hỗ trợ; fallback ghi sau mutation + audit warning `cdc_event_write_failed` khi fail (Req 1.3). Giữ hành vi hook sync hiện có nguyên vẹn.
  - [ ] 2.4 Property test **P1 Outbox atomicity** (tx driver, fake db) + **P4 Masking bất biến**. (Req 1.2, 1.4)

- [ ] 3. Checkpoint — `pnpm typecheck` + `pnpm -F @lumibase/cms test` pass; hỏi user nếu có câu hỏi mở.

## Phase C — Pull feed API & subscriptions

- [ ] 4. Feed API (Req 2.1–2.5)
  - [ ] 4.1 `modules/cdc/change-feed/routes.ts`: `GET /events` cursor-based (filter, limit, `meta.nextCursor/hasMore`), guard capability `cdc:subscribe` qua PermissionService (adminAccess thoả mặc nhiên); 400 cursor lỗi, 410 `CURSOR_EXPIRED` + `earliestCursor`.
  - [ ] 4.2 Property test **P2 Cursor pagination gap-free** + **P8 Filter đúng và đủ**. (Req 2.2, 3.1)

- [ ] 5. Subscription service (Req 3.1–3.5, 6.2, 6.3)
  - [ ] 5.1 `subscription-service.ts`: CRUD (max 50/site, unique name → 409), state machine (`active/paused/dead/stale` theo design §3.2), ack (không lùi), replay (trong retention window, audit), lag computation.
  - [ ] 5.2 Routes: CRUD + `/ack` + `/replay` + `/dispatch` + `/deliveries` với guard như design §9 (`requireSiteAdmin` cho quản trị, capability cho ack).
  - [ ] 5.3 Property test **P11 Ack không lùi** + unit test state machine transitions. (Req 3.3, 6.2)
  - [ ] 5.4 Unit test route handlers với fake services (pattern `cdc-routes.test.ts`): 400/403/404/409/410. (Req 2.3, 2.5, 3.2)

## Phase D — Dispatcher & webhook delivery

- [ ] 6. Dispatcher core (Req 4.1, 4.4, 4.5, 4.7)
  - [ ] 6.1 `dispatcher.ts`: vòng dispatch per subscription (batch 100, tuần tự, cursor advance chỉ sau success, retry backoff 30s·2^n max 5, `consecutiveFailures` → `dead` tại 10 + notification qua notifications module); lock per subscription (cache key tenant-prefixed); ghi `lumibase_cdc_deliveries` mỗi attempt.
  - [ ] 6.2 Trigger: enqueue `cdc-dispatch` qua `QueueProvider` sau mutation (best-effort, dedup theo site) + sweep 30s (pattern `scheduler-worker`) + đăng ký worker trong `serve.ts` (pattern `content-indexing`). Fallback không queue: sweep + dispatch on-demand. (Req 4.7)
  - [ ] 6.3 Property test **P6 Cursor advance có điều kiện** + **P7 Retry/backoff đúng lịch**. (Req 4.4, 4.5)

- [ ] 7. Webhook sender (Req 4.2, 4.3)
  - [ ] 7.1 `webhook-sender.ts`: HMAC-SHA256 (WebCrypto) header `X-Lumibase-Signature: t=...,v1=...`; `guardedFetch` (validateOutboundUrl + timeout 30s + no-redirect); merge `webhooks.headers` không cho override chữ ký; subscription webhook không secret → 400 khi tạo.
  - [ ] 7.2 Property test **P5 HMAC verify round-trip** + unit test header merge/SSRF reject. (Req 4.2, 4.3)

- [ ] 8. Checkpoint — full suite pass; hỏi user nếu có câu hỏi mở.

## Phase E — Extension subscriber

- [ ] 9. SDK + sender (Req 5.1–5.5)
  - [ ] 9.1 `packages/extension-sdk`: thêm `CdcEvent`, `CdcSubscriberDefinition`, `defineCdcSubscriber` (types-only, không runtime dep).
  - [ ] 9.2 Manifest/validator: capability `cdc:subscribe:<collection>`/`cdc:subscribe:*`; upload/enable kiểm tra collections khai báo ⊆ capabilities; enable extension → upsert Subscription `kind='extension'` (name `ext:<name>`), disable → `paused`. (Req 3.4, 5.2)
  - [ ] 9.3 `extension-sender.ts`: enforce filter theo capability ở host, gọi handler qua ExtensionSandbox với `withTimeout` 5s/batch; lỗi/timeout → failed batch theo Phase D. (Req 5.3, 5.4)
  - [ ] 9.4 Property test **P12 Subscriber isolation** + integration test sandbox với manifest thiếu capability → bị chặn. (Req 5.2, 5.4)

## Phase F — Retention & replay

- [ ] 10. Retention (Req 6.1, 6.3, 6.4)
  - [ ] 10.1 `retention.ts`: prune idempotent theo `cdc_feed.retentionDays` (default 7, min 1, max 90) cho `lumibase_cdc_change_events` + `lumibase_cdc_deliveries`; giữ event chưa deliver trong retention; đánh dấu subscription `stale` khi cursor < floor + notification; scheduler đăng ký cùng sweep.
  - [ ] 10.2 Property test **P10 Retention & stale**. (Req 6.1, 6.3)

## Phase G — Security, tenancy & AI skills

- [ ] 11. Tenancy & capability (Req 7.1–7.3, 7.6)
  - [ ] 11.1 Rà mọi query có `siteId`; queue/cache/lock key prefix site; property test **P9 Tenant isolation** + two-site smoke test (DoD §2b).
  - [ ] 11.2 Đăng ký capability `cdc:subscribe`/`cdc:manage` vào capability registry + `GET /api/v1/setup/capabilities`; upgrade note CHANGELOG (giống `deployments:*`).
- [ ] 12. AI skills + HITL (Req 7.4)
  - [ ] 12.1 `packages/ai-skills`: `listCdcSubscriptions`, `getCdcSubscriptionStatus`, `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`), `deleteCdcSubscription` (dangerous — tên bắt đầu `delete`).
  - [ ] 12.2 HITL test: agent gọi `deleteCdcSubscription` dưới ngưỡng autonomy → tạo `ai_approvals`, không xoá ngay.
  - [ ] 12.3 MCP coverage: thêm `packages/mcp-server/src/tools/cdc.ts` (`registerCdcTools` qua `registerCrud` cho `/cdc/subscriptions` + `registerTool` cho `/cdc/events`, `.../replay`) và wire vào `registerAllTools`; test tool đi qua REST → guard capability/HITL không bị bypass. (Req 7.8)
- [ ] 13. Audit & masking (Req 7.5, 8.4) — audit log cho create/delete/pause/resume/replay (actor + diff, secret masked); masking `errorMessage` deliveries.

## Phase H — Studio UI, docs & hoàn tất

- [ ] 14. Studio panel (Req 8.1, 8.3)
  - [ ] 14.1 `apps/studio/src/modules/settings/change-feed-page.tsx`: list (status/kind/lag/lastDeliveredAt), detail drawer deliveries, pause/resume/replay/dispatch với confirm dialog, wizard tạo webhook subscription (bắt buộc secret).
  - [ ] 14.2 Unit test render với sample data + confirm dialog cho hành động phá huỷ.
- [ ] 15. Docs & ví dụ (Req 9.1–9.4)
  - [ ] 15.1 `docs/en/features/cdc-change-feed.md`: kiến trúc, envelope reference + versioning policy, semantics (at-least-once/ordering/idempotency/reconcile trên HTTP driver), hướng dẫn pull/webhook/extension, mục Multi-tenancy, verify chữ ký kèm code mẫu.
  - [ ] 15.2 Cập nhật `docs/en/api/hono-api-spec.md` + `docs/en/data-model.md`; CHANGELOG (capability mới + upgrade note); golden fixture Event_Envelope v1 + contract test.
  - [ ] 15.3 Tutorial "Build your first sink connector" + extension mẫu (sync 1 collection ra ngoài qua sandboxed fetch, idempotent theo `event.id`, mẫu theo `lumibase-firebase-sync`).
- [ ] 16. Setup Impact Registry — cập nhật row #32 `cdc-extension-integration` trong `admin-setup-wizard/setup-impact.md` từ `pending` → `done` (capability mới câu 5 = CÓ). (DoD §2)
- [ ] 17. Final checkpoint — `pnpm typecheck` toàn workspace + full test suite pass; rà lại DoD checklist đầy đủ.

## Việc còn mở (Open / TODO cho vòng sau)

- Realtime WS fan-out của change events trên `RealtimeProvider` (audience plane) — spec riêng.
- Capture cho `collections`/`fields`/settings (envelope `type` đã namespace sẵn, non-breaking).
- Long-polling (`waitSeconds`) trên pull API; partition/consumer-group song song per subscription.
- Inbound CDC (ngoài → LumiBase) / two-way sync.
- Cân nhắc partition bảng outbox theo tháng nếu volume lớn (design §14.4).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.4"] },
    { "id": 1, "tasks": ["1.3", "1.5", "2.1", "2.2", "9.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "4.1", "5.1"] },
    { "id": 3, "tasks": ["4.2", "5.2", "5.3", "5.4", "6.1", "9.2"] },
    { "id": 4, "tasks": ["6.2", "6.3", "7.1", "7.2", "9.3", "10.1"] },
    { "id": 5, "tasks": ["9.4", "10.2", "11.1", "11.2", "12.1", "13"] },
    { "id": 6, "tasks": ["12.2", "14.1", "15.1", "15.2"] },
    { "id": 7, "tasks": ["14.2", "15.3", "16", "17"] }
  ]
}
```
