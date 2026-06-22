# Implementation Plan

## Overview

Kế hoạch triển khai **Foreign Key Dependent Records Handler** theo 5 phase. Phase A xây reverse-dependency resolver thuần (không xoá, chỉ đọc) + preflight endpoint. Phase B tích hợp 409 có cấu trúc vào đường xoá + dịch FK_Violation. Phase C xây batch resolution actions (set_null / delete / reassign) transactional, ủy quyền xoá cho `ItemService`. Phase D xây Studio dialog. Phase E hoàn thiện docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng (theo commit conventions: author Javier, không Claude co-author, split commits).

## Tasks

### Phase A — Reverse-dependency resolver & preflight

- [ ] 1. DependentsService — reverse resolver
  - [ ] 1.1 Tạo `apps/cms/src/services/dependents-service.ts` class `DependentsService` với deps `{ db, siteId, userId, permissions, runtime }` đối xứng `ItemService`; method `resolveDependents(collection, itemId, { limit })` query relations `oneCollection = collection` scoped `siteId`, mỗi relation COUNT + sample dependents qua `items.data->>manyField = itemId` (Req 1.1-1.4; design §3, §4.1)
  - [ ] 1.2 Xử lý m2m: đếm dependents qua junction (`junctionOneField`) cho relation type `m2m`; chỉ trả group có `count > 0` (Req 1.5; design §3, §4.1)
  - [ ] 1.3 Áp `permissions.whereFor()` cho reverse query (row-level) + `scopeSite` mọi select; thêm helper `isBlocking(groups)` = có group `restrict` với `count>0` (Req 1.6, 2.2, 9.2; design §3, §8)
  - [ ] 1.4 Unit test resolver: m2o/o2m/m2m, count vs sample limit, site isolation, group rỗng → [] (Req 1.2-1.7; design §4.1)

- [ ] 2. Preflight endpoint
  - [ ] 2.1 Thêm route `GET /items/:collection/:id/dependents` trong `apps/cms/src/routes/items.ts`: check `read` trên collection, 404 nếu target không tồn tại/soft-deleted, trả `{ data: { dependents, blocking } }` (Req 2.1-2.5; design §4.2, §5)
  - [ ] 2.2 Hỗ trợ `?limit=` clamp ≤ trần; gắn `onDelete` mỗi group (Req 2.6, 2.7; design §3)
  - [ ] 2.3 Integration test preflight: tạo collection cha + con với relation restrict/set null → assert shape, blocking flag, 403 khi thiếu quyền, 404 target ảo (Req 2.1-2.7; design §4.2)

### Phase B — Structured 409 trên đường xoá

- [ ] 3. Tích hợp delete-path
  - [ ] 3.1 Trong `routes/items.ts` `DELETE /items/:collection/:id`: trước soft-delete gọi `resolveDependents`, nếu `isBlocking` → 409 `{ errors: [{ code: 'DEPENDENT_RECORDS_EXIST', dependents }] }`, KHÔNG set `deletedAt` (Req 3.1, 3.2, 3.5; design §4.5)
  - [ ] 3.2 Hard-delete path: bọc try/catch quanh `ItemService.hardDelete` (`item-service.ts:955`), bắt postgres-js SQLSTATE `23503` → resolve groups → 409 dịch lỗi (helper `isPgError`) (Req 3.3; design §6)
  - [ ] 3.3 Đảm bảo chỉ `onDelete='restrict'` (hoặc `no action` mức DB) coi là blocking; `cascade`/`set null` không tự chặn (Req 3.4; design §7)
  - [ ] 3.4 Integration test: soft-delete bị chặn bởi restrict → 409 + giữ item; hard-delete bắt 23503 → 409; relation set null không chặn soft-delete (Req 3.1-3.6, 4.2; design §4.5, §6, §7)

### Phase C — Batch resolution actions (transactional)

- [ ] 4. applyResolution core
  - [ ] 4.1 `DependentsService.applyResolution(action, relation, opts)` mở `db.transaction`, scoped `siteId`; resolve dependents của relation trong tx; khung dispatch theo action + audit success/fail (Req 5-7 chung, 10.1, 10.2; design §4.3, §8)
  - [ ] 4.2 Action `set_null`: set `data[manyField]=null` mọi dependent; check `manyField` required trong `fields` → abort `FIELD_REQUIRED` 409; cần quyền `update` trên `manyCollection` (Req 5.1-5.6, 9.1; design §4.3, §4.6)
  - [ ] 4.3 Action `reassign`: validate `newTargetId` tồn tại trong `oneCollection` & ≠ `id` → `INVALID_TARGET` 422; set `data[manyField]=newTargetId`; quyền `update` (Req 7.1-7.6, 9.1; design §4.3, §4.6)
  - [ ] 4.4 Action `delete`: delegate `ItemService.softDelete` (mặc định) / `hardDelete` khi `?hard=true` với `db=tx`; quyền `delete`; deindex/realtime chạy sau commit (Req 6.1-6.6, 9.1; design §4.3, §9.2)
  - [ ] 4.5 Nested guard cho `?hard=true`: nếu dependent lại bị Blocking_Relation → 409 nested + rollback (một cấp) (Req 6.2; design §4.7)
  - [ ] 4.6 `policyOverridden` flag khi action ≠ hành vi mặc định của `onDelete`; ghi vào audit (Req 8.1, 8.4; design §4.4, §8)

- [ ] 5. Resolve endpoint
  - [ ] 5.1 Thêm route `POST /items/:collection/:id/resolve-dependents` trong `routes/items.ts` nhận `{ action, relation, newTargetId? }` + `?hard=`, gọi `applyResolution`, trả `{ data: { action, relation, affected, … } }` (Req 5.1, 6.5, 7.5; design §4.3, §5)
  - [ ] 5.2 Permission gating per action trên `manyCollection`; 403 `FORBIDDEN` khi thiếu; rollback nguyên tử khi bất kỳ bước fail (Req 5.5, 6.4, 7.4, 9.1-9.4; design §8)
  - [ ] 5.3 Integration test resolve: set_null (+ chặn required), delete soft/hard, reassign (+ invalid target), permission 403, rollback, audit ghi đúng metadata + policyOverridden (Req 5-10; design §4.3, §8)

### Phase D — Studio dependent-records dialog

- [ ] 6. DependentRecordsDialog
  - [ ] 6.1 Tạo component dialog trong `apps/studio` mở khi DELETE trả 409 `DEPENDENT_RECORDS_EXIST` (hoặc preflight `blocking=true`); liệt kê mỗi `Dependent_Group` (collection, field, count, sample, onDelete) (Req 11.1; design Architecture)
  - [ ] 6.2 Per group cho chọn action {Set null | Delete | Reassign}; Reassign mở picker `newTargetId` trong `oneCollection`; gợi ý mặc định theo `onDelete` (cascade→delete, set null→set_null) (Req 8.2, 11.2; design §4.4)
  - [ ] 6.3 Confirm → gọi `POST …/resolve-dependents` per group, hiển thị tiến trình + lỗi per group; disable set_null cho field required; cảnh báo destructive cho delete (đặc biệt hard) (Req 11.3, 11.5, 11.6; design §5)
  - [ ] 6.4 Sau khi mọi group resolved → retry DELETE `Target_Item`, đóng dialog khi thành công (Req 11.4; design §4.5)
  - [ ] 6.5 Studio test (component/e2e tuỳ hạ tầng test sẵn có): mở dialog từ 409, chọn action, retry delete (Req 11.1-11.4)

### Phase E — Docs, Setup Impact, DoD

- [ ] 7. Docs
  - [ ] 7.1 Cập nhật `docs/en/api/hono-api-spec.md`: thêm `GET /api/v1/items/:collection/:id/dependents` và `POST …/resolve-dependents` (params, body, response, error codes `DEPENDENT_RECORDS_EXIST`/`FIELD_REQUIRED`/`INVALID_TARGET`/`FORBIDDEN`/`NOT_FOUND`); ghi rõ ngữ nghĩa **soft-delete vs restrict** (chỉ restrict chặn; set null/cascade không tự chạy khi soft-delete) (Req 4.3, 4.5; DoD docs)
  - [ ] 7.2 CHANGELOG entry cho feature; README/Release policy bump nếu version tăng — giữ narrative 0.5.0 (DoD docs)

- [x] 8. Setup Impact & DoD
  - [x] 8.1 **Setup Impact**: dòng #25 `n/a` thêm vào Registry (rà soát 2026-06-22; không bảng/migration mới) (Req 12; design §10)
  - [x] 8.2 Recursive typecheck (15/15) ✅ + targeted tests pass trên Postgres local (DoD)

---

## Implementation status (2026-06-22)

**Done — Phases A–E** (commits split per task; author Javier; PR riêng).

- **Phase A–C** ✅ `DependentsService` (reverse resolver + `report`/`isBlocking` + `applyResolution` transactional set_null/delete/reassign với guard required-field + reassign-target, injection-guarded JSONB path). Endpoints: `GET …/dependents`, `POST …/resolve-dependents`, DELETE 409-block. Không bảng/migration mới — `relations.on_delete` enforce ở tầng ứng dụng (design §7: chỉ `restrict` chặn).
- **Phase D** ✅ `DependentRecordsDialog` mở khi DELETE → 409, resolve từng group, retry delete.
- **Phase E** ✅ API spec (§3 Items + soft-delete-vs-restrict semantics), CHANGELOG, Setup Impact #25.

**Deviation:** FK_Violation 23503 translation (design §6) chỉ áp cho hard-delete với FK vật lý; với reference JSONB (mặc định) blocking phát hiện ở tầng ứng dụng (đã có), nên path 23503 là phụ — v1 không thêm test riêng cho nó.

**Verified:** recursive typecheck 15/15; service DB-integration 7 (resolver, restrict-blocks, set_null, reassign + bad-target, delete, required-field guard) + route DB-integration 3 (preflight, 409, resolve-clears-block) trên Postgres thật.
