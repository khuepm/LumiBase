# Implementation Plan

## Overview

Kế hoạch triển khai **JSON Field Search** theo 4 phase. Phase A đặt nền an toàn (path resolution + validate injection + limits — phần pure, dễ test nhất và là chốt bảo mật). Phase B mở rộng `fieldExpression()` cho nested path + Cast_Rule type-aware. Phase C thêm JSON_Operator (containment/key-existence) + sort theo path + (optional) shared Zod schema. Phase D hoàn thiện test toàn diện, docs, Setup Impact, DoD. Mỗi task gắn ref requirement + section design. Mỗi task = một commit riêng.

Toàn bộ thay đổi tập trung ở `apps/cms/src/services/item-service.ts` (`fieldExpression`, `buildFilter`, `buildSort` — dòng 208-310), không bảng/migration/route mới. Tận dụng GIN index sẵn có `items_data_gin_idx` (cms.ts:233-236).

## Tasks

### Phase A — Path resolution & injection safety (foundation)

- [ ] 1. Path model & validation (pure, chốt bảo mật)
  - [ ] 1.1 Thêm hằng số tập trung `MAX_PATH_DEPTH=8`, `MAX_SEGMENT_LEN=64`, `MAX_FILTER_CLAUSES=100` cạnh `STRUCTURAL_FIELDS` trong `apps/cms/src/services/item-service.ts` (Req 5.1-5.4; design §8)
  - [ ] 1.2 Thêm `FieldPath` interface + `resolveFieldRef(key)` (dot-split + structural check) + `flattenNested(obj)` (NestedObject → segments + leaf op-object); nhập nhằng op+nested cùng cấp → `INVALID_FILTER` (Req 1.1, 1.3, 2.1-2.3; design §3, §4)
  - [ ] 1.3 Thêm `validatePath(segments)`: regex allow-list `^[A-Za-z0-9_]+$` | `^[0-9]+$`, reject segment/path rỗng, enforce depth + segment-length; throw `ItemServiceError('INVALID_FILTER', …)` trước khi dựng SQL (Req 5.1, 5.2, 6.1, 6.4, 6.5; design §4, §9)
  - [ ] 1.4 Unit test `validatePath` + `resolveFieldRef`: phủ **các ca injection bị từ chối** (segment chứa `'`, `"`, `;`, `,`, `{`, `}`, `\`, `--`, space), path quá sâu, segment quá dài, path rỗng `a..b`/`.a`/`a.`, nested-object form, dot-path, array index (Req 5, 6; design §9)

### Phase B — Nested path extract + type-aware casting

- [ ] 2. `fieldExpression` mở rộng cho nested path
  - [ ] 2.1 Đổi chữ ký `fieldExpression(path: FieldPath, opCtx?)`; giữ NGUYÊN nhánh structural (item-service.ts:208-224) và nhánh 1-segment `data->>'k'` (item-service.ts:226); thêm nhánh `≥2 segment` → `sql\`${items.data}#>>${path.segments}\`` với segments **bound như param** (Req 1.1, 1.4, 7.1, 7.2; design §5)
  - [ ] 2.2 Cập nhật `buildFilter()` (item-service.ts:230-301) gọi `resolveFieldRef`+`validatePath` cho mỗi leaf, xử lý NestedObject form, đếm leaf-clause cho `MAX_FILTER_CLAUSES`; giữ walk `_and`/`_or` (item-service.ts:234-246) (Req 2.4, 5.3, 6.4; design §3, §4)
  - [ ] 2.3 Test parameter-binding: khẳng định `path.segments` nằm trong `sql.params`, KHÔNG trong queryChunks literal (không có nội suy chuỗi) (Req 6.2, 10.2; design §5, §9)

- [ ] 3. Type-aware Cast_Rule
  - [ ] 3.1 Trong `buildFilter`, lookup `CompiledField` qua `this.schemaService.getCompiled(collection)` theo `segments[0]`; truyền `compiledType` vào `opCtx` (Req 4.1; design §4.1-cite, §7)
  - [ ] 3.2 Thêm `applyCast(expr, type, op)`: numeric→`::numeric`, boolean→`::boolean`, date/time→`::timestamptz`, string/unknown→none; operator chuỗi luôn text; type không xác định → fallback text (Req 4.2, 4.3, 4.5; design §7)
  - [ ] 3.3 Resilience: chọn safe-cast (vd `jsonb_typeof` guard cho numeric/boolean) để value không-khớp-kiểu không làm sập toàn query (open question §12.3) (Req 4.4; design §7)
  - [ ] 3.4 Unit test casting: `_gte` numeric trên JSON path (10 > 9), `_eq` boolean, so sánh date; value lệch kiểu không sập; field thiếu schema → text fallback (Req 4.1-4.5; design §7)

### Phase C — JSON operators, sort, shared schema

- [ ] 4. JSON_Operator (containment & key-existence)
  - [ ] 4.1 Thêm operator vào `ItemFilterOp` union (item-service.ts:63-76): `_json_contains, _has_key, _has_any_keys, _has_all_keys`; cập nhật `ItemFilter` nếu cần (Req 3; design §3, §6)
  - [ ] 4.2 Trong switch của `buildFilter`, thêm case dùng `mode:'json'` (`#>`): `_json_contains`→`@> ${JSON.stringify(v)}::jsonb`; `_has_key`→`? ${key}`; `_has_any_keys`→`?| ${keys}`; `_has_all_keys`→`?& ${keys}`; array membership qua `@> [v]::jsonb` (Req 3.1-3.4, 3.6, 3.7; design §6)
  - [ ] 4.3 Validate value: `_has_any_keys`/`_has_all_keys` phải mảng string, else `INVALID_FILTER`; verify toán tử `?`/`?|`/`?&` không xung đột placeholder postgres-js, fallback `jsonb_exists*` nếu cần (open question §12.2) (Req 3.5; design §6)
  - [ ] 4.4 Giữ `default: throw INVALID_FILTER` cho operator lạ (mở rộng item-service.ts:293-294) (Req 6.3; design §9)
  - [ ] 4.5 Unit test JSON ops: containment object/array, key-existence, any/all keys, membership; reject value sai kiểu; mỗi op kết hợp `_and`/`_or` + nested path (Req 3; design §6)

- [ ] 5. Sort theo JSON path
  - [ ] 5.1 Cập nhật `buildSort()` (item-service.ts:303-310) dùng `resolveFieldRef`+`validatePath`+`fieldExpression` cho nested path; áp Cast_Rule khi numeric/date; structural không đổi (Req 9.1-9.4; design §5.4)
  - [ ] 5.2 Unit test sort: `-metadata.priority` numeric đúng thứ tự kiểu; structural sort không đổi; segment bẩn trong sort token bị reject (Req 9; design §5.4)

- [ ] 6. (Optional) Shared filter Zod schema
  - [ ] 6.1 Điều tra & ghi nhận: không có filter schema ở `packages/shared/src/schemas/` (chỉ items.ts:14-16). Nếu chốt thêm: tạo `packages/shared/src/schemas/item-filter.ts` export `ItemFilterSchema`+type (operator union cũ+mới, dot-path + nested record), export từ `index.ts`; KHÔNG nới lỏng hơn runtime (Req 8.1-8.4; design §11; open question §12.5)

### Phase D — Tests, docs, Setup Impact, DoD

- [ ] 7. Backward-compat & integration tests
  - [ ] 7.1 Integration test trên DB thật: tạo item có JSON lồng (`metadata.author.country`, `metadata.tags[]`) → list với dot-path, nested-object, JSON ops trả đúng record (Req 1, 2, 3; design §3-6)
  - [ ] 7.2 Backward-compat test: filter top-level cũ (`{title:{_eq}}`) + Structural_Field (`status`, `created_at`) cho kết quả KHÔNG đổi; tenant scope giữ (kết quả không leak cross-site) (Req 7.1, 7.2, 7.5; design §10)

- [ ] 8. Docs & DoD
  - [ ] 8.1 Cập nhật `docs/en/api/hono-api-spec.md`: mô tả filter nested (dot-path + nested-object), JSON_Operator mới, Cast_Rule, limits, ví dụ request/response (Req 10.4; DoD §4)
  - [ ] 8.2 CHANGELOG entry (JSON Field Search) + README bump nếu version tăng (Req 10.4; DoD §4)
  - [ ] 8.3 **Setup Impact**: thêm dòng `n/a` (Feature spec `json-field-search`) vào bảng Registry trong `.kiro/specs/admin-setup-wizard/setup-impact.md` với ngày rà soát + lý do (query-layer enhancement; tận dụng `items_data_gin_idx` sẵn có; không seed/flag/wizard/capability/backfill/index mới) (Req 11; design §13; DoD §2)
  - [x] 8.4 Recursive typecheck (15/15) ✅ + targeted tests pass trên Postgres local (Req 10.1-10.3; DoD §1, §3)

---

## Implementation status (2026-06-22)

**Done — all phases** (commits split per task; author Javier; PR riêng).

- **Filter builder** ✅ `resolveFieldPath` (validate + split, allow-list `[A-Za-z0-9_]`, depth≤8, segment≤64), `fieldExpression(name, mode)` mở rộng cho dot-path (`#>>`/`#>` với `bindArrayLiteral` → `'{…}'::text[]`), JSON operators `_json_contains` (`@>`), `_has_key`/`_has_any_keys`/`_has_all_keys` (dùng `jsonb_exists*` + `asKeyArray` bound `text[]` — tránh xung đột placeholder `?`). Clause-count limit 100. SDK + Studio filter types cập nhật.

**Deviations:**
- **Cast_Rule (Req 4) hoãn**: filter top-level hiện tại KHÔNG cast (so sánh text); để giữ additive + tránh cast-error sập query, nested path cũng so sánh text ở v1. Numeric/boolean/date casting (an toàn qua `jsonb_typeof` guard) là v2. Ghi rõ.
- **Index cho `#>>` path (open question §12.1)**: KHÔNG thêm index — `@>`/key-existence hưởng GIN sẵn có; path-extract chấp nhận seq-scan v1.
- **Shared Zod `item-filter.ts` (Req 8)**: thay vì file schema riêng, cập nhật SDK `ItemFilterOp` type (runtime validate ở server vẫn là chốt chặn) — đủ cho type-safety SDK, gọn hơn.

**Verified:** recursive typecheck 15/15; `json-field-path.test.ts` (5, injection/validation) + `json-field-search.db.integration.test.ts` (7 trên Postgres thật: nested filter, top-level backward-compat, `_json_contains` sub-object + array membership, `_has_key`, `_has_any/_all_keys`, injection rejected).
