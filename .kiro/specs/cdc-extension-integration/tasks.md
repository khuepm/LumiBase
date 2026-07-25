# Implementation Plan — CDC Extension Integration (Change Feed & Connectors)

> Trace: mỗi task ghi requirement liên quan (Req n). Tuân non-negotiable rules `CLAUDE.md` (nanoid/uuidv7, siteId, runtime abstraction, HITL, response format, TS strict). Property tests dùng `fast-check` (≥100 iterations), đánh số theo design §12.
>
> **Trạng thái:** Phases A–H hoàn tất 2026-07-11 (toàn bộ 53 task; chốt phương án B — nanoid PK + keyset cursor `(occurredAt, id)` + safety lag 2s). Xem checkpoint 17 cho số liệu test cuối. Open items ở mục cuối file (openapi.yaml/SDK typed resources là follow-up).

## Phase A — Data model & shared schemas

- [x] 1. Schema bảng mới (Req 1.1, 3.1, 4.6, 7.1)
  - [x] 1.1 `packages/database/src/schema/cdc.ts`: thêm `cdcChangeEvents`, `cdcSubscriptions`, `cdcDeliveries` (đều nanoid PK — chốt phương án B; thứ tự qua keyset `(occurredAt, id)`, index theo design §3). Mọi bảng có `siteId`. **Tên vật lý bảng PHẢI mang prefix `lumibase_` theo ADR-010** (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`); export Drizzle giữ camelCase.
  - [x] 1.2 Export ở barrel (đã có `export * from './cdc'`)  — `packages/database/src/schema/index.ts`.
  - [x] 1.3 Migration **viết tay** `0007_cdc_change_feed.sql` theo convention 0005/0006 (`CREATE TABLE IF NOT EXISTS` + FK `DO $$ ... duplicate_object` + index idempotent — meta chỉ giữ snapshot 0000 nên KHÔNG dùng `drizzle-kit generate`) + journal entry idx 7 + thêm 3 bảng `lumibase_cdc_*` vào `rls-policies.sql` (site_isolation). Tương thích `migration-guard.ts` (ADR-010): chỉ tạo bảng prefixed.
  - [x] 1.4 Zod schemas `packages/shared/src/schemas/cdc-feed.ts` (+ cursor codec `encodeCdcCursor`/`decodeCdcCursor`): `EventEnvelopeSchema`, `SubscriptionCreateSchema`/`PatchSchema`, `AckSchema`, `ReplaySchema`, `FeedQuerySchema` (limit ≤ 500, retention 1–90) + export ở index.
  - [x] 1.5 Property test **P3 Envelope round-trip** (+ cursor codec round-trip/malformed) + unit test biên Zod (limit, retentionDays, name ≤ 128, webhook_id/extension_name theo kind) — `apps/cms/src/__tests__/cdc-feed-envelope.property.test.ts`, 8 tests. (Req 2.1, 6.1)

## Phase B — Capture (outbox writer)

- [x] 2. Outbox writer (Req 1.2–1.6)
  - [x] 2.1 `modules/cdc/change-feed/outbox-writer.ts`: build Change_Event từ mutation context (collection, itemId, operation, actor từ auth principal, source); masking field `pii`/`phi` theo `fields.classification` trước khi ghi.
  - [x] 2.2 Site-flag cache (CacheProvider, key prefix `siteId`, TTL 60s) — skip ghi khi site không bật feed; invalidate khi Subscription CRUD / setting `cdc_feed` đổi. (Req 1.5)
  - [x] 2.3 Tích hợp vào `ItemService.create/patch/delete` trong cụm side-effect sau mutation (cạnh index/realtime/flow) + dep mới `cdcActor` để factory gán đúng actor `api_key` (Req 1.1). **Ghi chú thực tế**: ItemService hiện KHÔNG bọc transaction cho bất kỳ write nào (revision/activity cũng tuần tự) → outbox ghi ngay-sau-mutation với audit warning `cdc_event_write_failed` khi fail (đường Req 1.3); đường same-tx (Req 1.2) kích hoạt khi ItemService có transactional pipeline — xem design §14.2.
  - [x] 2.4 Property test **P1 Outbox atomicity** (fake db: đúng-1-event/mutation, feed-off = 0, insert fail → đúng-1 audit warning không throw) + **P4 Masking bất biến** (+ end-to-end stored payload, tenant-prefixed flag key) — `cdc-feed-outbox.property.test.ts`, 6 tests. (Req 1.2, 1.3, 1.4, 1.5)

- [x] 3. Checkpoint 2026-07-10 — typecheck workspace pass; full CMS suite 2049 passed / 3 skipped (270 files).

## Phase C — Pull feed API & subscriptions

- [x] 4. Feed API (Req 2.1–2.5)
  - [x] 4.1 `modules/cdc/change-feed/routes.ts` (+ `feed-reader.ts`: `FeedReader` + `CdcEventStore` port với `DrizzleCdcEventStore`/`InMemoryCdcEventStore`, safety lag 2s, 410 `CURSOR_EXPIRED` + `earliestCursor`; guard ADR-011 reject frontend realm): `GET /events` cursor-based (filter, limit, `meta.nextCursor/hasMore`), guard capability `cdc:subscribe` qua PermissionService (adminAccess thoả mặc nhiên); 400 cursor lỗi, 410 `CURSOR_EXPIRED` + `earliestCursor`.
  - [x] 4.2 Property test **P2 Cursor pagination gap-free** + **P8 Filter đúng và đủ** (+ safety-lag, 410, tenant isolation store) — `cdc-feed-reader.property.test.ts`, 5 tests. (Req 2.2, 3.1)

- [x] 5. Subscription service (Req 3.1–3.5, 6.2, 6.3)
  - [x] 5.1 `subscription-service.ts` (+ `subscription-state.ts` pure: `canTransitionSubscription`/`compareKeyset`/`isAckAllowed`): CRUD (max 50/site, unique name → 409), state machine (`active/paused/dead/stale` theo design §3.2), ack (không lùi), replay (trong retention window, audit), lag computation.
  - [x] 5.2 Routes: CRUD + `/ack` + `/replay` + `/dispatch` (501 tới khi Phase D nối dispatcher) + `/deliveries`; guard PermissionService bundle.admin cho quản trị, capability `cdc:subscribe` (role-carried, admin mặc nhiên) cho events/ack; mount TRƯỚC control-plane router cùng prefix `/cdc` (use('*') admin gate của nó không nuốt feed reads); replay ghi audit `cdc_subscription_replayed`.
  - [x] 5.3 Property test **P11 Ack không lùi** (+ compareKeyset total order) + unit test toàn bộ bảng transitions — `cdc-feed-subscription-state.property.test.ts`, 6 tests. (Req 3.3, 6.2)
  - [x] 5.4 Unit test route handlers với fake services (400/403/404/409/410/501 + happy paths) — `cdc-feed-routes.test.ts`, 16 tests. (Req 2.3, 2.5, 3.2)

## Phase D — Dispatcher & webhook delivery

- [x] 6. Dispatcher core (Req 4.1, 4.4, 4.5, 4.7)
  - [x] 6.1 `dispatcher.ts` (ports SubscriptionDispatchStore/DeliveryLogStore + InMemory/Drizzle impls; safety lag 2s; lock tenant-prefixed): vòng dispatch per subscription (batch 100, tuần tự, cursor advance chỉ sau success, retry backoff 30s·2^n max 5, `consecutiveFailures` → `dead` tại 10 + notification qua notifications module); lock per subscription (cache key tenant-prefixed); ghi `lumibase_cdc_deliveries` mỗi attempt.
  - [x] 6.2 Trigger: enqueue `cdc-dispatch` qua `QueueProvider` sau mutation (best-effort, dedup theo site) + sweep 30s (pattern `scheduler-worker`) + đăng ký worker trong `serve.ts` (pattern `content-indexing`). Fallback không queue: sweep + dispatch on-demand. (Req 4.7)
  - [x] 6.3 Property test **P6 Cursor advance có điều kiện** + **P7 Retry/backoff đúng lịch**. (Req 4.4, 4.5)

- [x] 7. Webhook sender (Req 4.2, 4.3)
  - [x] 7.1 `webhook-sender.ts` (+ verifyCdcWebhookSignature cho docs/P5; redirect: 'error'): HMAC-SHA256 (WebCrypto) header `X-LumiBase-Signature: t=...,v1=...`; `guardedFetch` (validateOutboundUrl + timeout 30s + no-redirect); merge `webhooks.headers` không cho override chữ ký; subscription webhook không secret → 400 khi tạo.
  - [x] 7.2 Property test **P5 HMAC verify round-trip** + unit test header merge/SSRF reject. (Req 4.2, 4.3)

- [x] 8. Checkpoint 2026-07-11 — dispatcher/webhook tests 9/9; full suite ở checkpoint 17.

## Phase E — Extension subscriber

- [x] 9. SDK + sender (Req 5.1–5.5)
  - [x] 9.1 `packages/extension-sdk`: thêm `CdcEvent`, `CdcSubscriberDefinition`, `defineCdcSubscriber` (types-only, không runtime dep).
  - [x] 9.2 Manifest/validator (enable/disable PATCH extensions → syncExtensionCdcSubscription; collections của subscription DERIVED từ capability đã grant — host không tin khai báo trong code): capability `cdc:subscribe:<collection>`/`cdc:subscribe:*`; upload/enable kiểm tra collections khai báo ⊆ capabilities; enable extension → upsert Subscription `kind='extension'` (name `ext:<name>`), disable → `paused`. (Req 3.4, 5.2)
  - [x] 9.3 `extension-sender.ts` (ExtensionEnvelopeSender + SandboxCdcSubscriberLoader; filter theo capability Ở HOST trước sandbox): enforce filter theo capability ở host, gọi handler qua ExtensionSandbox với `withTimeout` 5s/batch; lỗi/timeout → failed batch theo Phase D. (Req 5.3, 5.4)
  - [x] 9.4 Property test **P12 Subscriber isolation** + integration test sandbox với manifest thiếu capability → bị chặn. (Req 5.2, 5.4)

## Phase F — Retention & replay

- [x] 10. Retention (Req 6.1, 6.3, 6.4)
  - [x] 10.1 `retention.ts` (RetentionStore port + InMemory/Drizzle; prune chạy trong sweep 30s của dispatch worker): prune idempotent theo `cdc_feed.retentionDays` (default 7, min 1, max 90) cho `lumibase_cdc_change_events` + `lumibase_cdc_deliveries`; giữ event chưa deliver trong retention; đánh dấu subscription `stale` khi cursor < floor + notification; scheduler đăng ký cùng sweep.
  - [x] 10.2 Property test **P10 Retention & stale**. (Req 6.1, 6.3)

## Phase G — Security, tenancy & AI skills

- [x] 11. Tenancy & capability (Req 7.1–7.3, 7.6)
  - [x] 11.1 Rà mọi query có `siteId`; queue/cache/lock key prefix site; property test **P9 Tenant isolation** + two-site smoke test (DoD §2b).
  - [x] 11.2 Capability `cdc:subscribe`/`cdc:manage` theo đúng tiền lệ `deployments:*`: dùng trong skills/guards + upgrade note CHANGELOG; KHÔNG thêm flag vào `GET /setup/capabilities` (tiền lệ deployments cũng không — SetupCapabilities chỉ có geoip/smtp; admin thoả qua adminAccess wildcard).
- [x] 12. AI skills + HITL (Req 7.4)
  - [x] 12.1 `packages/ai-skills` (5 definitions) + 5 handlers trong ai-harness (`service: 'cdc-feed'`): `listCdcSubscriptions`, `getCdcSubscriptionStatus` (read, safe), `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`, `dangerous: true`), `deleteCdcSubscription` (dangerous — tên bắt đầu `delete`).
  - [x] 12.2 HITL test (`cdc-feed-skills-hitl.test.ts`: isControlPlaneSkill + ToolRegistry riskPolicy before_execute): agent gọi `createCdcSubscription`/`replayCdcSubscription`/`deleteCdcSubscription` dưới ngưỡng autonomy → tạo `ai_approvals`, không thực thi ngay.
  - [x] 12.3 MCP coverage: thêm `packages/mcp-server/src/tools/cdc.ts` (`registerCdcTools` qua `registerCrud` cho `/cdc/subscriptions` + `registerTool` cho `/cdc/events`, `.../replay`) và wire vào `registerAllTools`; test tool đi qua REST → guard capability/HITL không bị bypass. (Req 7.8)
- [x] 13. Audit & masking (Req 7.5, 8.4) — audit log cho create/delete/pause/resume/replay (actor + diff, secret masked); masking `errorMessage` deliveries.

## Phase H — Studio UI, docs & hoàn tất

- [x] 14. Studio panel (Req 8.1, 8.3)
  - [x] 14.1 `apps/studio/src/modules/settings/change-feed-page.tsx` (+ route `/settings/change-feed` + nav): list (status/kind/lag/lastDeliveredAt), detail drawer deliveries, pause/resume/replay/dispatch với confirm dialog, wizard tạo webhook subscription (bắt buộc secret).
  - [x] 14.2 Unit test render (6 tests jsdom) với sample data + confirm dialog cho hành động phá huỷ.
- [x] 15. Docs & ví dụ (Req 9.1–9.4)
  - [x] 15.1 `docs/en/features/cdc-change-feed.md`: kiến trúc, envelope reference + versioning policy, semantics (at-least-once/ordering/idempotency/reconcile trên HTTP driver), hướng dẫn pull/webhook/extension, mục Multi-tenancy, verify chữ ký kèm code mẫu.
  - [x] 15.2 Cập nhật `docs/en/api/hono-api-spec.md` + `docs/en/data-model.md`; CHANGELOG (capability mới + upgrade note); golden fixture Event_Envelope v1 + contract test.
  - [x] 15.3 Tutorial "Build your first sink connector" — mục §5 trong `cdc-change-feed.md` (manifest + defineCdcSubscriber + idempotency; mẫu theo `lumibase-firebase-sync`) + extension mẫu (sync 1 collection ra ngoài qua sandboxed fetch, idempotent theo `event.id`, mẫu theo `lumibase-firebase-sync`).
- [x] 16. Setup Impact Registry — cập nhật row #69 `cdc-extension-integration` trong `admin-setup-wizard/setup-impact.md` từ `pending` → `done` (capability mới câu 5 = CÓ). (DoD §2)
- [x] 17. Final checkpoint 2026-07-11 — `pnpm typecheck` 14/14 packages pass; `@lumibase/cms` test 2101 passed / 3 skipped (279 files); `@lumibase/studio` test 332 passed (59 files); registry numbering OK (70 rows). Lưu ý: 2 property test ai-harness (risk/approval) mở rộng exclusion `deployments` → thêm `cdc-feed` (skills cần tenant db thật, không stub offline — phủ riêng tại `cdc-feed-skills-hitl.test.ts`).

## Việc còn mở (Open / TODO cho vòng sau)

Đã ship thêm sau A–H (follow-up round):
- [x] openapi.yaml + `@lumibase/sdk` typed resources cho toàn bộ Change Feed surface.
- [x] Capture `collections.*` / `fields.*` (SchemaService hooks; migration `0008` thêm cột `resource`; `cdcEventType` + `CDC_RESOURCE_TYPE_PREFIX`; mask item-only).
- [x] Long-polling `wait` (≤25s) trên `GET /cdc/events`.

Còn lại → gom vào spec `.kiro/specs/cdc-feed-roadmap/` (requirements/design/tasks đầy đủ):
- Realtime WS fan-out change events trên `RealtimeProvider` (audience plane) — roadmap D1/Nhóm B.
- Capture `settings.*` (nhiều đường ghi → cần seam thống nhất qua ConfigService) — roadmap D2/Nhóm A.
- Consumer-group / parallel delivery per subscription (gap-free high-water-mark) — roadmap D3/Nhóm C.
- Inbound CDC (ngoài → LumiBase) / two-way sync — roadmap D4/Nhóm D (tách spec riêng khi khởi động).
- Partition bảng outbox theo tháng nếu volume lớn (design §14.4) — roadmap D5/Nhóm E.

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
