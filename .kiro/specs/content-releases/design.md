# Design Document — Content Releases

## Overview

Thiết kế cho **Content Releases**: gom các phiên bản item xuyên-collection vào một `Release` và phát hành đồng loạt (manual hoặc scheduled), à la Directus Releases. Feature thêm **hai bảng mới** (`releases`, `release_items`) và một `ReleaseService`, nhưng **tái sử dụng tối đa** hạ tầng sẵn có thay vì phát minh mới:

- **Per-item publish + editorial gate** đã có trong `ItemService` (`apps/cms/src/services/item-service.ts:717-736`) → publish của Release **ủy quyền cho `ItemService`** thay vì viết lại logic status/validation/permission/hook.
- **Revision pin**: bảng `revisions` (`packages/database/src/schema/cms.ts:244-286`) đã lưu lịch sử per-item với `delta` (RFC6902) + `staged`/`autoCommitAt` → `release_items.revisionId` ghim một phiên bản cụ thể, đúng ngữ nghĩa "collate versions".
- **Scheduler sweep**: `registerSchedulerWorker()` + `runSchedulerTick` trên queue `'content-scheduler'` (`apps/cms/src/services/scheduler-worker.ts:265-269`) → thêm một **Release_Sweep** dùng đúng pattern (periodic tick, conditional UPDATE `status != target`, idempotent, revalidation dispatch).
- **Time-bound intent concepts**: `contentIntents` (`packages/database/src/schema/content-os.ts:81-119`) cho `maintenanceWindow` (`:100`), `status`/`statusReason` circuit-breaker (`:102-104`) → scheduled Release mượn `maintenanceWindow` + circuit-breaker.
- **Dual-runtime queue**: `QueueProvider` (`packages/runtime/src/interfaces/queue.ts:15-19`) injected qua deps; không import CF bindings.

Nguyên tắc thiết kế: **publish là một hành động người/lịch, không phải agent skill** → không đụng `ai_approvals` (Req 13); editorial gate là hàng rào duyệt.

## Architecture

```
┌──────────── Editor / Admin (Studio UI · REST) ─────────────┐
│  POST /releases               create draft                 │
│  PATCH /releases/:id          add/remove items, set schedule│
│  POST /releases/:id/publish   manual publish now           │
│  GET  /releases · /releases/:id · DELETE /releases/:id     │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌────────────────────────── CMS (Hono) ──────────────────────┐
│  routes/releases.ts  → ReleaseService (siteId-scoped)       │
│                                                              │
│  ReleaseService.publish(releaseId, trigger)                 │
│    ├─ load release + release_items (scopeSite)              │
│    ├─ Atomicity_Mode:                                       │
│    │    all_or_nothing → one Drizzle tx (rollback on fail)  │
│    │    best_effort    → per-item, collect Publish_Outcome  │
│    ├─ per item: materialize revisionId delta (if pinned)    │
│    └─ DELEGATE to ItemService.update(...) ── editorial gate │
│          (item-service.ts:717-736) + validation + hooks     │
│    → set Release_Status + Publish_Outcome[] + audit         │
└───────┬──────────────────────────────────────┬──────────────┘
        │ scheduled                             │ revalidation
        ▼                                       ▼
┌─ Release_Sweep (reuse scheduler-worker) ─┐   dispatch (cache/CDN)
│ registerSchedulerWorker('content-        │
│   scheduler')  → runReleaseSweep(deps)   │   ┌──────────────────┐
│ tick: SELECT releases WHERE status=      │   │ Postgres (Drizzle)│
│   'scheduled' AND publish_at<=now()      │──▶│  releases         │
│   (per site_id), batch-bounded           │   │  release_items    │
│ conditional UPDATE status!='published'   │   │  items · revisions│
│ idempotent · maintenance_window aware    │   └──────────────────┘
└──────────────────────────────────────────┘
        ▲
   QueueProvider (runtime abstraction): CF Queues | Docker BullMQ
   (packages/runtime/src/interfaces/queue.ts) — injected via deps
```

`ReleaseService` đặt cạnh các service hiện có trong `apps/cms/src/services/`; `runReleaseSweep` đặt cạnh `runSchedulerTick` trong `scheduler-worker.ts` (hoặc một module sibling) và đăng ký trên cùng queue `'content-scheduler'` để chia sẻ một worker tick.

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (create) | §3 data model `releases`, §4.1 create flow |
| Req 2 (add items xuyên-collection) | §3 `release_items`, §4.2 addItems/removeItems |
| Req 3 (revision pin) | §3 `release_items.revisionId`, §4.5 materialize delta |
| Req 4 (list/detail) | §4.3 list/detail, §3 response shape |
| Req 5 (atomicity) | §4.4 publish flow (all_or_nothing vs best_effort), §5 Publish_Outcome |
| Req 6 (scheduled) | §6 Release_Sweep (reuse scheduler-worker), §3 `publishAt` |
| Req 7 (manual publish) | §4.4 publish flow (shared path), §4.6 endpoint |
| Req 8 (editorial gate) | §4.5 delegate to ItemService (item-service.ts:717-736) |
| Req 9 (delete) | §4.7 delete (cascade release_items) |
| Req 10 (circuit-breaker) | §6.2 transient vs business failure, §3 `statusReason` |
| Req 11 (multi-tenancy/IDs) | §3 data model (site_id, nanoid), §8 conventions |
| Req 12 (audit) | §7 audit events (reuse AuditLogger) |
| Req 13 (HITL boundary) | §9 autonomy boundary (ai_approvals n/a) |
| Req 14 (setup impact) | §10 Setup Impact |

## 2. Mô hình dữ liệu — hai bảng mới

Khác với `code-first-config` (không thêm bảng), Content Releases **cần hai bảng mới** vì khái niệm "tập phát hành xuyên-collection" chưa tồn tại. Cả hai mang `site_id`, dùng `nanoid()` (helper `id()` tại `cms.ts:23`), đặt trong `packages/database/src/schema/cms.ts` (cùng file với `items`/`revisions`).

Mọi mảnh ghép khác **tái dùng bảng sẵn có**: `items` (`cms.ts:184-242`), `revisions` (`cms.ts:244-286`). Không đổi schema của `items`/`revisions`.

## 3. Data model (`packages/database/src/schema/cms.ts`)

```ts
// Bảng releases — đơn vị phát hành xuyên-collection.
export const releases = pgTable('releases', {
  id: id(),                                   // nanoid (cms.ts:23)
  siteId: text('site_id').notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),  // Req 11.1
  name: text('name').notNull(),
  description: text('description'),
  // 'draft' | 'scheduled' | 'published' | 'failed' | 'partially_failed'
  status: text('status').default('draft').notNull(),       // Release_Status
  // 'all_or_nothing' | 'best_effort'  (Req 5.1)
  atomicityMode: text('atomicity_mode').default('all_or_nothing').notNull(),
  publishAt: timestamp('publish_at'),         // Req 6.1 (nullable)
  publishedAt: timestamp('published_at'),     // Req 5.4
  // { tz, windows: [{ dow, start, end }] } — mượn contentIntents (content-os.ts:100)
  maintenanceWindow: jsonb('maintenance_window'),          // Req 6.7 (nullable)
  // circuit-breaker detail, mượn contentIntents.statusReason (content-os.ts:104)
  statusReason: text('status_reason'),        // Req 10.1
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  siteStatusIdx: index('releases_site_status_idx').on(t.siteId, t.status),
  // Release_Sweep scan: due scheduled releases per site (Req 6.4) —
  // mirrors items.publishDueIdx (cms.ts:239).
  publishDueIdx: index('releases_publish_due_idx').on(t.siteId, t.status, t.publishAt),
}));

// Bảng release_items — junction Release ↔ item, pin tới một revision.
export const releaseItems = pgTable('release_items', {
  id: id(),
  siteId: text('site_id').notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),  // Req 11.1
  releaseId: text('release_id').notNull()
    .references(() => releases.id, { onDelete: 'cascade' }),  // Req 9.2 cascade
  collection: text('collection').notNull(),   // collection name (xuyên-collection)
  itemId: text('item_id').notNull()
    .references(() => items.id, { onDelete: 'cascade' }),
  // 'draft' | 'published' | 'archived' (items.status, cms.ts:195) — Req 2.5
  targetStatus: text('target_status').default('published').notNull(),
  // Revision pin (Req 3.1): nullable → late-bind live state at publish (Req 3.3)
  revisionId: text('revision_id').references(() => revisions.id, { onDelete: 'set null' }),
  // Publish_Outcome (Req 5.5): null until publish; 'published'|'skipped'|'failed'
  outcome: text('outcome'),
  outcomeReason: text('outcome_reason'),
  createdAt: createdAt(),
}, (t) => ({
  // Uniqueness (releaseId, collection, itemId) — Req 2.4 upsert key.
  releaseItemUnique: uniqueIndex('release_items_release_item_unique')
    .on(t.releaseId, t.collection, t.itemId),
  releaseIdx: index('release_items_release_idx').on(t.siteId, t.releaseId),
}));
```

**Release detail response** (Req 4.2-4.3): `{ data: Release & { items: ReleaseItem[] } }`. List (Req 4.1): `{ data: Release[], meta: PaginationMeta }`.

Lưu ý thiết kế:
- `targetStatus` mặc định `'published'` (Req 2.5); cho phép Release dùng để hạ `archived` đồng loạt nếu cần.
- `revisionId` `onDelete:'set null'` — nếu revision bị dọn, Release_Item rơi về late-binding (Req 3.3) thay vì gãy FK.
- `outcome`/`outcomeReason` trên junction lưu Publish_Outcome (Req 5.5) để detail phản ánh per-item kết quả mà không cần bảng outcome riêng.

## 4. Service flow — `apps/cms/src/services/release-service.ts`

`ReleaseService` nhận deps `{ db, siteId, queue?: QueueProvider, itemService | itemServiceFactory }` qua constructor (đối xứng `ItemService`). Mọi select dùng `scopeSite(table.siteId, siteId)` (Req 11.2).

### 4.1 create(input) — Req 1
1. Validate `name` (422 nếu rỗng). Validate `publishAt` không ở quá khứ nếu truyền (Req 6.2).
2. Insert `releases` với `id=nanoid()`, `siteId`, `createdBy`, `status = publishAt ? 'scheduled' : 'draft'`.
3. Trả `{ data: release }`.

### 4.2 patch(id, { addItems?, removeItems?, publishAt?, atomicityMode?, maintenanceWindow? }) — Req 2, 6.3
1. Load release scoped; 404 nếu không có. 409 `RELEASE_IMMUTABLE` nếu `status='published'` và thao tác sửa item (Req 2.6).
2. `addItems`: với mỗi `{ collection, itemId, targetStatus?, revisionId? }`:
   - Verify item tồn tại trong site (Req 2.3 `ITEM_NOT_FOUND`).
   - Validate `targetStatus` ∈ items.status set (Req 2.5).
   - Nếu `revisionId`: verify revision thuộc đúng `itemId` + site, và **không `staged=true`** chưa commit (Req 3.2, 3.5 `REVISION_STAGED`).
   - Upsert junction theo unique key `(releaseId, collection, itemId)` (Req 2.4).
3. `removeItems`: delete junction theo key, scoped.
4. `publishAt`: set tương lai → `status='scheduled'`; set null trên `scheduled` → `status='draft'` (Req 6.3); set quá khứ → 422 (Req 6.2).
5. Trả release đã cập nhật.

### 4.3 list(filter) / get(id) — Req 4
- `list`: select `releases` scoped + filter `status`, phân trang → `{ data, meta }`.
- `get`: select release + join `release_items` scoped → `{ data: release & { items } }`; 404 nếu không có (Req 4.4).

### 4.4 publish(id, { trigger: 'manual' | 'scheduled', allowEarly? }) — Req 5, 7
Đây là **đường code chung** cho cả Manual_Publish và Release_Sweep (Req 6.5 — đồng nhất hành vi).
1. Load release + items scoped. 409 `ALREADY_PUBLISHED` nếu đã `published` (Req 7.2). 422 `EMPTY_RELEASE` nếu không có item (Req 7.3).
2. Chọn nhánh theo `atomicityMode`:
   - **`all_or_nothing`** (Req 5.2): mở một Drizzle transaction. Trong tx, lặp item → gọi `publishOneItem(item, tx)`. Nếu bất kỳ item nào throw (gồm `EDITORIAL_GATE_REQUIRED`, `ITEM_DELETED`, validation) → tx rollback toàn bộ; set `status='failed'`, ghi `statusReason`, audit `release_publish_failed`. Trạng thái mọi item không đổi (Req 5.2, 8.2).
   - **`best_effort`** (Req 5.3): lặp item, mỗi item trong tx con / try-catch độc lập; thu `Publish_Outcome` per item. Nếu có cả thành công lẫn fail → `status='partially_failed'`, audit `release_partially_published` (Req 5.3, 8.3).
3. Mọi item thành công → `status='published'`, `publishedAt=now()`, audit `release_published` (Req 5.4, 12.1).
4. Persist `outcome`/`outcomeReason` lên mỗi `release_items` (Req 5.5).
5. Dispatch revalidation cho các route bị ảnh hưởng (Req 6.8 — cùng cơ chế Scheduler).

### 4.5 publishOneItem(releaseItem, tx) — Req 3.4, 8 (delegate to ItemService)
1. Nếu `item.deletedAt != null` → outcome `skipped`/`ITEM_DELETED` (best_effort) hoặc throw (all_or_nothing) (Req 5.6).
2. Nếu `revisionId` set: materialize nội dung từ `revisions.delta` (apply RFC6902 patch theo `parentId` chain hoặc snapshot) thành `data` đích (Req 3.4).
3. **Gọi `ItemService.update(collection, itemId, { data?, status: targetStatus }, { tx })`** — KHÔNG sao chép logic. Việc này tự động áp:
   - Editorial gate `item-service.ts:717-736` → throw `EDITORIAL_GATE_REQUIRED` 409 nếu chưa approved (Req 8.1, 8.4).
   - Validation, permission snapshot, hooks (Req 8.4).
4. Map kết quả → `Publish_Outcome`.

> Quyết định: `ItemService.update` cần nhận một `tx` optional để publish chạy trong transaction của Release (cho `all_or_nothing`). Cần đọc chữ ký thực lúc implement; nếu nó tự mở tx nội bộ → (a) refactor cho nhận `tx` optional (ưu tiên), hoặc (b) `ReleaseService` mở tx và gọi các bước repository mà `ItemService` expose. Xem §11 open question 2.

### 4.6 Endpoints — `apps/cms/src/routes/releases.ts`
| Method | Path | Service | Req |
|---|---|---|---|
| POST | `/api/v1/releases` | `create` | 1 |
| GET | `/api/v1/releases` | `list` | 4.1 |
| GET | `/api/v1/releases/:id` | `get` | 4.2 |
| PATCH | `/api/v1/releases/:id` | `patch` | 2, 6.3 |
| POST | `/api/v1/releases/:id/publish` | `publish({trigger:'manual'})` | 7 |
| DELETE | `/api/v1/releases/:id` | `delete` | 9 |

Route mỏng, delegate vào service; mount sau middleware auth. Manual_Publish best_effort partial → HTTP 200 với body `{ data: { status:'partially_failed', outcomes } }` (Req 7.5).

### 4.7 delete(id) — Req 9
- Delete release scoped; `release_items` cascade qua FK (Req 9.2). Cho phép mọi trạng thái (Req 9.4); xoá `scheduled` → sweep tự nhiên không pick (Req 9.3). Trả 204.

## 5. Publish_Outcome (Req 5.5)

```ts
type PublishOutcome = {
  collection: string;
  itemId: string;
  outcome: 'published' | 'skipped' | 'failed';
  reason?: 'ITEM_DELETED' | 'EDITORIAL_GATE_REQUIRED' | 'VALIDATION' | string;
};
```
Tổng hợp quyết định `Release_Status`: tất cả `published` → `published`; có `failed` ở best_effort → `partially_failed`; bất kỳ fail ở all_or_nothing → `failed` (rollback). `skipped` không tính là fail ở best_effort (Req 5.6).

## 6. Release_Sweep (Req 6, 10) — reuse `scheduler-worker.ts`

Thêm `runReleaseSweep(deps)` đối xứng `runSchedulerTick` (`scheduler-worker.ts`), đăng ký trên cùng queue:
```ts
// đối xứng registerSchedulerWorker (scheduler-worker.ts:265-269)
deps.queue?.process(SCHEDULER_QUEUE, async () => {
  await runSchedulerTick(deps);   // hiện có
  await runReleaseSweep(deps);    // mới — Content Releases
});
```
`runReleaseSweep`:
1. Per site_id: `SELECT ... FROM releases WHERE status='scheduled' AND publish_at <= now()` (dùng `releases_publish_due_idx`), **batch-bounded** (Req 10.4).
2. Với mỗi release đến hạn:
   - Nếu `maintenanceWindow` set và `now()` ngoài cửa sổ → bỏ qua tick này (Req 6.7), để tick kế tiếp trong cửa sổ xử lý.
   - Gọi `ReleaseService.publish(id, { trigger: 'scheduled' })` — **cùng đường code Manual_Publish** (Req 6.5).
3. Idempotent: publish dùng conditional/guard `status != 'published'` (Req 6.6); hai tick chồng nhau không publish hai lần (cùng kỹ thuật conditional UPDATE của Scheduler).

### 6.2 Transient vs business failure (Req 10)
- Lỗi nghiệp vụ cố định (gate, validation, item deleted) → release `failed` + `statusReason`; sweep **không** retry (Req 10.2). Người dùng PATCH `publishAt` để đưa về `scheduled`.
- Lỗi hệ thống thoáng qua (DB timeout, queue glitch) → giữ `scheduled`, không đổi `failed`, để tick sau thử lại (Req 10.3). Phân biệt bằng loại exception bắt được trong `runReleaseSweep`.

## 7. Audit & provenance (Req 12)

Tái dùng `AuditLogger` mà Scheduler dùng (`scheduler-worker.ts:252`):
- `release_published` — `{ releaseId, itemCount, mode, trigger, publishedBy }`.
- `release_partially_published` — `{ releaseId, failedCount, reasons[] }`.
- `release_publish_failed` — `{ releaseId, failedCount, reasons[] }`.

`trigger='manual'` (endpoint) vs `'scheduled'` (sweep) phân biệt nguồn (Req 12.3). Metadata chỉ chứa counts/ids/lý do, không nội dung item.

## 8. Conventions (Req 11)

- `site_id` trên cả hai bảng; mọi query `scopeSite(...)`. `ReleaseService` nhận `siteId` qua deps (như `ItemService`).
- `nanoid()` (helper `id()`); không serial.
- Queue qua `QueueProvider` injected (`packages/runtime/src/interfaces/queue.ts`); cache/revalidation qua runtime abstraction; không import CF bindings.
- Response `{ data, meta? }` / `{ errors }`.

## 9. Autonomy boundary — `ai_approvals` n/a (Req 13)

Publish là hành động do **người** (Manual_Publish) hoặc **lịch người đặt** (Scheduled_Publish) khởi tạo, không phải agent skill tự sinh. Quy tắc HITL của CLAUDE.md (skill `schema:write` hoặc tên `delete*` do agent → `ai_approvals` trước) **không áp** cho hành động người dùng. Do đó v1 **không** ghi `ai_approvals` cho publish. Editorial gate (§4.5) là hàng rào duyệt nội dung. Nếu sau này một agent đề xuất publish Release thay người, path đó phải đi qua `ai_approvals` như mọi skill agent — v1 không mở (open question §11.3).

## 10. Setup Impact (Req 14)

Rà soát 6 câu hỏi:
1. **Seed?** Không — `releases`/`release_items` rỗng khi init; Release do người tạo.
2. **Settings key bắt buộc?** Không.
3. **Policy/grant DB?** Không — gated bằng auth/permission sẵn có; editorial gate tái dùng.
4. **Bước UI wizard?** Không — quản lý Release nằm trong AppShell vận hành, không phải first-time setup.
5. **Capability flag?** Không (v1; publish-by-agent là tương lai, sẽ cần flag/approval khi đó).
6. **Backfill?** Không — instance hiện hữu chỉ thiếu hai bảng; migration `CREATE TABLE IF NOT EXISTS` lấp đầy, dữ liệu `items`/`revisions` cũ không cần đổi.

→ Kết quả dự kiến `n/a` cho seeding/flag/wizard/backfill; lưu ý duy nhất: **migration thêm bảng** (hand-written, 0012+) — ghi vào Registry với ngày rà soát.

## 11. Open questions

1. **`all_or_nothing` có thực sự "atomic" xuyên revalidation không?** DB transaction nguyên tử cho phần ghi `items`, nhưng **revalidation/CDN purge** (Req 6.8) xảy ra sau commit và không thể rollback nếu purge fail. Quyết định v1: atomicity chỉ bảo đảm ở tầng DB; purge là best-effort post-commit (retry qua queue). Nêu rõ trong docs để tránh hiểu nhầm "all_or_nothing" gồm cả cache.
2. **`ItemService.update` có nhận transaction injection không?** Cần đọc chữ ký thực lúc implement (xem §4.5). Ưu tiên (a) thêm `tx` optional để publish chạy trong một transaction; nếu quá xâm lấn, (b) `ReleaseService` mở tx và gọi repository-level upsert mà `ItemService` expose. — *Quyết định lúc implement.*
3. **Rollback một Release đã publish?** v1 **không** hỗ trợ revert nội dung sau publish (DELETE chỉ xoá bản ghi Release — Req 9.4). Vì mỗi item có revision history riêng, rollback per-item vẫn khả dụng thủ công. v2 cân nhắc "unpublish Release" gom revert. — *Ngoài phạm vi v1.*
4. **Publish-by-agent + `ai_approvals`?** v1 đóng path agent tạo/publish Release (Req 13.3). Khi mở, cần định nghĩa skill capability + autonomy cap + approval flow — đó là một feature riêng. — *Ngoài phạm vi v1.*
5. **Late-binding (`revisionId=null`) có an toàn với race không?** Nếu item bị sửa giữa lúc thêm-vào-Release và lúc scheduled publish, Release sẽ phát hành bản live tại thời điểm publish (Req 3.3), có thể khác kỳ vọng. Khuyến nghị UI nhắc pin revision cho scheduled Release. — *Hành vi có chủ đích; ghi trong docs.*
