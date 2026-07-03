# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Code-First Configuration** trong LumiBase — khả năng export toàn bộ cấu hình *schema* của một site (collections, fields, relations, settings, webhooks) ra một **manifest khai báo** có thể version-control, diff, và apply lại theo cách an toàn (transactional, dry-run) để phục vụ **CI/CD, version control, và environment sync** (à la Directus schema snapshot/apply).

LumiBase đã có template trưởng thành cho mô hình này ở phạm vi access control: `apps/cms/src/services/access-export.ts` + `access-import.ts` (manifest versioned `lumibase.access@v1`, Zod validation, dry-run, diff engine với status `create|update|unchanged|delete`, transactional apply với mode `merge|replace-managed|replace-all`, CLI `lumibase access export|import`). Feature này **mở rộng cùng pattern** sang schema config — không phát minh cơ chế mới.

Hiện trạng (gap):
- `schema-service.ts` đã có `diffSchema()` + `updateSchema()` (atomic apply collection/field/relation) nhưng **không có export manifest khai báo** dạng file.
- `config-cli.ts` đã tồn tại nhưng còn sơ khai: export/import từng file JSON rời, **không có unified manifest, không Zod validation, không diff engine, không atomic apply**.
- `site-config.ts` (shared) có Zod schema cho settings nhưng **không có service export/import**.

Phạm vi feature: schema config (collections, fields, relations), settings/site-config, và webhooks. **Ngoài phạm vi:** content items (đó là dữ liệu, không phải config — sẽ do feature `content-releases` xử lý), access control (đã có `access-export/import`), secrets/env (không bao giờ đưa vào manifest).

## Glossary

- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Config_Manifest**: Một file JSON khai báo, versioned (`lumibase.config@v1`), chứa toàn bộ schema config của một site: collections, fields, relations, settings, webhooks. Là source of truth cho version control.
- **Config_Export_Service**: Service trong CMS sinh `Config_Manifest` từ trạng thái DB hiện tại của một site.
- **Config_Import_Service**: Service trong CMS nhận `Config_Manifest`, validate, tính diff so với trạng thái hiện tại, và apply trong transaction.
- **Config_Diff**: Kết quả so sánh giữa `Config_Manifest` đầu vào và trạng thái DB hiện tại, mỗi resource gắn status `create | update | unchanged | delete`.
- **Apply_Mode**: Chế độ apply — `merge` (chỉ create/update, không xoá), `replace-managed` (create/update + xoá resource có cờ managed mà không còn trong manifest), `replace-all` (đồng bộ tuyệt đối, xoá mọi resource không có trong manifest). Mirrors `AccessImportService` mode.
- **Dry_Run**: Chạy validate + tính diff mà KHÔNG ghi DB; trả về `Config_Diff` để review trong CI.
- **Stable_Key**: Khoá định danh ổn định của resource dùng để match giữa manifest và DB, độc lập với `id` (nanoid) tự sinh. Với collection: `name`. Với field: `collection.field`. Với relation: `manyCollection.manyField`. Với webhook: `name`. Với setting: `key`.
- **Config_CLI**: Lệnh `lumibase config export|import|diff` trong `apps/cms/scripts/config-cli.ts`, gọi service tương ứng.
- **Managed_Marker**: Cờ đánh dấu một resource thuộc quyền quản lý của manifest (analog với `managed` của access import), để `replace-managed` biết được phép xoá resource nào.

## Requirements

### Requirement 1: Export cấu hình schema ra Config Manifest

**User Story:** Là một developer vận hành LumiBase, tôi muốn export toàn bộ schema config của một site ra một file JSON khai báo, để commit vào git và review thay đổi qua pull request.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated admin-only `GET /api/v1/config/export` trả về `Config_Manifest` với `version: 'lumibase.config@v1'` và body `{ data: Config_Manifest }`.
2. THE Config_Export_Service SHALL bao gồm trong manifest: tất cả collections, fields, relations, webhooks, và settings của site, mỗi resource được serialize bằng `Stable_Key` thay vì `id` tự sinh (nanoid).
3. THE Config_Export_Service SHALL KHÔNG bao gồm trong manifest: `id` (nanoid), `siteId`, `createdAt`/`updatedAt`, content items, secrets, password hash, API key hash, hoặc bất kỳ giá trị nhạy cảm nào.
4. THE Config_Export_Service SHALL serialize relations bằng cách tham chiếu collection/field qua `Stable_Key` (`manyCollection.manyField` ↔ `oneCollection`), không dùng numeric/nanoid id.
5. THE Config_Export_Service SHALL sắp xếp deterministic mọi mảng resource (collections theo `name`, fields theo `collection.field`, relations theo stable key) để hai lần export trên cùng trạng thái cho output byte-identical (diff-friendly trong git).
6. WHERE query `?scope=schema|settings|webhooks|all` được truyền, THE Config_Export_Service SHALL chỉ export phạm vi tương ứng; mặc định `all`.
7. THE Config_Export_Service SHALL scope mọi query theo `site_id` của request (qua `scopeSite()`); không bao giờ export config của site khác.

### Requirement 2: Validate Config Manifest theo schema

**User Story:** Là một developer, tôi muốn manifest được validate chặt trước khi apply, để một file config sai cú pháp bị từ chối sớm trong CI thay vì làm hỏng instance.

#### Acceptance Criteria

1. THE Config_Import_Service SHALL validate `Config_Manifest` đầu vào bằng Zod schema đặt tại `packages/shared/src/schemas/config-manifest.ts`, export type `ConfigManifest`.
2. WHEN manifest có `version` không khớp `lumibase.config@v1`, THE Config_Import_Service SHALL từ chối với HTTP 422 và body `{ errors: [{ code: 'UNSUPPORTED_MANIFEST_VERSION', message }] }`.
3. WHEN manifest chứa field tham chiếu tới collection không tồn tại trong cùng manifest (và cũng không tồn tại trong DB), THE Config_Import_Service SHALL từ chối với `{ errors: [{ code: 'DANGLING_REFERENCE', path }] }` trước khi apply bất kỳ thay đổi nào.
4. WHEN manifest chứa relation tham chiếu tới collection/field không resolve được, THE Config_Import_Service SHALL từ chối với `DANGLING_REFERENCE` và chỉ rõ relation lỗi.
5. THE Config_Import_Service SHALL từ chối manifest có hai collections/fields/relations trùng `Stable_Key` với `{ errors: [{ code: 'DUPLICATE_KEY', path }] }`.
6. THE Config_Import_Service SHALL chạy toàn bộ validation (2)–(5) trước khi mở DB transaction; không side-effect nào (audit, cache invalidation) được phát ra nếu validation fail.

### Requirement 3: Tính diff giữa Manifest và trạng thái hiện tại

**User Story:** Là một developer, tôi muốn xem chính xác những thay đổi mà một manifest sẽ tạo ra trước khi apply, để review an toàn trong pull request CI.

#### Acceptance Criteria

1. THE Config_Import_Service SHALL expose endpoint authenticated admin-only `POST /api/v1/config/import?dryRun=true` nhận `Config_Manifest` trong body và trả `{ data: Config_Diff }` mà KHÔNG ghi DB.
2. THE Config_Diff SHALL liệt kê cho mỗi resource (collection, field, relation, webhook, setting) một status thuộc `create | update | unchanged | delete`, match bằng `Stable_Key`.
3. WHEN một resource tồn tại trong manifest nhưng không trong DB, THE Config_Import_Service SHALL gán status `create`.
4. WHEN một resource tồn tại trong cả manifest và DB nhưng khác giá trị (sau khi loại trừ các field bị bỏ ở Req 1.3), THE Config_Import_Service SHALL gán status `update` và liệt kê các field thay đổi.
5. WHEN một resource giống hệt giữa manifest và DB, THE Config_Import_Service SHALL gán status `unchanged`.
6. WHEN một resource tồn tại trong DB nhưng không trong manifest, THE Config_Import_Service SHALL gán status `delete` CHỈ KHI `Apply_Mode` là `replace-managed` (với resource có `Managed_Marker`) hoặc `replace-all`; với mode `merge`, status SHALL là `unchanged` (không đề xuất xoá).
7. THE Config_Diff SHALL gắn cờ risk `low | medium | high` cho mỗi thay đổi destructive (xoá collection/field có dữ liệu → `high`; đổi field type → `high`; thêm field nullable → `low`), tái dùng đánh giá risk của `schema-service.diffSchema()` khi có thể.

### Requirement 4: Apply Manifest trong transaction

**User Story:** Là một developer chạy CI/CD pipeline, tôi muốn apply một manifest một cách atomic, để hoặc toàn bộ config được cập nhật, hoặc không gì cả — không để instance ở trạng thái nửa vời.

#### Acceptance Criteria

1. THE Config_Import_Service SHALL expose endpoint authenticated admin-only `POST /api/v1/config/import?mode=<Apply_Mode>` apply manifest trong một DB transaction Drizzle duy nhất.
2. THE Config_Import_Service SHALL apply resource theo thứ tự phụ thuộc: collections → fields → relations → webhooks → settings; để field/relation luôn tham chiếu được collection đã tồn tại.
3. WHEN bất kỳ operation nào trong transaction thất bại, THE Config_Import_Service SHALL rollback toàn bộ và trả `{ errors: [...] }` HTTP 422/500; trạng thái DB SHALL không đổi.
4. THE Config_Import_Service SHALL match resource bằng `Stable_Key` khi update (giữ nguyên `id` nanoid hiện có; không tạo id mới cho resource đã tồn tại).
5. WHERE `Apply_Mode='replace-all'`, THE Config_Import_Service SHALL xoá mọi resource trong DB không có trong manifest, theo thứ tự ngược phụ thuộc (relations → fields → collections) để không vi phạm FK.
6. WHERE `Apply_Mode='merge'`, THE Config_Import_Service SHALL không xoá resource nào (chỉ create/update).
7. THE Config_Import_Service SHALL từ chối apply (HTTP 409 `{ errors: [{ code: 'DESTRUCTIVE_BLOCKED' }] }`) một thay đổi risk `high` TRỪ KHI query `?allowDestructive=true` được truyền tường minh; dry-run luôn hiển thị thay đổi destructive bất kể cờ này.
8. THE Config_Import_Service SHALL invalidate compiled-schema cache (`schema:<siteId>:*`) sau khi commit transaction thành công, để API phản ánh schema mới ngay không cần restart (tái dùng cơ chế cache invalidation của `schema-service`).
9. THE Config_Import_Service SHALL scope mọi query theo `site_id`; manifest từ site A không được apply vào site B.

### Requirement 5: Config CLI cho CI/CD

**User Story:** Là một developer, tôi muốn export/diff/apply config từ command line, để tích hợp vào pipeline CI/CD và script đồng bộ môi trường.

#### Acceptance Criteria

1. THE Config_CLI SHALL hỗ trợ `lumibase config export [--scope=all|schema|settings|webhooks] [--out <file>]` ghi `Config_Manifest` ra file (mặc định stdout).
2. THE Config_CLI SHALL hỗ trợ `lumibase config diff <file>` in `Config_Diff` ra stdout dạng human-readable (status + risk per resource) và exit code `0` nếu không thay đổi, `1` nếu có thay đổi (để CI gate).
3. THE Config_CLI SHALL hỗ trợ `lumibase config apply <file> [--mode=merge|replace-managed|replace-all] [--allow-destructive] [--dry-run]` gọi `Config_Import_Service`.
4. WHEN `--dry-run` được truyền, THE Config_CLI SHALL chỉ in diff và không ghi DB, exit `0`.
5. WHEN apply gặp `DESTRUCTIVE_BLOCKED` mà không có `--allow-destructive`, THE Config_CLI SHALL exit code khác `0` và in rõ resource bị chặn.
6. THE Config_CLI SHALL đọc kết nối DB từ cùng nguồn env mà các CLI hiện có (`access-cli.ts`, `typegen.js`) đang dùng, không thêm cơ chế cấu hình mới.
7. THE Config_CLI SHALL không in secret/hash ra stdout hay log ở bất kỳ subcommand nào.

### Requirement 6: Round-trip serialization (export → import = no-op)

**User Story:** Là một developer, tôi muốn export rồi import lại ngay trên cùng instance không tạo ra thay đổi nào, để tin tưởng manifest là biểu diễn trung thực của trạng thái.

#### Acceptance Criteria

1. FOR ALL trạng thái config hợp lệ của một site, `export()` rồi `import(dryRun=true, mode='replace-all')` trên cùng site SHALL trả `Config_Diff` với mọi resource status `unchanged` (round-trip property).
2. THE Config_Export_Service SHALL có hàm thuần (pure) `serializeConfig(state): ConfigManifest` để unit test round-trip không cần DB.
3. WHEN manifest thiếu một field optional (forward compat), THE Config_Import_Service SHALL điền giá trị mặc định của schema thay vì reject.
4. WHEN manifest chứa field thừa không có trong schema `lumibase.config@v1`, THE Config_Import_Service SHALL bỏ qua field thừa và log warning một lần per apply.
5. THE serialize/parse SHALL canonical (key sorted, mảng sorted theo Stable_Key) để output ổn định byte-for-byte phục vụ git diff.

### Requirement 7: Audit và an toàn

**User Story:** Là một admin, tôi muốn mọi lần apply config được ghi audit, để truy vết ai đã thay đổi schema và khi nào.

#### Acceptance Criteria

1. WHEN một apply hoàn tất thành công, THE CMS SHALL ghi Audit_Log entry `config_applied` với metadata `{ mode, scope, counts: { created, updated, deleted }, manifestVersion }` (KHÔNG ghi nội dung resource chi tiết có thể chứa thông tin nhạy cảm).
2. WHEN một apply bị rollback, THE CMS SHALL ghi Audit_Log entry `config_apply_failed` với lý do lỗi (không kèm secret).
3. THE Config endpoints (`/config/export`, `/config/import`) SHALL yêu cầu role với `adminAccess=true` (qua middleware auth + permission service hiện có); request không đủ quyền trả HTTP 403 `{ errors: [{ code: 'FORBIDDEN' }] }`.
4. THE Config_Import_Service SHALL áp dụng cùng quy tắc non-negotiable của CLAUDE.md: giữ nanoid cho resource mới, scope `site_id`, dùng runtime abstraction cho cache, response format `{ data }` / `{ errors }`.

### Requirement 8: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới không.

#### Acceptance Criteria

1. WHEN feature code-first-config hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả `n/a`).
2. THE rà soát SHALL xác định: feature không thêm bảng cần seed (chỉ đọc/ghi schema config sẵn có), không thêm settings key bắt buộc, không cần bước UI wizard mới, không capability flag mới, và không cần backfill (endpoint là surface mới chồng lên config hiện hữu).
