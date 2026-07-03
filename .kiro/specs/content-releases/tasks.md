# Implementation Plan

## Overview

Kế hoạch triển khai **Content Releases** theo 5 phase. Phase A đặt nền dữ liệu (hai bảng mới + migration hand-written + Zod schema). Phase B xây CRUD Release + revision pin. Phase C xây publish engine (atomicity + delegate ItemService + editorial gate). Phase D nối Scheduled publish (tái dùng scheduler-worker sweep) + circuit-breaker + audit. Phase E hoàn thiện docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng.

## Tasks

### Phase A — Data model & schema foundation

- [ ] 1. Bảng `releases` + `release_items` + migration
  - [ ] 1.1 Thêm `releases` và `releaseItems` pgTable vào `packages/database/src/schema/cms.ts`: `id()` nanoid, `site_id` FK cascade, `status`/`atomicityMode`/`publishAt`/`publishedAt`/`maintenanceWindow`/`statusReason`/`createdBy` cho releases; `releaseId`/`collection`/`itemId`/`targetStatus`/`revisionId`/`outcome` cho release_items; index `releases_publish_due_idx`, unique `release_items_release_item_unique` (Req 1.2, 2.4, 11.1, 11.3; design §3)
  - [ ] 1.2 Viết migration **hand-written** (0012+, KHÔNG drizzle-kit generate) tạo hai bảng `CREATE TABLE IF NOT EXISTS` + indexes; sửa journal tương ứng (Req 14.3; design §10)
  - [ ] 1.3 Export bảng mới từ schema index nếu cần; chạy `pnpm -F @lumibase/database db:migrate` trên DB local để xác nhận migration apply sạch (Req 14.3; design §3)

- [ ] 2. Zod schemas cho Release payloads
  - [ ] 2.1 Tạo `packages/shared/src/schemas/release.ts` export `CreateReleaseSchema`, `PatchReleaseSchema` (addItems/removeItems/publishAt/atomicityMode/maintenanceWindow), `ReleaseStatusSchema`, `AtomicityModeSchema`; `targetStatus` enum khớp `items.status` (`cms.ts:195`) (Req 1.4, 2.5, 5.1; design §3, §4.2)
  - [ ] 2.2 Export từ `packages/shared/src/schemas/index.ts`; chia sẻ cho CMS (validate) + Studio (form) + SDK theo quy ước (Req 11.5; design §3)

### Phase B — Release CRUD & revision pin

- [ ] 3. ReleaseService CRUD
  - [ ] 3.1 Tạo `apps/cms/src/services/release-service.ts` class `ReleaseService` nhận deps `{ db, siteId, queue?, itemService }` (đối xứng `ItemService`); mọi select dùng `scopeSite(...)` (Req 11.1, 11.2; design §4)
  - [ ] 3.2 `create(input)`: validate name (422), validate publishAt không quá khứ, insert với `status = publishAt ? 'scheduled' : 'draft'`, `createdBy` (Req 1.1-1.5, 6.2; design §4.1)
  - [ ] 3.3 `list(filter)` + `get(id)`: list scoped + filter status + phân trang `{ data, meta }`; get join release_items, 404 nếu thiếu (Req 4.1-4.5; design §4.3)
  - [ ] 3.4 `delete(id)`: xoá scoped, release_items cascade, cho phép mọi trạng thái, trả 204 (Req 9.1-9.5; design §4.7)

- [ ] 4. Add/remove items + revision pin
  - [ ] 4.1 `patch(id, {...})` addItems/removeItems: verify item tồn tại trong site (ITEM_NOT_FOUND), validate targetStatus, upsert theo unique key, chặn sửa khi `published` (RELEASE_IMMUTABLE 409) (Req 2.1-2.7; design §4.2)
  - [ ] 4.2 Revision pin: verify `revisionId` thuộc đúng itemId + site (REVISION_NOT_FOUND), từ chối revision `staged=true` chưa commit (REVISION_STAGED) (Req 3.1, 3.2, 3.5; design §4.2)
  - [ ] 4.3 `patch` publishAt: set tương lai → `scheduled`; null trên scheduled → `draft`; quá khứ → 422 (Req 6.1-6.3; design §4.2)
  - [ ] 4.4 Route `apps/cms/src/routes/releases.ts`: POST/GET/GET:id/PATCH/DELETE, mỏng, mount sau auth (Req 1.1, 2.1, 4.1, 4.2, 9.1; design §4.6)
  - [ ] 4.5 Integration test CRUD: tạo Release, add item xuyên 2 collection khác nhau, pin revision, remove item, list/get/delete; assert scoped per site, unique upsert không nhân bản (Req 2.2, 2.4, 3.1, 4.5; design §4.2, §4.3)

### Phase C — Publish engine (atomicity + editorial gate)

- [ ] 5. publishOneItem (delegate ItemService)
  - [ ] 5.1 Đọc chữ ký thực `ItemService.update`; nếu cần cho nhận `tx` optional để publish chạy trong transaction (open question §11.2) (Req 8.4; design §4.5)
  - [ ] 5.2 `publishOneItem(releaseItem, tx)`: nếu `revisionId` set → materialize delta (RFC6902 từ `revisions`) thành data; gọi `ItemService.update(collection, itemId, { data?, status: targetStatus }, { tx })` để tái dùng editorial gate (`item-service.ts:717-736`) + validation + hooks (Req 3.4, 8.1, 8.4; design §4.5)
  - [ ] 5.3 Map kết quả → `Publish_Outcome` (`published|skipped|failed` + reason); item soft-deleted → `skipped`/ITEM_DELETED (Req 5.5, 5.6; design §4.5, §5)

- [ ] 6. publish(id, {trigger}) — atomicity modes
  - [ ] 6.1 `publish` shared path: load scoped, 409 ALREADY_PUBLISHED, 422 EMPTY_RELEASE; allowEarly cho scheduled (Req 7.1-7.4; design §4.4)
  - [ ] 6.2 `all_or_nothing`: một Drizzle tx, lặp `publishOneItem`, bất kỳ fail → rollback + `status='failed'` + statusReason; trạng thái item không đổi (Req 5.1, 5.2, 8.2; design §4.4)
  - [ ] 6.3 `best_effort`: per-item try-catch độc lập, thu Publish_Outcome, mixed → `partially_failed`; persist outcome lên release_items (Req 5.3, 5.5, 8.3; design §4.4, §5)
  - [ ] 6.4 Toàn bộ thành công → `published` + `publishedAt`; dispatch revalidation post-commit (Req 5.4, 6.8; design §4.4)
  - [ ] 6.5 Endpoint `POST /releases/:id/publish` (`trigger:'manual'`); partial best_effort → HTTP 200 body `{ data: { status:'partially_failed', outcomes } }` (Req 7.1, 7.5; design §4.6)
  - [ ] 6.6 Unit + integration test publish: all_or_nothing rollback khi 1 item fail; best_effort partial; editorial gate chặn item chưa approved ở cả hai mode; revision pin phát hành đúng phiên bản đã ghim (Req 5.2-5.6, 8.1-8.3, 3.4; design §4.4, §4.5)

### Phase D — Scheduled publish (reuse scheduler sweep) & circuit-breaker

- [ ] 7. Release_Sweep
  - [ ] 7.1 Thêm `runReleaseSweep(deps)` vào (hoặc sibling của) `apps/cms/src/services/scheduler-worker.ts`; đăng ký trên cùng queue `'content-scheduler'` cạnh `runSchedulerTick` (`scheduler-worker.ts:265-269`) qua `QueueProvider` injected (Req 6.4, 11.4; design §6)
  - [ ] 7.2 Sweep query: per site_id `status='scheduled' AND publish_at<=now()` dùng `releases_publish_due_idx`, batch-bounded; gọi `ReleaseService.publish(id, {trigger:'scheduled'})` cùng đường code manual (Req 6.4, 6.5, 10.4; design §6)
  - [ ] 7.3 Idempotent + maintenance window: conditional guard `status!='published'`; nếu `maintenanceWindow` set và now ngoài cửa sổ → hoãn tới tick sau (Req 6.6, 6.7; design §6)
  - [ ] 7.4 Circuit-breaker: lỗi nghiệp vụ → `failed`+statusReason, không retry; lỗi transient → giữ `scheduled` cho tick sau (Req 10.1-10.3; design §6.2)
  - [ ] 7.5 Integration test sweep: scheduled đến hạn được publish đúng một lần (idempotent qua 2 tick); maintenance window hoãn; failed không bị retry; transient giữ scheduled (Req 6.4-6.7, 10.2, 10.3; design §6)

- [ ] 8. Audit & provenance
  - [ ] 8.1 Ghi `release_published` / `release_partially_published` / `release_publish_failed` qua `AuditLogger` (cùng cơ chế `scheduler-worker.ts:252`); metadata counts/ids/reasons, `trigger` manual vs scheduled, không nội dung item (Req 12.1-12.4; design §7)
  - [ ] 8.2 Test audit: assert event + metadata đúng cho manual success, scheduled success, partial, failed (Req 12.1-12.3; design §7)

### Phase E — Docs, Setup Impact, DoD

- [ ] 9. Docs & API spec
  - [ ] 9.1 Cập nhật `docs/en/api/hono-api-spec.md`: thêm `POST/GET /api/v1/releases`, `GET/PATCH/DELETE /api/v1/releases/:id`, `POST /api/v1/releases/:id/publish` (params, response, error codes ALREADY_PUBLISHED/EMPTY_RELEASE/RELEASE_IMMUTABLE/EDITORIAL_GATE_REQUIRED/PUBLISH_AT_IN_PAST) (DoD §4)
  - [ ] 9.2 Cập nhật `docs/en/data-model.md`: thêm bảng `releases` + `release_items` (cột, FK, index, quan hệ tới items/revisions) (DoD §4)
  - [ ] 9.3 CHANGELOG entry cho Content Releases + cập nhật **README Release policy** mô tả manual vs scheduled publish và ngữ nghĩa atomicity (DoD §4)
  - [ ] 9.4 Trang docs ngắn mô tả workflow: tạo Release → add items xuyên-collection + pin revision → schedule/publish → outcome per item; nêu open questions (rollback v1 chưa hỗ trợ, late-binding race) (DoD §4; design §11)

- [x] 10. Setup Impact & DoD
  - [x] 10.1 **Setup Impact**: dòng #22 `n/a` thêm vào `setup-impact.md` (rà soát 2026-06-22; ghi chú migration thêm 2 bảng hand-written (0040 sau renumber)) (Req 14.1, 14.2; design §10)
  - [x] 10.2 `pnpm typecheck` recursive (15/15) ✅; targeted tests trên Postgres local: release-service (8) + releases-route (4) + scheduler-worker (5) pass (DoD §1, §3)

---

## Implementation status (2026-06-22)

**Done — Phases A–E** (commits split per task; author Javier; PR riêng).

- **Phase A** ✅ Hai bảng `releases`/`release_items` trong `cms.ts`; migration **0040 hand-written** (renumber từ 0032 khi merge main v0.15 — main đã chiếm tới 0039) + journal; applied sạch trên Postgres local. **Deviation (task 2):** KHÔNG tạo Zod schema ở `packages/shared/src/schemas/release.ts` — validate bằng inline Zod trong `routes/releases.ts`. Shared schema chỉ cần khi Studio/SDK tiêu thụ → hoãn sang khi build Studio UI.
- **Phase B** ✅ `ReleaseService` create/list/get/patch(add/remove + revision pin, RELEASE_IMMUTABLE)/delete; scoped `site_id`.
- **Phase C** ✅ publish + atomicity. **Deviation (task 5.1, 6.2):** `ItemService.patch` KHÔNG nhận `tx` (nó sở hữu hooks/search side-effects) — open question §11.2 chốt theo hướng **`all_or_nothing` = pre-flight publishability pass** (kiểm mọi item trước, không publish gì nếu có blocker) thay vì một DB transaction rollback xuyên `patch`. `best_effort` per-item outcome. Revision pin materialize `revisions.delta.after` (như `revertRevision`).
- **Phase D** ✅ `sweepDueReleases` nối vào `runSchedulerTick` (cùng queue `content-scheduler`); idempotent + maintenance-window; circuit-breaker (business fail → `failed` không retry, transient → giữ `scheduled`). Audit `release_published`/`_partially_published`/`_publish_failed` ở route.
- **Phase E** ✅ API spec §3b, data-model (`releases`/`release_items`), CHANGELOG `[Unreleased]` + migration note, `docs/en/features/content-releases.md`, Setup Impact #22.

**Verified:** 8 DB-integration tests trên Postgres thật (create, cross-collection publish, empty/double-publish guards, best_effort skipped-on-deleted, revision pin, idempotent sweep, delete cascade) + 4 route + 5 scheduler tests; recursive typecheck 15/15.
