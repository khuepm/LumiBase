# Design Document — JSON Field Search

## Overview

Thiết kế cho **JSON Field Search**: mở rộng filter parser của `ItemService` để truy vấn vào **bên trong** JSONB `items.data` — theo đường dẫn lồng (nested path) và theo containment / key-existence — thay vì chỉ một mức key top-level. Feature **mở rộng tại chỗ** `buildFilter()` + `fieldExpression()` + `buildSort()` (item-service.ts:208-310), không thay engine. Hai nguyên tắc xuyên suốt:

1. **Additive & backward-compatible.** Field không có `.` ⇒ chạy đúng path `data->>'key'` cũ (item-service.ts:226). Structural_Field ⇒ map cột thật như cũ (item-service.ts:208-224). Chỉ field có `.` (hoặc nested-object form) mới đi nhánh JSON_Path mới.
2. **Injection-safe by construction.** Path do user nhập → validate regex chặt + **bind như parameter** (`text[]` cho `#>>`/`#>`, string cho `?`), không bao giờ nối chuỗi vào `sql\`\``. Drizzle's `sql` giữ binding tham số hoá (đúng như comment hiện có ở item-service.ts:225).

Điểm tựa hạ tầng: cột `items.data` đã có **GIN index** `items_data_gin_idx` (cms.ts:233-236, migration `0001_round_maggott.sql`) `USING gin (data) WHERE deleted_at IS NULL`. GIN hỗ trợ trực tiếp `@>`, `?`, `?|`, `?&` ⇒ operator containment/key-existence (Req 3) có thể dùng index sẵn có; **không cần migration mới ở v1**. (Lưu ý: `#>>` path-extract + cast KHÔNG dùng được GIN mặc định — xem Open questions §12.)

## Architecture

```
                 GET /api/v1/items/:collection?filter=<json>&sort=<csv>
                                     │
                                     ▼
          ┌──────────────── apps/cms/src/routes/items.ts ───────────────┐
          │  listQuerySchema (items.ts:18-26) → JSON.parse(filter)       │
          │  (items.ts:105)  → ItemService.list({ filter, sort, … })     │
          └───────────────────────────┬─────────────────────────────────┘
                                       ▼
          ┌──────────── apps/cms/src/services/item-service.ts ──────────┐
          │  list()  WHERE = and(                                        │
          │     scopeSite(items.siteId, siteId)   ← tenant scope (:459)  │
          │     eq(collectionId), isNull(deletedAt), status,             │
          │     buildFilter(filter),  ← EXTENDED                         │
          │     permClause )                          (:458-465)         │
          │                                                              │
          │  buildFilter(filter)  ────────────┐                          │
          │    walk _and/_or (:234-246)       │ for each leaf:           │
          │    resolveFieldRef(key|nested) ───┼─▶ FieldPath { segments } │
          │    validatePath(segments)  ◀──────┘   (Req 6 regex+depth)    │
          │    fieldExpression(path, op, compiledType) ─▶ SQL            │
          │       ├─ structural?  → real column (unchanged :208-224)     │
          │       ├─ 1 segment    → data->>'k'  (unchanged :226)         │
          │       └─ >1 segment   → data #>> $1::text[]  (+Cast_Rule)    │
          │       └─ JSON op      → data #> $1  @> $2::jsonb | ? $seg    │
          │  buildSort(sort) ── same path resolution + Cast_Rule         │
          └───────────┬──────────────────────────────────────────────────┘
                       ▼
   Postgres (Drizzle + postgres-js):  items.data  (JSONB)
   index: items_data_gin_idx USING gin (cms.ts:233-236)  ← @> ? ?| ?&
   type metadata: SchemaService.getCompiled() → CompiledField (schema-service.ts:66-99)
```

Không service mới, không bảng mới, không route mới. Toàn bộ thay đổi nằm trong `item-service.ts` (filter/sort builder) + optionally một Zod schema chia sẻ ở `packages/shared` (Req 8).

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (dot-path) | §3 grammar, §4 `resolveFieldRef`, §5 `fieldExpression` nhánh `#>>` |
| Req 2 (nested-object form) | §3 grammar, §4 `resolveFieldRef` (object walk) |
| Req 3 (containment/key-existence ops) | §6 JSON_Operator mapping |
| Req 4 (type-aware casting) | §7 Cast_Rule + `CompiledField` lookup |
| Req 5 (depth/length/clause limits) | §8 limits + `validatePath` |
| Req 6 (injection safety) | §9 `validatePath` regex + parameter binding |
| Req 7 (backward compat) | §5 nhánh structural/top-level giữ nguyên, §10 |
| Req 8 (shared filter schema) | §11 shared Zod schema investigation |
| Req 9 (sort by path) | §5.4 `buildSort` reuse |
| Req 10 (tests/docs) | tasks Phase D |
| Req 11 (setup impact) | §13 Setup Impact |

## 2. Hiện trạng code được mở rộng (cite)

- Filter contract: `ItemFilter` (item-service.ts:78-86) — tree-shaped `_and/_or/[field]:{[op]:value}`.
- Operator set: `ItemFilterOp` (item-service.ts:63-76) — 13 op.
- `fieldExpression(name)` (item-service.ts:208-228): switch structural → real column; default → `sql\`${items.data}->>${name}\`` (chỉ 1 mức).
- `buildFilter(filter)` (item-service.ts:230-301): walk `_and`/`_or` (234-246), loop leaf (248-297), `switch(op)` build clause, default → `INVALID_FILTER` (293-294).
- `buildSort(sort)` (item-service.ts:303-310): dùng `fieldExpression()` ⇒ tự động hưởng lợi khi mở rộng.
- WHERE của `list()`: `and(scopeSite(...), eq(collectionId), isNull(deletedAt), status, buildFilter(filter), permClause)` (item-service.ts:458-465). **JSON_Path phải nằm trong cùng `and()` này** để không bao giờ thoát tenant scope (Req 7.5).
- Type metadata: `SchemaService.getCompiled(collectionName)` → `CompiledCollection` chứa `CompiledField[]` (schema-service.ts:63,949); `CompiledField` có `name`, `type`, `options` (schema-service.ts:66-99). `ItemService` đã giữ một `this.schemaService` (item-service.ts:313,326-330) ⇒ lookup type có sẵn, chưa dùng cho filter.
- Filter chưa có Zod schema ở shared: chỉ `z.record(z.string(), z.unknown())` (items.ts:14-16). `packages/shared/src/schemas/` hiện chỉ có `cdc.ts`, `extension-manifest.ts`, `site-config.ts`, `index.ts` — không có filter schema.

## 3. Filter grammar (mở rộng)

Cú pháp BNF rút gọn (phần in đậm là mới):

```
Filter      := { "_and": [Filter], … } | { "_or": [Filter], … } | FieldClause*
FieldClause := FieldKey ":" ( OpObject | NestedObject )       // NestedObject = mới (Req 2)
FieldKey    := Segment ( "." Segment )*                        // dot-path = mới (Req 1)
NestedObject:= "{" Segment ":" ( OpObject | NestedObject ) "}" // không chứa op key
OpObject    := "{" Operator ":" Value ( , Operator ":" Value )* "}"
Operator    := _eq | _neq | _in | _nin | _gt | _gte | _lt | _lte
             | _contains | _starts_with | _ends_with | _null | _nnull   // cũ
             | _json_contains | _has_key | _has_any_keys | _has_all_keys // mới (Req 3)
Segment     := [A-Za-z0-9_]+        (object key)
             | [0-9]+               (array index)               // Req 1.3, Req 6.1
```

Quy tắc phân nhánh (đối chiếu Req 7.2, 7.3):
- **Structural_Field** (tên ∈ `STRUCTURAL_FIELDS`, item-service.ts:193-201) ⇒ luôn cột thật, KHÔNG nested kể cả có `.`.
- **1 segment, không `.`** ⇒ top-level `data->>'k'` (item-service.ts:226 không đổi).
- **≥2 segment** (dot-path) hoặc **NestedObject** ⇒ JSON_Path → `#>>` / `#>`.
- **NestedObject vs OpObject:** một object là OpObject nếu **có** key bắt đầu bằng `_`; là NestedObject nếu **không có** key `_`. Trộn lẫn ⇒ `INVALID_FILTER` (Req 2.3).
- **Escape hatch (Req 7.3):** key phẳng chứa dấu `.` thật (hiếm) — v1 mặc định coi `.` là nested; nếu cần literal key có `.`, dùng NestedObject một-cấp `{ "weird.key": {…} }` **sẽ vẫn bị tách**, nên giải pháp escape (vd prefix `$.` hoặc `["weird.key"]`) để ở Open questions §12.4. Tài liệu hoá rõ.

`resolveFieldRef` chuẩn hoá cả hai form thành một mảng `segments: string[]`.

## 4. Path resolution

```ts
interface FieldPath {
  segments: string[];      // ['metadata','author','country'] | ['title'] | ['tags','0']
  isStructural: boolean;   // segments[0] ∈ STRUCTURAL_FIELDS && segments.length === 1
}

// Pure helpers, unit-testable không cần DB:
function resolveFieldRef(key: string): FieldPath          // dot-split + structural check
function flattenNested(obj): { path: string[]; opObject } // NestedObject → segments + leaf
function validatePath(segments: string[]): void           // Req 6 + Req 5 (throw INVALID_FILTER)
```

`validatePath` (gọi **trước** khi build SQL — Req 6.4):
- mỗi segment khớp `^[A-Za-z0-9_]+$` hoặc `^[0-9]+$`; nếu không → `INVALID_FILTER 'Invalid path segment'` (Req 6.1).
- segment rỗng / path rỗng (`a..b`, `.a`, `a.`) → `INVALID_FILTER` (Req 6.5).
- `segments.length > MAX_PATH_DEPTH` (8) → `INVALID_FILTER 'Path too deep'` (Req 5.1).
- mỗi segment `length > MAX_SEGMENT_LEN` (64) → `INVALID_FILTER` (Req 5.2).

## 5. `fieldExpression` mở rộng

Chữ ký mới: `fieldExpression(path: FieldPath, opCtx?: { compiledType?: string; mode: 'text'|'json' }): SQL`.

```ts
function fieldExpression(path, opCtx) {
  // 5.1 structural — KHÔNG đổi (item-service.ts:208-224)
  if (path.isStructural) return realColumn(path.segments[0]);

  // 5.2 top-level (1 segment) — KHÔNG đổi (item-service.ts:226)
  if (path.segments.length === 1 && opCtx?.mode !== 'json')
    return sql`${items.data}->>${path.segments[0]}`;

  // 5.3 nested text-extract → #>> với path BOUND như text[]   (Req 1.4, 6.2)
  //     `${path.segments}` được Drizzle bind thành mảng tham số, KHÔNG nối chuỗi.
  if (opCtx?.mode !== 'json')
    return applyCast(sql`${items.data}#>>${path.segments}`, opCtx?.compiledType);

  // 5.4 nested json-extract (cho @> / ?) → #> trả JSON
  return sql`${items.data}#>${path.segments}`;
}
```

- **Binding chứng minh:** `sql\`${items.data}#>>${path.segments}\`` — `path.segments` là một JS array đi vào danh sách param của `sql` (giống `${name}` ở item-service.ts:226 và `${raw as unknown[]}` ở `_in`, item-service.ts:261). Test (Req 10.2) khẳng định segment nằm trong `sql.params`, không trong `queryChunks` literal.
- `buildSort()` (item-service.ts:303-310) gọi cùng `fieldExpression(resolveFieldRef(name), { compiledType, mode:'text' })` ⇒ Req 9 "miễn phí" về cấu trúc; chỉ cần truyền compiledType + validate.

## 6. JSON_Operator mapping (Req 3)

| Operator | Postgres | Expression dựng | Value binding |
|---|---|---|---|
| `_json_contains` | `@>` | `${data#>path} @> ${json}::jsonb` | `sql\`${JSON.stringify(v)}::jsonb\`` (Req 3.6) |
| `_has_key` | `?` | `${data#>path} ? ${key}` | string bound |
| `_has_any_keys` | `?\|` | `${data#>path} ?\| ${keys}` | `text[]` bound; reject nếu không phải mảng string (Req 3.5) |
| `_has_all_keys` | `?&` | `${data#>path} ?& ${keys}` | `text[]` bound |
| array membership (Req 3.4) | `@>` | `${data#>path} @> ${[v]}::jsonb` | wrap value thành JSON array `[v]` rồi `::jsonb` |

Ghi chú toán tử `?` trong `sql\`\``: postgres-js dùng `$1,$2,…` cho param nên `?` literal không xung đột placeholder; tuy nhiên cần kiểm khi implement (một số driver cần escape `?`). Nếu xung đột → dùng `jsonb_exists(expr, key)` / `jsonb_exists_any` / `jsonb_exists_all` (hàm tương đương) thay cho toán tử — quyết định lúc implement, ghi Open questions §12.2.

Tất cả operator này dùng `mode:'json'` ⇒ `#>` (trả JSON) chứ không `#>>`. Containment/key-existence trên `data` gốc (path rỗng) hoặc trên một sub-object đều dùng được GIN index (cms.ts:233-236).

## 7. Cast_Rule (Req 4)

Tra type qua `this.schemaService.getCompiled(collection)` → tìm `CompiledField` theo `segments[0]` (field gốc; type của lá lồng không có trong schema ⇒ dựa type field gốc, fallback text). Bảng cast trên biểu thức `#>>` (text):

| `CompiledField.type` | Cast | Áp cho operator |
|---|---|---|
| `integer, bigInteger, decimal, float, number` | `::numeric` | `_eq _neq _in _nin _gt _gte _lt _lte` |
| `boolean` | `::boolean` | `_eq _neq` |
| `date, datetime, timestamp, time` | `::timestamptz` | so sánh + bình đẳng |
| `string, text, uuid, …`, hoặc không xác định | (none, giữ text) | tất cả |

- `_contains/_starts_with/_ends_with` luôn `text`, không cast (Req 4.5).
- **Resilience (Req 4.4):** cast thẳng `(data#>>path)::numeric` sẽ throw nếu value không phải số. Chiến lược v1: bọc guard `jsonb_typeof(data#>path) = 'number'` trong cùng clause (cho numeric), hoặc dùng `nullif`/safe-cast pattern; chọn cách tránh sập query — chốt lúc implement, ghi §12.3. Khi type không xác định ⇒ không cast (Req 4.3), an toàn nhất.

## 8. Limits (Req 5)

Hằng số tập trung (một nơi trong item-service.ts, cạnh `STRUCTURAL_FIELDS`):

```ts
const MAX_PATH_DEPTH = 8;     // Req 5.1
const MAX_SEGMENT_LEN = 64;   // Req 5.2
const MAX_FILTER_CLAUSES = 100; // Req 5.3 — đếm leaf clause khi walk
```

`buildFilter` đếm leaf khi walk; vượt → `INVALID_FILTER` (HTTP 400 qua `ItemServiceError`, status mặc định 400 — item-service.ts:121-126).

## 9. Injection safety (Req 6) — critical

Hai lớp phòng thủ, cả hai bắt buộc:

1. **Allow-list validate** (`validatePath`, §4): segment chỉ `[A-Za-z0-9_]+` hoặc `[0-9]+`. Mọi ký tự nguy hiểm (`' " , { } \ ; --` khoảng trắng) bị từ chối *trước* khi dựng SQL (Req 6.1, 6.4, 6.5).
2. **Parameter binding**: path đi vào SQL **chỉ** qua `${segments}` (mảng → bound param), value JSON qua `${JSON.stringify(v)}::jsonb`, keys qua `${keys}` (text[]). Không có `sql.raw`, không template literal nội suy segment. Test khẳng định binding (Req 10.2).

Operator allow-list giữ `default: throw INVALID_FILTER` (mở rộng switch hiện tại item-service.ts:293-294) cho cả op cũ + mới (Req 6.3). Error message an toàn, không echo payload thô vào sink injectable (Req 6.6).

## 10. Backward compatibility (Req 7)

- Nhánh structural (item-service.ts:208-224) và nhánh 1-segment (item-service.ts:226) **không đổi một dòng logic** ⇒ filter cũ byte-compatible (Req 7.1, 7.2).
- Chỉ field có `.`/nested mới rẽ nhánh mới ⇒ thuần additive (Req 7.4).
- `scopeSite` vẫn ở `and()` của `list()` (item-service.ts:458-465); JSON_Path là một clause con của `and()`, không thể thoát tenant (Req 7.5).

## 11. Shared filter Zod schema (Req 8)

Điều tra (Req 8.1): **KHÔNG** có filter schema ở `packages/shared/src/schemas/`; route chỉ validate `z.record(z.string(), z.unknown())` (items.ts:14-16); contract thực là TS `ItemFilter` (item-service.ts:78-86) + runtime của `buildFilter`.

Đề xuất (Req 8.2): thêm `packages/shared/src/schemas/item-filter.ts` export `ItemFilterSchema` (Zod) + type, liệt kê operator hợp lệ (cũ + JSON_Operator), cho phép dot-path key (string) và nested-object (record đệ quy). Export từ `index.ts`. Quan trọng (Req 8.3): schema này **không** thay thế runtime validate ở §9 — server vẫn là chốt chặn cuối (path regex + depth + binding). Nếu phạm vi v1 muốn nhỏ, có thể hoãn schema và chỉ siết runtime; nêu ở Open questions §12.5.

## 12. Open questions

1. **Indexing cho `#>>` path queries.** GIN mặc định (`jsonb_ops`) **không** tăng tốc `data#>>'{a,b}' = x` (chỉ tăng tốc `@>`, `?`). Lựa chọn cho path-extract nhanh: (a) expression index per path (`CREATE INDEX ON items ((data#>>'{a,b}'))`) — không khả thi generic; (b) GIN `jsonb_path_ops` — chỉ giúp `@>`; (c) chấp nhận seq-scan cho path filter ở v1, document rõ và khuyến nghị operator `@>` khi có thể. **Chốt v1: không thêm index; document trade-off.** Index theo path là tuỳ chọn vận hành (v2, qua field `indexed=true` đã có ở cms.ts:110).
2. **Toán tử `?`/`?|`/`?&` trong postgres-js template.** Có thể xung đột với placeholder parser. Fallback: dùng hàm `jsonb_exists`/`jsonb_exists_any`/`jsonb_exists_all`. Quyết định khi implement bằng một test thực.
3. **Safe-cast strategy cho Req 4.4.** `jsonb_typeof` guard vs `nullif`-cast vs cast trực tiếp (chấp nhận lỗi 400). Chốt: ưu tiên không-sập (typeof guard cho numeric/boolean), document.
4. **Escape cho literal key chứa `.`.** Mặc định `.` ⇒ nested. Có cần escape hatch (`["a.b"]` hay `$.a.b` JSONPath)? v1 document hạn chế; cân nhắc v2 nếu có nhu cầu thực.
5. **Phạm vi shared Zod schema ở v1.** Thêm `item-filter.ts` ngay (đồng bộ SDK) hay hoãn? Khuyến nghị: thêm tối thiểu (operator union + nested record) để SDK type đúng; runtime vẫn là chốt chặn.
6. **JSONPath operator (`jsonb_path_query`/`@?`/`@@`).** Một hướng mạnh hơn dot-path (hỗ trợ filter/wildcard trong path). Ngoài phạm vi v1; ghi nhận như hướng mở rộng tương lai.

## 13. Setup Impact (Req 11)

Rà soát 6 câu hỏi → **`n/a`**:
1. Seed bảng mới? Không — chỉ sửa query builder.
2. Settings key bắt buộc? Không — limits là hằng số code.
3. Policy/grant DB? Không — dùng permission/scope hiện hữu.
4. Bước UI wizard? Không.
5. Capability flag? Không.
6. Backfill / index mới? Không — tận dụng `items_data_gin_idx` sẵn có (cms.ts:233-236); path index là tuỳ chọn vận hành, không bắt buộc.

Ghi `n/a` vào Registry với ngày rà soát + lý do.
