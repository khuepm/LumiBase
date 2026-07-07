# Requirements Document

## Introduction

Tài liệu yêu cầu cho **JSON Field Search** trong LumiBase — khả năng cho filter của REST API `/api/v1/items/:collection` **truy vấn vào BÊN TRONG nội dung JSON/JSONB** thay vì coi mỗi field như một giá trị phẳng (flat value). Bắt nguồn từ Directus discussion #7277: "Some databases like Postgres and recent MySQL can search INSIDE JSON objects instead of treating them as a flat value." Feature mở khoá việc lọc theo **đường dẫn lồng nhau** (nested paths) như `metadata.author.country` và theo **containment / key-existence** của JSON object/array.

LumiBase đã có một filter parser tree-shaped trưởng thành tại `apps/cms/src/services/item-service.ts` (`buildFilter()` dòng 230–301) với cú pháp `{ _and?: [], _or?: [], [field]: { [op]: value } }` (item-service.ts:79) và 13 operator (`_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _contains, _starts_with, _ends_with, _null, _nnull` — item-service.ts:63-76). Mọi item lưu trong cột JSONB `items.data`; field hiện chỉ map được **một mức key top-level** qua `sql\`${items.data}->>${name}\`` (helper `fieldExpression()`, item-service.ts:208-228). Feature này **mở rộng cùng parser** — không viết lại engine — để hỗ trợ nested path và operator JSONB mới, một cách **additive** (không phá vỡ filter top-level đang chạy).

Hiện trạng (gap):
- `fieldExpression()` chỉ build `data->>'<key>'` cho **một** key top-level; **không** truy vấn được path lồng như `metadata.tags` hay `metadata.config.enabled`.
- Không có operator JSONB-native (`@>`, `?`, `?|`, `?&`) — không lọc được containment hay key-existence trên object/array.
- `buildFilter()` **không type-aware**: mọi giá trị JSONB ra `->>'…'` là `text`, nên so sánh numeric/boolean/date sai (`'10' < '9'` theo lexicographic). Type metadata có sẵn qua `SchemaService.getCompiled()` / `CompiledField` (schema-service.ts:66-99, field có `type`/`name`/`options`) nhưng **chưa dùng** cho JSON navigation.
- Filter **không được validate bằng Zod** ở `packages/shared/src/schemas/` (chỉ có `z.record(z.string(), z.unknown())` ở items.ts:14-16); path do user gửi đi thẳng vào SQL builder — đây là bề mặt cần siết để chống injection.

Điểm tựa hạ tầng quan trọng: **đã tồn tại GIN index trên `items.data`** (`items_data_gin_idx`, `cms.ts:233-236`, migration `0001`) — nghĩa là operator containment `@>` và key-existence `?`/`?|`/`?&` có thể tận dụng index sẵn có, không cần migration mới ở v1.

Phạm vi feature: tầng query của `ItemService.list()` (filter + optionally sort) trên `items.data` JSONB. **Ngoài phạm vi:** materialize JSON ra cột vật lý, full-text search (đã do MeiliSearch/`SearchProvider` lo), thay đổi storage mode, thêm index mới bắt buộc (chỉ discuss ở Open questions của design).

## Glossary

- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Item_Filter**: Cấu trúc filter tree-shaped đang dùng — `{ _and?: [], _or?: [], [field]: { [op]: value } }` (item-service.ts:79), parse bởi `buildFilter()`.
- **Field_Reference**: Tên field trong một mệnh đề filter. Hiện là một key top-level; feature mở rộng để cho phép **JSON_Path**.
- **JSON_Path**: Tham chiếu tới một giá trị lồng bên trong JSON, biểu diễn bằng **dot-path** (`metadata.author.country`) hoặc **bracket form** (filter lồng object), compile thành Postgres path operator `#>>'{metadata,author,country}'`.
- **Path_Segment**: Một thành phần của JSON_Path (vd `metadata`, `author`, `country`, hoặc chỉ số mảng `0`). Là dữ liệu do người dùng nhập → phải được validate + bind.
- **JSON_Operator**: Operator mới hoạt động trên cấu trúc JSON: `_json_contains` (`@>`), `_has_key` (`?`), `_has_any_keys` (`?|`), `_has_all_keys` (`?&`), và membership của giá trị trong một JSON array.
- **Cast_Rule**: Quy tắc ép kiểu một giá trị JSON text (`#>>`) sang kiểu so sánh đúng (`::numeric`, `::boolean`, `::timestamptz`) dựa trên `CompiledField.type`.
- **Compiled_Field**: Metadata field đã biên dịch từ `SchemaService.getCompiled()` (`CompiledField`, schema-service.ts:66-99), chứa `name`, `type`, `options`. Dùng để quyết định Cast_Rule.
- **Path_Depth**: Số Path_Segment của một JSON_Path (vd `a.b.c` có depth 3).
- **Filter_Builder**: Hàm dựng SQL từ Item_Filter — `buildFilter()` + helper `fieldExpression()` trong item-service.ts.
- **Top_Level_Filter**: Filter một-mức hiện hành (`data->>'key'`); phải tiếp tục chạy không đổi (backward compatibility).
- **Structural_Field**: Field map sang cột thật, không phải JSONB (`id, status, sort, user_created, user_updated, created_at, updated_at` — item-service.ts:193-201, 207-228).

## Requirements

### Requirement 1: Lọc theo đường dẫn JSON lồng nhau (dot-path)

**User Story:** Là một API consumer, tôi muốn lọc item theo một giá trị nằm sâu trong JSON (vd `metadata.author.country`), để truy vấn dữ liệu lồng mà không phải làm phẳng schema.

#### Acceptance Criteria

1. WHEN một Field_Reference chứa dấu `.` (vd `"metadata.author.country"`) và không phải Structural_Field, THE Filter_Builder SHALL diễn giải nó là JSON_Path và compile thành Postgres path operator `${items.data}#>>${pathArray}` thay vì `->>`.
2. THE Filter_Builder SHALL hỗ trợ JSON_Path với mọi JSON_Operator hiện hành (`_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _contains, _starts_with, _ends_with, _null, _nnull`) giống hệt như field top-level.
3. WHEN JSON_Path tham chiếu một chỉ số mảng (vd `tags.0` hoặc `items.2.sku`), THE Filter_Builder SHALL coi segment số là index của JSON array trong path (`#>>'{tags,0}'`).
4. THE Filter_Builder SHALL build path JSONB bằng cách **truyền mảng Path_Segment như một bound parameter** (vd `text[]`), KHÔNG nối chuỗi segment vào câu SQL (xem Req 8).
5. WHERE một Field_Reference KHÔNG chứa `.`, THE Filter_Builder SHALL giữ nguyên hành vi top-level `data->>'<key>'` hiện tại (Top_Level_Filter không đổi — backward compatibility; xem Req 7).

### Requirement 2: Cú pháp filter lồng object (nested-object form)

**User Story:** Là một API consumer, tôi muốn diễn đạt filter lồng dưới dạng object lồng (`{ "metadata": { "author": { "country": { "_eq": "VN" } } } }`), để cú pháp đọc tự nhiên và đối xứng với deep-query.

#### Acceptance Criteria

1. WHEN một giá trị của Field_Reference là một object KHÔNG chứa operator key (không có key bắt đầu bằng `_`) mà chứa key con, THE Filter_Builder SHALL coi đó là nested-object form và gộp các key thành một JSON_Path.
2. THE nested-object form và dot-path form SHALL tương đương về mặt ngữ nghĩa: `{ "a": { "b": { "_eq": 1 } } }` compile giống `{ "a.b": { "_eq": 1 } }`.
3. WHEN một object vừa chứa operator key (`_eq`, …) vừa chứa key thường ở cùng cấp, THE Filter_Builder SHALL từ chối với `ItemServiceError('INVALID_FILTER', …)` (cú pháp nhập nhằng), không đoán.
4. THE Filter_Builder SHALL hỗ trợ `_and`/`_or` bao quanh cả filter lồng (operator logic vẫn lồng được như Item_Filter hiện tại — item-service.ts:234-246).

### Requirement 3: Operator containment & key-existence cho JSON

**User Story:** Là một API consumer, tôi muốn kiểm tra một JSON object/array có chứa một cấu trúc con hoặc một khoá nào đó, để lọc theo tag, nhãn, hay sub-object mà không cần biết vị trí chính xác.

#### Acceptance Criteria

1. THE Filter_Builder SHALL hỗ trợ operator `_json_contains` áp `@>`: `${jsonExpr} @> ${valueAsJsonb}`, với `jsonExpr` là `data->'<key>'` hoặc `data#>'{path}'` (toán tử `->`/`#>` trả JSON, không phải text).
2. THE Filter_Builder SHALL hỗ trợ operator `_has_key` áp `?`: kiểm tra JSON object/array có chứa key (hoặc phần tử string) đã cho.
3. THE Filter_Builder SHALL hỗ trợ `_has_any_keys` áp `?|` (nhận mảng string) và `_has_all_keys` áp `?&` (nhận mảng string).
4. THE Filter_Builder SHALL hỗ trợ membership của một giá trị scalar bên trong JSON array tại một path (vd `metadata.tags` chứa `"featured"`) — biểu diễn qua `_json_contains` với value được wrap thành JSON array, hoặc operator dành riêng được tài liệu hoá ở design.
5. WHEN value của `_has_any_keys`/`_has_all_keys` KHÔNG phải mảng string, THE Filter_Builder SHALL từ chối với `ItemServiceError('INVALID_FILTER', …)`.
6. THE giá trị JSON cho `_json_contains` SHALL được truyền như một **bound JSONB parameter** (serialize JSON + cast `::jsonb`), không nội suy chuỗi vào SQL (xem Req 8).
7. THE các JSON_Operator mới SHALL kết hợp được với `_and`/`_or` và với JSON_Path lồng (Req 1, 2).

### Requirement 4: Type-aware casting cho so sánh JSON

**User Story:** Là một API consumer, tôi muốn so sánh `>=`, `<`, `=` trên một số/ngày/boolean nằm trong JSON cho kết quả đúng kiểu, để `price >= 100` không bị so sánh theo thứ tự chữ.

#### Acceptance Criteria

1. WHEN một mệnh đề filter dùng operator so sánh (`_gt, _gte, _lt, _lte`) hoặc bình đẳng numeric (`_eq, _neq, _in, _nin`) trên một JSON_Path, THE Filter_Builder SHALL tra `Compiled_Field.type` qua `SchemaService.getCompiled()` và áp Cast_Rule tương ứng trên expression text JSON.
2. THE Cast_Rule SHALL định nghĩa:
   - `type` numeric (vd `integer`, `decimal`, `float`, `bigInteger`) → `(${items.data}#>>${path})::numeric`.
   - `type` boolean → `(${...}#>>${path})::boolean`.
   - `type` date/time (vd `date`, `datetime`, `timestamp`) → `(${...}#>>${path})::timestamptz`.
   - `type` string/text và mặc định → giữ `text` (không cast), so sánh `ilike`/`=` như hiện tại.
3. WHEN không xác định được `Compiled_Field.type` cho field gốc của JSON_Path (vd field không khai báo trong schema), THE Filter_Builder SHALL fallback an toàn về so sánh `text` (không cast), KHÔNG đoán kiểu.
4. WHEN value JSON tại path không cast được sang kiểu mục tiêu (vd text không phải số), THE so sánh SHALL không làm sập toàn bộ query do lỗi cast runtime; design SHALL chọn chiến lược an toàn (vd `jsonb_typeof` guard hoặc cast trên biểu thức đã lọc) — đây là một AC về tính bền (resilience).
5. THE operator chuỗi (`_contains, _starts_with, _ends_with`) SHALL luôn dùng biểu thức `text` (`#>>`) bất kể `Compiled_Field.type`.

### Requirement 5: Giới hạn độ sâu & độ dài path (bound query complexity)

**User Story:** Là một maintainer, tôi muốn chặn path JSON quá sâu hoặc quá dài, để một filter độc/ngớ ngẩn không sinh query phức tạp gây nghẽn DB.

#### Acceptance Criteria

1. THE Filter_Builder SHALL từ chối JSON_Path có Path_Depth vượt giới hạn cấu hình (mặc định **8** segment) với `ItemServiceError('INVALID_FILTER', 'Path too deep')` HTTP 400.
2. THE Filter_Builder SHALL từ chối Path_Segment đơn lẻ dài quá giới hạn (mặc định **64** ký tự) với `ItemServiceError('INVALID_FILTER', …)`.
3. THE Filter_Builder SHALL từ chối filter có tổng số mệnh đề (leaf clause) vượt giới hạn cấu hình (mặc định **100**) để chặn filter phình to vô hạn, với HTTP 400.
4. THE giới hạn depth/length/clause-count SHALL là hằng số đặt tập trung (một chỗ trong item-service hoặc shared constant), để dễ tinh chỉnh và test.

### Requirement 6: An toàn injection cho Path_Segment (critical security)

**User Story:** Là một maintainer bảo mật, tôi muốn mọi Path_Segment do người dùng cung cấp được validate và bind tham số, để không có cách nào chèn SQL qua tên path.

#### Acceptance Criteria

1. THE Filter_Builder SHALL validate mỗi Path_Segment khớp regex an toàn `^[A-Za-z0-9_]+$` (segment đối tượng) hoặc `^[0-9]+$` (index mảng); segment chứa ký tự khác (vd `'`, `"`, `,`, `{`, `}`, `\`, khoảng trắng, `;`) SHALL bị từ chối với `ItemServiceError('INVALID_FILTER', 'Invalid path segment')` HTTP 400.
2. THE Filter_Builder SHALL truyền path tới Postgres **chỉ** dưới dạng bound parameter (mảng `text[]` cho `#>>`/`#>`, hoặc string cho `?`), KHÔNG BAO GIỜ nội suy/nối chuỗi Path_Segment trực tiếp vào template `sql\`\``.
3. THE Filter_Builder SHALL từ chối operator không thuộc tập hợp lệ (cũ + JSON_Operator mới) với `ItemServiceError('INVALID_FILTER', 'Unknown operator')` — giữ nguyên hành vi default-case hiện tại (item-service.ts:293-294), mở rộng cho operator mới.
4. THE validation Path_Segment SHALL chạy trước khi bất kỳ SQL fragment nào được dựng cho mệnh đề đó (fail-fast, không tạo expression với segment bẩn).
5. THE Filter_Builder SHALL từ chối Field_Reference rỗng, segment rỗng (vd `a..b`, `.a`, `a.`) với `ItemServiceError('INVALID_FILTER', …)`.
6. WHEN một filter bị từ chối vì lý do an toàn, THE error message SHALL không phản chiếu (echo) lại nguyên văn payload độc của người dùng vào log một cách cho phép injection vào hệ thống log; message SHALL mô tả lỗi một cách an toàn.

### Requirement 7: Tương thích ngược (backward compatibility)

**User Story:** Là một API consumer hiện hữu, tôi muốn mọi filter top-level đang chạy tiếp tục hoạt động y nguyên, để feature mới không phá vỡ tích hợp sẵn có.

#### Acceptance Criteria

1. THE Top_Level_Filter dạng `{ "title": { "_eq": "x" } }` SHALL compile thành `data->>'title' = 'x'` y như trước (không đổi byte hành vi), với mọi operator hiện hành.
2. THE Structural_Field (`id, status, sort, user_created, user_updated, created_at, updated_at`) SHALL tiếp tục map sang cột thật qua `fieldExpression()` (item-service.ts:208-228) và KHÔNG bị diễn giải thành JSON_Path kể cả khi tên trùng pattern.
3. THE Field_Reference top-level chứa dấu `.` nhưng được người dùng chủ đích coi là key phẳng (legacy) SHALL được tài liệu hoá rõ trong design về cách phân biệt (mặc định: có `.` ⇒ nested; nếu cần escape, đề xuất bracket form làm escape hatch — quyết định ở design).
4. THE thay đổi SHALL là additive: không xoá/đổi nghĩa operator cũ; chỉ thêm JSON_Operator và khả năng nested.
5. THE mọi query SHALL tiếp tục được scope theo `site_id` qua `scopeSite(items.siteId, siteId)` trong cùng mệnh đề `and()` của `list()` (item-service.ts:458-465); JSON_Path không được phép bỏ qua tenant scope.

### Requirement 8: Validate filter schema ở tầng shared/SDK

**User Story:** Là một SDK consumer, tôi muốn filter (bao gồm cú pháp nested + operator JSON mới) được mô tả bằng một schema chia sẻ, để client validate sớm và TypeScript gợi ý đúng.

#### Acceptance Criteria

1. THE feature SHALL điều tra liệu filter có được validate bằng Zod ở `packages/shared/src/schemas/` hay không; phát hiện hiện tại: KHÔNG có filter schema ở shared (chỉ `z.record(z.string(), z.unknown())` tại items.ts:14-16). Kết quả điều tra SHALL được ghi vào design.
2. WHERE quyết định thêm một filter schema chia sẻ, THE schema SHALL nằm ở `packages/shared/src/schemas/item-filter.ts`, export một Zod schema + type, và liệt kê tập operator hợp lệ (cũ + JSON_Operator mới).
3. THE schema chia sẻ (nếu thêm) SHALL cho phép cả dot-path key lẫn nested-object form, và KHÔNG được nới lỏng hơn validation runtime của Filter_Builder (server vẫn là nguồn kiểm soát cuối — Req 6).
4. WHERE không thêm schema ở v1, THE design SHALL nêu lý do và ghi nó vào Open questions; runtime validation (Req 6) vẫn là bắt buộc bất kể.

### Requirement 9: Sắp xếp theo đường dẫn JSON (sort by nested path)

**User Story:** Là một API consumer, tôi muốn sort kết quả theo một giá trị JSON lồng (vd `metadata.priority`), để sắp xếp theo trường lồng giống như lọc theo nó.

#### Acceptance Criteria

1. WHEN một sort token tham chiếu một JSON_Path (vd `metadata.priority` hoặc `-metadata.priority`), THE `buildSort()` (item-service.ts:303-310) SHALL build biểu thức path JSONB tương tự Filter_Builder (cùng helper, cùng validate segment ở Req 6).
2. THE sort theo JSON_Path SHALL áp Cast_Rule (Req 4) khi `Compiled_Field.type` là numeric/date, để sort theo thứ tự đúng kiểu (số 10 sau 9, không trước).
3. THE sort token cho Structural_Field SHALL không đổi hành vi (item-service.ts:303-310).
4. THE Path_Segment trong sort token SHALL chịu cùng validate an toàn (Req 6) như trong filter.

### Requirement 10: Kiểm thử & tài liệu

**User Story:** Là một maintainer, tôi muốn feature có test bao phủ injection + casting + nested + backward-compat và tài liệu API cập nhật, để tin cậy và dùng được.

#### Acceptance Criteria

1. THE feature SHALL có unit test cho `buildFilter()`/`fieldExpression()` phủ: dot-path, nested-object form, mỗi JSON_Operator, mỗi Cast_Rule, depth/length limit, và **các ca injection bị từ chối** (segment chứa `'`, `;`, `{`, `--`, `,`).
2. THE feature SHALL có test khẳng định **tham số hoá**: path không xuất hiện như literal trong SQL string (vd kiểm tra `sql` object có path trong `params` chứ không trong `queryChunks` literal).
3. THE feature SHALL có test backward-compat: filter top-level cũ và Structural_Field cho kết quả không đổi.
4. THE feature SHALL cập nhật `docs/en/api/hono-api-spec.md` (mô tả filter nested + operator JSON mới + ví dụ), CHANGELOG, và README nếu cần (per DoD).

### Requirement 11: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới không.

#### Acceptance Criteria

1. WHEN feature json-field-search hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả `n/a`).
2. THE rà soát SHALL xác định kết quả là **`n/a`**: feature là enhancement tầng query (filter/sort builder), không thêm bảng cần seed, không settings key bắt buộc, không bước UI wizard mới, không capability flag mới, không cần backfill, và không yêu cầu index mới ở v1 (tận dụng `items_data_gin_idx` sẵn có — cms.ts:233-236).
