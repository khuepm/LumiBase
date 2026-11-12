# Design Document — Content Environments

## Overview

Thiết kế cho **Content Environments**: fork một site thành môi trường cô lập, rồi đưa schema và nội dung ngược về site gốc có phát hiện xung đột.

Quyết định trung tâm: **một Environment là một site con**, không phải một cột `environment_id` trên mọi bảng. LumiBase đã cô lập mọi thứ theo `site_id` (query, RLS, cache key, search index, tenant middleware). Thêm một chiều thứ hai sẽ buộc sửa mọi query và mọi policy; dùng lại chiều sẵn có thì cô lập đến miễn phí, và phần việc thật sự dồn vào ba chỗ khó: **ánh xạ danh tính** (Lineage), **tổ tiên chung** (Base), **viết lại tham chiếu**.

Tái sử dụng:

- `provisionSite()` (`apps/cms/src/services/site-provisioning.ts:25`) tạo site con + roles.
- `ConfigExportService.export` + `buildConfigDiff` (`config-diff.ts:218`) + `ConfigImportService.dryRun/apply` (`config-import-service.ts:79`, `:109`) cho Schema_Promote.
- `hashData()` (`content-version-service.ts:30`) cho Base_Hash.
- `ItemService.patch` (`item-service.ts:943`) và `revertRevision` (`:1513`) cho ghi và hoàn tác.
- `QueueProvider` (`packages/runtime/src/interfaces/queue.ts`) cho job Fork/Merge; không import CF bindings.
- Pattern pre-flight của `ReleaseService` (`all_or_nothing` = kiểm mọi item trước khi ghi) vì `ItemService.patch` không nhận `tx`.

## Architecture

```
┌──────────────── Admin / Editor (Studio · REST) ────────────────┐
│ POST   /environments                    fork (async)            │
│ GET    /environments · /environments/:key                       │
│ DELETE /environments/:key                                       │
│ POST   /environments/:key/promote/schema   { dryRun }           │
│ POST   /environments/:key/promote/content  { dryRun, items? }   │
│ POST   /environments/:key/merge            { dryRun, resolutions}│
│ POST   /environments/:key/merge-runs/:id/revert                 │
└───────────────────────────────┬────────────────────────────────┘
                                ▼
┌──────────────────────────── CMS (Hono) ─────────────────────────┐
│ routes/environments.ts → EnvironmentService (scoped: Origin)    │
│                                                                  │
│  fork ──enqueue──▶ environment-fork worker (batched, resumable) │
│        provisionSite → copy schema → copy items → rewrite refs  │
│        → write lineage                                           │
│                                                                  │
│  promoteSchema: export(env) ─ remap by lineage ─ diff(origin)   │
│                 → ConfigImportService.apply(origin)             │
│                                                                  │
│  promoteContent / merge:                                         │
│     classify(item) by lineage.baseHash vs hash(origin), hash(env)│
│     threeWay(base, origin, env) → MergePlan                      │
│     preflight(all) → ItemService(origin).patch(If-Match)        │
│     → merge_runs + lineage.baseHash update                      │
└───────┬───────────────────────────────────────────┬─────────────┘
        ▼                                           ▼
  ItemService(siteId = env)                 ItemService(siteId = origin)
        └──────────── Postgres: sites · environments ·
                      environment_lineage · merge_runs ·
                      items · revisions ────────────┘
```

Hai `ItemService` instance, mỗi cái scoped một site. `EnvironmentService` là nơi **duy nhất** cầm cả hai `siteId`, và nó tự nạp cặp (Origin, Environment) từ bảng `environments` — không nhận `siteId` thứ hai từ request.

## 1. Traceability

| Requirement | Thiết kế |
|---|---|
| Req 1 (data model) | §2 |
| Req 2 (fork) | §3 |
| Req 3 (files) | §3.4 |
| Req 4 (side systems) | §4 |
| Req 5 (list/delete/limit) | §5 |
| Req 6 (write precondition) | §6 |
| Req 7 (schema promote) | §7 |
| Req 8 (content promote) | §8 |
| Req 9 (three-way merge) | §9 |
| Req 10 (atomicity/revert) | §10 |
| Req 11 (tenancy/guards) | §11 |
| Req 12 (audit) | §10.3 |
| Req 13 (HITL) | §12 |
| Req 14 (rollout) | §13 |

## 2. Data model

Ba bảng mới trong `packages/database/src/schema/cms.ts`, tất cả `id()` nanoid.

```ts
environments {
  id, siteId            // site con, unique, FK sites cascade
  parentSiteId          // Origin, FK sites cascade
  key, name             // unique (parentSiteId, key)
  status                // forking | ready | merging | merged | failed | archived
  statusReason
  contentScope          // jsonb: { mode: 'none' | 'collections' | 'all', collections?: string[] }
  forkCursor            // jsonb: tiến độ fork để resume
  forkedBy, forkedAt, mergedAt, createdAt, updatedAt
}

environment_lineage {
  id, siteId            // = site con (để RLS + scopeSite hoạt động)
  environmentId         // FK environments cascade
  kind                  // collection | field | relation | item | file | folder
  envRowId, originRowId // originRowId null cho dòng tạo mới trong env sau khi promote
  baseHash              // hash của Origin tại lúc fork / lần promote gần nhất
  baseRevisionId        // revision mới nhất của item Origin tại lúc fork (nullable)
  baseSnapshot          // jsonb, chỉ dùng khi item chưa có revision (nullable)
  external              // true = tham chiếu chỉ đọc tới item ngoài contentScope
  // unique (environmentId, kind, envRowId); index (environmentId, kind, originRowId)
}

merge_runs {
  id, siteId            // = Origin
  environmentId
  kind                  // schema | content | merge | revert
  status                // running | succeeded | failed | reverted
  plan                  // jsonb: MergePlan đã áp dụng (không gồm nội dung item)
  outcomes              // jsonb: [{ collection, originItemId, outcome, reason?, revisionId? }]
  startedBy, startedAt, finishedAt
}
```

`sites` không cần cột mới: quan hệ cha–con nằm ở `environments`. Một site là Environment khi có dòng `environments.siteId = site.id`.

**Vì sao id mới thay vì giữ nguyên id:** `lumibase_items.id` là primary key toàn cục, hai site không thể dùng chung một id. Lineage là cái giá phải trả, và cũng là thứ cho phép nhận ra rename khi diff schema.

## 3. Fork

### 3.1 Luồng

1. `POST /environments`: kiểm flag, quyền admin, giới hạn `environments.maxPerSite`, không lồng (Req 1.3). Trong một transaction: `provisionSite({ organizationId: origin.organizationId, creatorUserId })` + insert `environments(status='forking')`. Sau commit: enqueue `environment-fork`.
2. Worker chạy theo pha, mỗi pha ghi `forkCursor`:
   `schema → roles/permissions → settings → side-systems (disabled) → files → items → rewrite-refs → done`.
3. Mỗi lô insert dùng `onConflictDoNothing` trên unique `(environmentId, kind, originRowId)` của lineage → chạy lại không nhân bản (Req 2.6).

### 3.2 Sao chép item

Hai lượt, vì tham chiếu có thể vòng:

- **Lượt 1**: copy item với `data` nguyên trạng (id Origin còn trong data), ghi lineage `{ baseHash: hashData(origin.data), baseRevisionId }`.
- **Lượt 2**: với mỗi collection, đọc danh sách field quan hệ từ `relations`, viết lại id trong `data` theo lineage. Id không có lineage (ngoài `contentScope`) giữ nguyên và ghi một dòng lineage `external=true`.

`baseHash` tính trên data **Origin** trước khi viết lại, để so sánh về sau luôn ở không gian id của Origin (xem §8.1).

### 3.3 Base cho merge ba chiều

Base của một item = `revisions.delta.after` tại `baseRevisionId` (cùng cách `revertRevision` dựng lại trạng thái). Item chưa có revision nào tại lúc fork thì ghi `baseSnapshot`. Không lưu snapshot cho mọi item để tránh nhân đôi dữ liệu.

### 3.4 Files

Copy dòng `lumibase_files`/`lumibase_folders` với id mới, **cùng storage key**. Xoá file ở bất kỳ site nào phải kiểm "còn dòng files nào khác trỏ cùng storage key không" trước khi xoá object. Đây là thay đổi hành vi ở đường xoá file hiện có và cần test riêng.

### 3.5 Không sao chép

API keys, secrets, sessions, audit, revisions, agent memory, trust ledger, releases, content versions. Revisions bắt đầu lại từ đầu trong Environment; provenance của Origin không bị nhân bản.

## 4. Cô lập Side_System

| Hệ thống | Trạng thái sau fork |
|---|---|
| Webhooks | copy, `enabled=false`, secret rỗng |
| Flows | copy, inactive |
| CDC subscriptions / pipelines | copy, paused |
| Intents | copy, `status='paused'`, `statusReason='environment_fork'` |
| Reconciler / planner / agent runs | không tự chạy: Content OS flags của site con mặc định OFF (`feature-flags.ts`) |
| Deployments | copy cấu hình, không token, không auto-trigger |
| Email / push | tắt qua setting `environments.sideEffects.notifications=false` |
| Search index | index riêng theo `siteId` con; build lười sau fork |
| Edge cache | key đã theo `siteId`; delivery thêm `X-Robots-Tag: noindex` |

Kiểm tra `isEnvironment(siteId)` đặt ở **điểm phát** (dispatcher của webhook/flow/notification), không rải ở từng call site, và được cache trong request context.

## 5. List / detail / delete

- `list`/`get` scoped theo Origin (`environments.parentSiteId = siteId`).
- `originChanged` và "số item đã đổi" tính bằng so sánh hash theo lô, có giới hạn; trả `null` + cờ `truncated` khi vượt ngưỡng thay vì quét toàn bộ.
- `delete`: từ chối khi `forking`/`merging`; xoá site con (cascade theo FK `site_id`), tôn trọng §3.4. Xoá chạy nền nếu site lớn.

## 6. Write_Precondition

- `ETag` = hash ngắn của `(item.id, updatedAt, id revision mới nhất)`.
- `ItemService.patch` nhận thêm `expected?: { etag }`. Khi có, UPDATE thêm điều kiện `updated_at = $expected` trong cùng câu lệnh; 0 dòng bị ảnh hưởng → `PRECONDITION_FAILED` (412).
- Route đọc `If-Match`, truyền xuống. Không có header → hành vi cũ.
- Lưu ý coalesced writes (`flushCoalescedWrites`, `item-service.ts:2110`): ghi có precondition phải bỏ qua coalescing hoặc flush trước khi so sánh.

Phần này độc lập, giao được trước và có ích ngay cho Studio (hai editor cùng mở một item).

## 7. Schema_Promote

1. `ConfigExportService(env).export()` → manifest Environment.
2. **Remap theo lineage**: mỗi collection/field trong manifest được gắn `originRowId`. Entry có lineage nhưng khác tên → `renameFrom` (`schema-service.ts:177`). Entry không có lineage → create. Entry Origin không còn đối ứng trong Environment → delete (chỉ khi `mode` cho phép).
3. `buildConfigDiff(manifest, originState)` → `ConfigDiff` với `DiffRisk`.
4. **Schema conflict**: so `hash(entry Origin hiện tại)` với `lineage.baseHash` của entry đó. Lệch + Environment cũng đổi → conflict, cần `resolutions`.
5. Apply qua `ConfigImportService(origin).apply`, mode `merge`; thay đổi rủi ro cần `confirmRiskyChange` + `migrationPlan`.
6. Sau apply: cập nhật `baseHash` của lineage schema.

`migrationPlan` chạy trên toàn bộ item Origin (Req 7.5) — đây là hành vi sẵn có của `SchemaService`, Environment không thêm đường migrate riêng.

## 8. Content_Promote

### 8.1 Phân loại

So sánh luôn ở **không gian id của Origin**: data Environment được viết lại tham chiếu (env id → origin id) trước khi hash.

| Origin vs Base | Env vs Base | Kết quả |
|---|---|---|
| = | = | unchanged |
| = | ≠ | **promote** |
| ≠ | = | origin-only (không làm gì) |
| ≠ | ≠ | **conflict** (Content_Promote bỏ qua; Merge xử lý ở §9) |
| — | không lineage | **create** |
| còn | soft-deleted | **delete** |

### 8.2 Áp dụng

- Sắp thứ tự: create trước (theo đồ thị phụ thuộc; vòng thì tạo trước, patch tham chiếu sau), rồi update, rồi delete.
- Tham chiếu tới item mới chưa promote và không nằm trong lần chạy → outcome `failed` với `DEPENDENCY_NOT_PROMOTED`.
- Mỗi ghi gọi `ItemService(origin).patch(..., { expected })` → permission, validation, editorial gate, `pinnedFields`, hooks, revision đều do `ItemService` lo.
- Schema gate: collection có diff schema chưa promote → `SCHEMA_NOT_PROMOTED`.
- Sau mỗi item thành công: `lineage.baseHash = hash(origin mới)`, `baseRevisionId = revision vừa tạo`.

## 9. Merge ba chiều

```ts
type FieldChange = { field: string; locale?: string; base: unknown; origin: unknown; env: unknown };
type MergePlan = {
  schema: ConfigDiff;
  items: Array<{
    collection: string; originItemId: string | null; envItemId: string;
    action: 'promote' | 'create' | 'delete' | 'merge' | 'conflict';
    auto: FieldChange[];        // một bên đổi → tự lấy
    conflicts: FieldChange[];   // hai bên đổi khác nhau
  }>;
  truncated: boolean;
};
```

- Đơn vị so sánh: field top-level của `data`. Field đa ngôn ngữ (theo định nghĩa field, không đoán theo hình dạng giá trị) tách tiếp theo locale.
- So sánh bằng deep-equal trên JSON đã chuẩn hoá thứ tự key. Mảng (blocks, m2m) coi là **một giá trị nguyên khối** ở v1; merge theo phần tử là open question.
- `threeWay()` là hàm thuần, không I/O → dễ property-test.
- Resolution `custom` đi qua validation của field như một lần ghi thường.
- Base không dựng được → mọi field khác nhau giữa Origin và Environment thành conflict (Req 9.7).

Studio: màn Merge liệt kê item theo nhóm action; conflict mở khung ba cột Base / Origin / Environment, tái dùng `RevisionsDiff` cho phần render diff.

## 10. Nguyên tử, khoá, hoàn tác

### 10.1 Khoá

Chuyển `environments.status` sang `merging` bằng conditional UPDATE (`status='ready'`) kèm kiểm không có Environment anh em nào đang `merging` trên cùng Origin. Không dùng advisory lock để giữ tương thích Hyperdrive/transaction pooling.

### 10.2 Pre-flight rồi mới ghi

`ItemService.patch` không nhận `tx` (đã chốt ở content-releases), nên không có rollback DB xuyên nhiều item. Thay vào đó:

1. Pre-flight toàn bộ: quyền, validation, editorial gate, schema gate, hash Origin còn khớp plan.
2. Ghi tuần tự với Write_Precondition; item lệch giữa chừng → outcome `conflict`, tiếp tục.
3. `merge_runs.outcomes` ghi từng item + `revisionId`.
4. Chạy lại sau lỗi: phân loại lại theo `baseHash` đã cập nhật → item đã áp dụng thành `unchanged`.

Kết quả là **nguyên tử theo từng item, resumable theo lần chạy**, không phải all-or-nothing tuyệt đối. Requirement 10 được viết đúng theo mức này.

### 10.3 Hoàn tác và audit

`revert` duyệt `outcomes`, với mỗi item gọi `revertRevision` về revision cha của `revisionId`, có precondition "revision mới nhất vẫn là `revisionId`"; không khớp → `conflict`. Item `created` bị soft-delete. Schema_Promote **không** hoàn tác tự động (migration dữ liệu không đảo được); UI nói rõ điều này trước khi apply.

Audit qua `AuditLogger` sẵn có; revision tạo bởi merge mang `sources: [{ type: 'environment', environmentId, mergeRunId }]` (cột `revisions.sources` đã có).

## 11. Tenancy và route guard

- `EnvironmentService` constructor nhận `siteId` (Origin) từ context; nạp Environment bằng `(parentSiteId = siteId, key)` rồi mới lấy `env.siteId`. Request không bao giờ cung cấp site thứ hai.
- Assert `origin.organizationId === envSite.organizationId` trước mọi thao tác xuyên site.
- Quyền: admin Origin cho fork/delete/schema promote; với content promote/merge, kiểm quyền ghi từng collection ở Origin qua `ItemService` của chính người gọi.
- RLS: thao tác xuyên site mở hai phạm vi RLS tuần tự (mỗi `ItemService` call set `site_id` riêng), không nới policy.
- Route mount sau `auth` + `site-admin`; từ chối principal là API key. Test route-guard theo DoD §2c.
- Tenant resolution không đổi: Studio vào Environment bằng cách chọn site con (`tenant.ts`, nhánh header site).

## 12. HITL

Không đăng ký skill nào ở v1. Nếu sau này thêm, `promote_schema` mang `schema:write` và `delete_environment` bắt đầu bằng `delete` → cả hai tự rơi vào `ai_approvals` theo quy tắc sẵn có.

## 13. Rollout

- Flag theo site `environments.enabled`, mặc định OFF; route trả 404 khi OFF.
- Thứ tự giao: Write_Precondition (§6) → Fork + cô lập (§3–5) → Schema_Promote (§7) → Content_Promote (§8) → Merge + UI (§9–10). Mỗi bước tự có giá trị và dừng được.
- Setup Impact: dự kiến `n/a` cho seed/wizard (ba bảng rỗng khi init), **có** settings key mới (`environments.maxPerSite`, `environments.enabled`) với default an toàn.

## 14. Open questions

1. **Chi phí fork site lớn.** v1 copy hàng thật, chặn bằng `contentScope` và giới hạn số item (đề xuất 50k/fork, cấu hình được). Copy-on-write hoặc Neon branch là hướng sau, nhưng Neon branch không dùng được cho Docker.
2. **Rebase Environment theo Origin** (kéo thay đổi production vào nhánh đang sống). Cùng thuật toán ba chiều nhưng ngược hướng; hoãn tới khi Merge ổn định.
3. **Merge theo phần tử mảng** (blocks, m2m). v1 coi mảng là nguyên khối → conflict nhiều hơn cần thiết với nội dung dạng block.
4. **Base khi revision bị retention dọn.** `review-run-retention`/chính sách giữ revision có thể xoá `baseRevisionId`. Cần ghim revision đang là Base, hoặc chuyển sang `baseSnapshot` trước khi dọn.
5. **External reference** tới item ngoài `contentScope`: chỉ đọc là đủ, hay cần "kéo thêm" item vào Environment sau fork?
6. **Quota theo organization** thay vì theo site, khi organizations (ADR-013) có billing.
7. **ETag dựa trên `updatedAt`** có đủ độ phân giải không khi hai ghi rơi cùng mili-giây; phương án thay thế là cột `version` tăng dần trên `items`.
