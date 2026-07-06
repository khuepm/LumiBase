# Design Document — Foreign Key Dependent Records Handler

## Overview

Thiết kế cho **Foreign Key Dependent Records Handler**: phát hiện các bản ghi phụ thuộc (records ở collection khác tham chiếu một item) và cung cấp luồng giải quyết hàng loạt (set null / delete / reassign) khi xoá bị chặn. Backend trả **response có cấu trúc** để Studio render dialog. Feature **không thêm bảng DB mới** — nó đảo chiều logic expansion quan hệ sẵn có và thực thi cột `relations.on_delete` (`packages/database/src/schema/cms.ts:168-169`) vốn đến nay mới chỉ là metadata khai báo.

Nguyên tắc thiết kế: **không phát minh cơ chế mới**.
- Quan hệ đã được mô hình hoá ở bảng `relations` (`cms.ts:149-177`); expansion *forward* đã có ở `ItemService.expandRelationFields` (`apps/cms/src/services/item-service.ts:1041-1076`). Feature thêm chiều *reverse* dùng đúng các cột đó (`oneCollection`, `manyCollection`, `manyField`, `junctionOneField`).
- Truy vấn dependents tái dùng pattern điều hướng JSONB `items.data->>field` đã dùng trong `loadRowsByJsonField` (`item-service.ts:1167+`) và filter `@>` (`item-service.ts:909`).
- Xoá dependents tái dùng `ItemService.softDelete` / `hardDelete` (`item-service.ts:837`, `:955`) để giữ nguyên hook/deindex/realtime, thay vì viết lại đường xoá.
- Permission gating tái dùng `PermissionService.canAccess` / `whereFor` (`apps/cms/src/services/permission-service.ts:104`, `:175`).
- Scope `site_id` qua `scopeSite(...)` trên mọi query (như toàn bộ `ItemService`).

## Architecture

```
┌──────────────────────── Studio (apps/studio) ────────────────────────┐
│  Editor bấm "Delete item"                                            │
│    │                                                                 │
│    ├─ (tùy chọn) GET …/dependents  → preflight, mở dialog nếu cần   │
│    └─ DELETE …/items/:c/:id        → 200 (xong) | 409 DEPENDENT_…   │
│                                            │                         │
│                                            ▼                         │
│   DependentRecordsDialog: liệt kê Dependent_Group[]                 │
│     per group → chọn {set_null | delete | reassign}                 │
│     confirm → POST …/resolve-dependents  → retry DELETE             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP /api/v1
                                ▼
┌──────────────────────────── CMS (Hono) ──────────────────────────────┐
│  routes/items.ts (mở rộng):                                          │
│    GET  /items/:collection/:id/dependents       → preflight          │
│    POST /items/:collection/:id/resolve-dependents → batch resolve    │
│    DELETE /items/:collection/:id  (đường xoá hiện có, thêm 409)      │
│                         │                                            │
│                         ▼                                            │
│  DependentsService  (services/dependents-service.ts — MỚI)          │
│    • resolveDependents(collection, itemId)  → Dependent_Group[]     │
│    • isBlocking(groups)                                             │
│    • applyResolution(action, relation, …)  [transaction]           │
│         delegate xoá → ItemService.softDelete / hardDelete         │
│                         │            │                              │
│                         ▼            ▼                              │
│   relations table   ItemService   PermissionService   AuditLogger   │
│   (cms.ts:149)      (delete/JSONB) (canAccess/whereFor)             │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
   Postgres (Drizzle + postgres-js): relations · items(JSONB data)
     • reverse query: items.data->>manyField = :itemId  (scoped siteId)
     • hard-delete: bắt SQLSTATE 23503 (FK_Violation) → 409 dịch lỗi
```

Một service mới đặt cạnh các service hiện có trong `apps/cms/src/services/`:
- `dependents-service.ts` — `DependentsService`: resolver (reverse) + applyResolution (transactional). Nhận deps `{ db, siteId, userId, permissions, runtime }` đúng khuôn `ItemService`, và **ủy quyền xoá** cho một `ItemService` instance thay vì lặp lại logic hook/deindex.

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (reverse resolver) | §3 reverse query, §4.1 `resolveDependents`, §2 reuse `relations` |
| Req 2 (preflight endpoint) | §4.2 GET dependents, §5 response shape |
| Req 3 (409 structured) | §4.5 delete-path integration, §6 FK_Violation 23503 mapping |
| Req 4 (soft-delete vs restrict) | §7 decision (application-level restrict), §9 open question 1 |
| Req 5 (set_null) | §4.3 applyResolution(set_null), §4.6 required-field guard |
| Req 6 (delete) | §4.3 applyResolution(delete), delegate `ItemService`, §4.7 nested |
| Req 7 (reassign) | §4.3 applyResolution(reassign), §4.6 target validation |
| Req 8 (onDelete policy) | §3 group.onDelete, §4.4 override + audit flag |
| Req 9 (permissions/tenancy) | §4.3 perm gating, §8 PermissionService reuse |
| Req 10 (audit) | §8 audit events |
| Req 11 (Studio dialog) | §6.4 / Phase D component contract |
| Req 12 (setup impact) | §10 Setup Impact |

## 2. Mô hình dữ liệu — không thêm bảng mới

Feature **không tạo bảng mới và không cần migration**. Nó đọc/ghi các bảng sẵn có:
- `relations` (`packages/database/src/schema/cms.ts:149-177`) — nguồn sự thật cho quan hệ + `onDelete`. Đã index `relations_site_idx` (`cms.ts:174`) và `relations_many_idx` trên `(many_collection, many_field)` (`cms.ts:175`) — index sau hữu ích cho reverse query lọc theo `manyCollection`.
- `items` (`cms.ts:184+`) — dữ liệu trong JSONB `items.data`; reference điều hướng qua `items.data->>field`.
- `fields` (`cms.ts:88-147`) — để biết `manyField` có `required`/nullable không (Req 5.3).

**Migration 0012+ là hand-written** nếu cần (theo MEMORY). Tuy nhiên feature này **dự kiến KHÔNG cần migration** vì `onDelete` đã tồn tại, không thêm cột, không thêm bảng. Nếu phát sinh nhu cầu index bổ sung cho hiệu năng reverse query thì migration đó sẽ viết tay + sửa journal (không dùng drizzle-kit generate).

## 3. Reverse query shape

Với `(collection, itemId)`:

```ts
// 1) Tìm mọi relation nơi collection này là "one" (bị trỏ tới).
const rels = await db.select().from(relations).where(
  and(
    scopeSite(relations.siteId, siteId),
    eq(relations.oneCollection, collection),
  ),
);

// 2) Với mỗi relation, đếm + lấy sample dependents ở manyCollection.
//    m2o / o2m: items.data->>manyField === itemId
//    m2m:        junction.data->>junctionOneField === itemId
const referencing = await db.select(/* id, data subset */)
  .from(items)
  .where(and(
    scopeSite(items.siteId, siteId),
    eq(items.collectionId, manyCollectionId),
    isNull(items.deletedAt),
    sql`${items.data}->>${rel.manyField} = ${itemId}`,
    permissions?.whereFor(perm) ?? undefined,   // Req 9.2
  ))
  .limit(sampleLimit);
const count = /* separate COUNT(*) cùng where, không limit */;
```

`Dependent_Group` kết quả:
```jsonc
{
  "relation": "<relationId>",       // relations.id (nanoid)
  "collection": "comments",         // manyCollection
  "field": "article",               // manyField
  "onDelete": "restrict",           // relations.on_delete (cms.ts:168)
  "count": 42,                       // tổng thực tế
  "sample": [ { "id": "...", "...": "..." } ]  // ≤ limit
}
```

`Dependents_Report = { dependents: Dependent_Group[], blocking: boolean }`, với `blocking = groups.some(g => g.count > 0 && g.onDelete === 'restrict')` (Req 2.2, 3.4).

## 4. Service flow — `DependentsService`

### 4.1 `resolveDependents(collection, itemId, { limit }) → Dependent_Group[]` (Req 1)
1. `scopeSite()` mọi select.
2. Load relations `oneCollection = collection` (§3 bước 1).
3. Với mỗi relation: resolve `manyCollectionId`, chạy COUNT + sample (§3 bước 2), áp `permissions.whereFor` (Req 9.2). m2m → đếm qua junction (`junctionOneField`).
4. Trả mảng group (bỏ group khi không cần — nhưng vẫn giữ group `count=0`? → **giữ chỉ group có `count>0`** để dialog gọn; quyết định: chỉ trả group có dependents thực).

### 4.2 Preflight `GET /items/:collection/:id/dependents` (Req 2)
1. Auth middleware + check `read` trên `collection` (Permission_Service) → 403 nếu thiếu (Req 2.5).
2. Resolve `Target_Item`; 404 nếu không tồn tại/đã soft-deleted (Req 2.4).
3. `groups = resolveDependents(...)`; `blocking = isBlocking(groups)`.
4. Trả `{ data: { dependents: groups, blocking } }`. Không ghi gì (Req 2.3).

### 4.3 `applyResolution(action, relation, opts)` (Req 5–7) — transactional
Mở **một** transaction Drizzle, scoped `siteId`:
- `set_null`: với mọi dependent của relation → `data[manyField] = null`. Trước đó check `manyField` nullable (Req 5.3) → nếu required, abort `FIELD_REQUIRED` (409). Cần quyền `update` trên `manyCollection` (Req 5.5).
- `reassign`: validate `newTargetId` tồn tại trong `oneCollection`, ≠ `id` (Req 7.2, 7.3) → set `data[manyField] = newTargetId`. Quyền `update`.
- `delete`: với mọi dependent → **delegate** `ItemService.softDelete(manyCollection, depId)` (mặc định) hoặc `hardDelete` nếu `?hard=true` (Req 6.1, 6.2). Quyền `delete`. Tái dùng hook/deindex/realtime (Req 6.6).
- Mọi nhánh: lỗi → rollback toàn bộ (Req 5.6, 6.x, 7.6); thành công → audit `dependents_resolved` (§8) + trả `{ data: { action, relation, affected, … } }`.

> **Truyền transaction:** `ItemService.softDelete`/`hardDelete` hiện dùng `this.deps.db`. Để chạy trong cùng transaction, `DependentsService` khởi tạo `ItemService` với `db = tx` (transaction handle) bên trong `db.transaction(async (tx) => …)`. Nếu một số side-effect của `softDelete` (deindex search, realtime publish) là external I/O, chúng nên chạy **sau commit** (fire-and-forget như hiện tại — `item-service.ts:881-885` đã fire-and-forget hook.after). Xem §9 open question 2.

### 4.4 On_Delete_Policy override (Req 8)
- `applyResolution` không tự suy ra action từ `onDelete`; action do client gửi (dialog quyết định, gợi ý theo §Req 8.2).
- Nếu `action` ≠ hành vi mặc định của relation's `onDelete` (vd `set_null` trên relation `restrict`, hoặc `delete` trên relation `set null`), set `policyOverridden = true` để ghi audit (Req 8.1, 8.4).

### 4.5 Tích hợp đường xoá `Target_Item` (Req 3)
`routes/items.ts` `DELETE /items/:collection/:id` (đường hiện có):
1. Trước khi soft-delete: gọi `resolveDependents`; nếu `isBlocking` (có dependent qua relation `restrict`) → **không** set `deletedAt`, trả 409 `DEPENDENT_RECORDS_EXIST` + `dependents` (Req 3.2, 3.5).
2. Hard-delete path (erasure/retention, `?hard=true`): bọc try/catch quanh `hardDelete`; bắt Postgres FK_Violation → dịch sang 409 (§6).

### 4.6 Guards
- Required-field: tra `fields` cho `(manyCollection, manyField)`; `required=true` → cấm `set_null` (Req 5.3).
- Reassign target: SELECT `newTargetId` trong `oneCollection`, `isNull(deletedAt)`, `scopeSite` → thiếu/`=id` ⇒ `INVALID_TARGET` (Req 7.2, 7.3).

### 4.7 Nested dependents (hard delete dependents) (Req 6.2)
Khi `?hard=true` và một dependent lại bị `Blocking_Relation` của *nó* chặn → resolver chạy đệ quy **một cấp** trên dependent đó; nếu blocking → 409 nested + rollback. v1 dừng ở một cấp; đệ quy sâu hơn = §9 open question 3.

## 5. Response shapes

Preflight (200):
```jsonc
{ "data": { "blocking": true, "dependents": [ /* Dependent_Group[] */ ] } }
```
Delete bị chặn (409):
```jsonc
{ "errors": [ { "code": "DEPENDENT_RECORDS_EXIST", "dependents": [ /* … */ ] } ] }
```
Resolve thành công (200):
```jsonc
{ "data": { "action": "set_null", "relation": "rel_x", "affected": 42 } }
```
Tất cả tuân thủ format `{ data }` / `{ errors }` của CLAUDE.md.

## 6. FK_Violation translation (Req 3.3)

DB driver là Drizzle ORM 0.45.2 + **postgres-js** 3.4.5; lỗi từ postgres-js mang `err.code = '23503'` (foreign_key_violation). Trong hard-delete path:
```ts
try {
  await itemService.hardDelete(collection, id);
} catch (err) {
  if (isPgError(err) && err.code === '23503') {
    const groups = await dependentsService.resolveDependents(collection, id, { limit });
    return c.json({ errors: [{ code: 'DEPENDENT_RECORDS_EXIST', dependents: groups }] }, 409);
  }
  throw err;
}
```
`isPgError` đọc `code` (postgres-js gắn SQLSTATE vào `.code`). Việc resolve lại groups *sau* khi bắt lỗi đảm bảo client nhận đúng danh sách dependents thay vì lỗi 500 thô. (Lưu ý: với JSONB không có FK vật lý, 23503 chỉ phát khi schema có FK thật, vd `relations.site_id` references `sites`; với reference item-level qua JSONB, blocking được phát hiện ở **tầng ứng dụng** — xem §7.)

## 7. Quyết định thiết kế: soft-delete vs restrict (Req 4)

Đây là quyết định cốt lõi, ghi tường minh:

- LumiBase lưu reference item-level trong **JSONB `items.data`**, *không* phải cột FK vật lý. Do đó **không có** FK constraint Postgres giữa hai item → `onDelete` của bảng `relations` là **metadata khai báo**, phải được **thực thi ở tầng ứng dụng**.
- **Soft_Delete** (mặc định) chỉ set `deletedAt` → không xoá dòng → bất kỳ FK vật lý nào (nếu có) cũng không kích hoạt. Vì vậy:
  - **`restrict`**: enforcement ở tầng ứng dụng — trước khi soft-delete `Target_Item`, nếu có dependent qua relation `restrict` thì **chặn** (409). Đây là hành vi *blocking* duy nhất (Req 3.4, 4.1).
  - **`set null` / `cascade`**: **không** tự động thực thi khi soft-delete. Soft-delete `Target_Item` để reference trỏ tới một item đã `deletedAt` (orphan có thể giải quyết sau). Lý do: soft-delete có ngữ nghĩa "có thể khôi phục"; tự động null/cascade khi soft-delete sẽ phá tính khôi phục và gây side-effect bất ngờ. Editor chủ động dọn qua `resolve-dependents` (Req 4.2, 4.4).
- **Hard_Delete** (erasure/retention, `?hard=true`): nếu schema có FK vật lý thật, Postgres tự enforce → ta bắt 23503 và dịch (§6). Với reference JSONB, ta enforce ở tầng ứng dụng giống soft path.

> **Chốt v1:** chỉ `restrict` chặn (application-level); `set null`/`cascade` không tự chạy khi soft-delete — chỉ chạy khi gọi Resolve_Endpoint hoặc trong hard-delete cascade thủ công. Hành vi này được tài liệu hoá trong API spec (Req 4.3, 4.5). Lựa chọn thay thế (tự cascade khi soft-delete) bị loại vì phá ngữ nghĩa khôi phục.

## 8. Permissions, tenancy & audit (Req 9, 10)

- **Permissions:** mọi thao tác trên dependents kiểm tra quyền trên **`manyCollection`** (collection chứa dependents), không phải `Target_Item`: `set_null`/`reassign` → `update`; `delete` → `delete` (Req 9.1). Áp `PermissionService.whereFor()` (`permission-service.ts:175`) cho mọi reverse query để lọc row-level (Req 9.2). `adminAccess` (`permission-service.ts:175` vùng) theo cùng quy tắc route item hiện hữu.
- **Tenancy:** `scopeSite(...)` trên *mọi* select/update/delete; relations + items + fields đều lọc `siteId` (Req 9.3).
- **Audit:** dùng audit logger sẵn có của CMS. `dependents_resolved` (success) / `dependents_resolve_failed` (rollback), metadata chỉ `{ targetCollection, targetId, relation, action, affected, mode?, newTargetId?, policyOverridden }` — **không** nội dung field nhạy cảm (Req 10.1–10.4).

## 9. Open questions

1. **`set null`/`cascade` có nên tự thực thi khi soft-delete không?** — *Chốt v1: KHÔNG* (xem §7). Chỉ `restrict` chặn ở tầng ứng dụng; còn lại để editor dọn chủ động. Lý do: bảo toàn tính khôi phục của soft-delete. Cân nhắc v2: cờ per-relation "enforce-on-soft-delete".
2. **Truyền transaction handle vào `ItemService.softDelete/hardDelete`.** `ItemService` hiện dùng `this.deps.db`; cần khởi tạo `ItemService` với `db = tx` bên trong `db.transaction()`. Các side-effect external (deindex search, realtime publish — `item-service.ts:881-883`) nên chạy **sau commit** để không giữ transaction lâu / không phát event khi rollback. *Quyết định lúc implement: gom dependent ids, xoá trong tx, deindex/publish sau commit.*
3. **Đệ quy nhiều cấp khi hard-delete cascade.** v1 chỉ một cấp (Req 6.2); nếu dependent-of-dependent cũng `restrict` → 409 nested. Cascade sâu (đồ thị) có nguy cơ vòng lặp + chi phí lớn → để v2 (cần cycle detection + giới hạn độ sâu).
4. **Phân trang sample lớn.** `count` có thể rất lớn; dialog chỉ hiển thị `sample` (≤ limit). Có cần endpoint phân trang riêng để duyệt toàn bộ dependents trước khi resolve không? v1: resolve theo *relation* (toàn bộ group), không theo từng id, nên không cần duyệt hết; chỉ hiển thị sample + count. Cân nhắc v2: resolve có chọn lọc (chỉ một số dependent id).
5. **m2m junction dọn dẹp.** Với `delete` trên group m2m, xoá dòng *junction* (gỡ liên kết) hay xoá item phía `manyCollection`? v1: `set_null`/`delete` áp dụng trên dòng tham chiếu trực tiếp; m2m → thao tác trên junction (gỡ liên kết) là mặc định an toàn. Ghi rõ trong API spec.
