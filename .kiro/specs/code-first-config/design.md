# Design Document — Code-First Configuration

## Overview

Thiết kế cho **Code-First Configuration**: export/diff/apply schema config (collections, fields, relations, settings, webhooks) của một site qua một `Config_Manifest` khai báo, versioned `lumibase.config@v1`. Feature tái sử dụng kiến trúc đã chứng minh ở `access-export.ts` / `access-import.ts` và `schema-service.ts` (diff + atomic apply), thêm tầng manifest + CLI để phục vụ CI/CD và environment sync.

Nguyên tắc thiết kế: **không phát minh cơ chế mới**. Manifest pattern = `AccessExportManifest`. Apply transaction = `SchemaService.updateSchema()`. Diff + risk = `SchemaService.diffSchema()`. CLI = mở rộng `config-cli.ts` sơ khai hiện có theo khuôn `access-cli.ts`.

## Architecture

```
┌──────────── CI/CD pipeline / developer shell ────────────┐
│  lumibase config export → config.json  (commit to git)   │
│  lumibase config diff config.json      (PR gate, exit 1) │
│  lumibase config apply config.json --mode=replace-managed│
└───────────────────────┬──────────────────────────────────┘
                        │ (CLI gọi service trực tiếp, hoặc HTTP)
                        ▼
┌──────────────────────── CMS (Hono) ──────────────────────┐
│  /api/v1/config/export   → ConfigExportService           │
│  /api/v1/config/import    → ConfigImportService          │
│      ?dryRun=true → diff only                            │
│      ?mode=… &allowDestructive=… → transactional apply   │
│                                                           │
│  Reuse: SchemaService (updateSchema, diffSchema, compile) │
│         scopeSite() · compiled-schema cache invalidation  │
└───────────────────────┬───────────────────────────────────┘
                        ▼
        Postgres (Drizzle): collections · fields · relations
                            webhooks · settings
        Cache (runtime.cache): schema:<siteId>:* (invalidate)
```

Hai service mới, đặt cạnh các service hiện có trong `apps/cms/src/services/`:
- `config-export-service.ts` — đọc DB → `ConfigManifest` (đối xứng `access-export.ts`).
- `config-import-service.ts` — `ConfigManifest` → validate → diff → apply (đối xứng `access-import.ts`), **ủy quyền apply schema cho `SchemaService.updateSchema()`** thay vì viết lại upsert logic.

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (export) | §3 ConfigManifest shape, §4.1 ConfigExportService, §6 serializeConfig |
| Req 2 (validate) | §5 Zod schema `config-manifest.ts`, §4.2 validate phase |
| Req 3 (diff) | §4.3 diff phase (reuse `diffSchema`), §7 risk mapping |
| Req 4 (apply tx) | §4.4 apply phase (reuse `updateSchema`), §4.5 mode handling |
| Req 5 (CLI) | §8 Config CLI |
| Req 6 (round-trip) | §6 serializeConfig pure fn + property test |
| Req 7 (audit/security) | §9 audit + auth |
| Req 8 (setup impact) | §10 Setup Impact |

## 2. Mô hình dữ liệu — không thêm bảng mới

Feature **không tạo bảng mới**. Nó đọc/ghi các bảng config sẵn có:
- `collections` (`packages/database/src/schema/cms.ts:47-86`)
- `fields` (`cms.ts:88-147`)
- `relations` (`cms.ts:149-177`) — `onDelete` đã là cột cấu hình được
- `webhooks` (route `apps/cms/src/routes/webhooks.ts`)
- `settings` (key/value JSONB, dùng bởi site-config + login policy)

**Managed_Marker:** thêm cờ ở tầng manifest, không phải cột DB mới — một resource được coi là "managed" nếu nó xuất hiện trong một manifest đã apply. Để tránh thêm cột, `replace-managed` mode trong v1 hành xử như sau: chỉ xoá resource khớp `Stable_Key` namespace mà manifest tuyên bố quản lý qua `manifest.managedScopes` (danh sách collection name). Đây là quyết định giữ migration zero-cost; xem §11 open question 1.

## 3. ConfigManifest shape (`lumibase.config@v1`)

```jsonc
{
  "version": "lumibase.config@v1",
  "exportedAt": "<ISO, chỉ để người đọc; bỏ qua khi import>",
  "collections": [
    { "name": "articles", "label": "Articles", "primaryKeyType": "nanoid",
      "storageMode": "jsonb", "accountability": "all", "versioning": true,
      "meta": { /* sorted keys */ } }
  ],
  "fields": [
    { "collection": "articles", "field": "title", "type": "string",
      "interface": "input", "validation": {…}, "options": {…},
      "versioned": true, "classification": null }
  ],
  "relations": [
    { "manyCollection": "articles", "manyField": "author",
      "oneCollection": "users", "type": "m2o", "onDelete": "set null",
      "meta": {…} }
  ],
  "webhooks": [ { "name": "on-publish", "url": "…", "events": [...], "headers": {…} } ],
  "settings": [ { "key": "login_security_policy", "value": {…} } ],
  "managedScopes": ["articles", "authors"]   // optional; for replace-managed
}
```

Quy tắc serialize (Req 1.2–1.5, 6.5):
- **Bỏ** `id`, `siteId`, `createdAt`, `updatedAt`, mọi hash/secret.
- Relation tham chiếu qua tên collection/field (Stable_Key), không nanoid.
- Mảng sorted: collections theo `name`, fields theo `${collection}.${field}`, relations theo `${manyCollection}.${manyField}`, settings theo `key`.
- Object key sorted (canonical JSON) qua một `canonicalize()` helper dùng chung.

## 4. Service flow

### 4.1 ConfigExportService.export(scope)
1. `scopeSite()` cho mọi select theo `siteId`.
2. Load collections/fields/relations từ DB (tái dùng các select của `schema-service` nếu tiện), webhooks, settings.
3. Map → manifest shape (drop fields ở Req 1.3), canonicalize, sort.
4. Trả `{ data: manifest }`.

### 4.2 ConfigImportService — validate phase (Req 2)
1. Parse body bằng `ConfigManifestSchema` (Zod). Lỗi → 422 với path.
2. Check `version === 'lumibase.config@v1'` → nếu sai, `UNSUPPORTED_MANIFEST_VERSION`.
3. Build set Stable_Key của collections (manifest ∪ DB). Với mỗi field/relation, resolve collection target trong set đó; thiếu → `DANGLING_REFERENCE`.
4. Detect duplicate Stable_Key → `DUPLICATE_KEY`.
5. Mọi lỗi validate xảy ra **trước** khi mở transaction (Req 2.6).

### 4.3 ConfigImportService — diff phase (Req 3)
- Reuse `SchemaService.diffSchema(proposed)` cho phần collections/fields/relations: nó đã trả `collection.changed[]`, `fields.added/removed/changed[]`, `relations.added/removed/changed[]` kèm risk (`schema-service.ts:875-887`, `buildSchemaDiff` ~`1290-1449`).
- Webhooks/settings: diff đơn giản bằng so sánh canonical JSON theo Stable_Key.
- Map kết quả về `Config_Diff` thống nhất với status `create|update|unchanged|delete` (delete chỉ khi mode cho phép — §4.5).
- `dryRun=true` → trả `{ data: Config_Diff }`, không transaction.

### 4.4 ConfigImportService — apply phase (Req 4)
1. Nếu có thay đổi risk `high` và không `allowDestructive` → 409 `DESTRUCTIVE_BLOCKED` (trước transaction).
2. Mở transaction Drizzle.
3. Apply theo thứ tự: collections → fields → relations → webhooks → settings.
   - Schema phần (collections/fields/relations): **gọi `SchemaService.updateSchema(payload, { tx })`** — nó đã atomic, đã xử lý upsert + delete + risk. Truyền tx hiện tại để cùng nằm trong một transaction.
   - Webhooks/settings: upsert theo Stable_Key trong cùng tx.
4. Mode delete handling (§4.5).
5. Commit. Sau commit: invalidate cache `schema:<siteId>:*` (Req 4.8) + audit `config_applied` (Req 7.1).
6. Lỗi bất kỳ → tx rollback, audit `config_apply_failed`, trả lỗi (Req 4.3, 7.2).

> Quyết định: `updateSchema` hiện nhận deps gồm `db`. Cần cho phép truyền một `tx` (transaction handle) để import chạy mọi thứ trong một transaction. Nếu refactor này quá xâm lấn, fallback: import service tự mở transaction và gọi các bước upsert ở mức repository mà `schema-service` expose. Xem §11 open question 2.

### 4.5 Apply_Mode (Req 4.5–4.6, 3.6)
- `merge`: chỉ create/update. Resource trong DB vắng khỏi manifest → giữ nguyên (`unchanged`).
- `replace-managed`: create/update + xoá resource thuộc `managedScopes` mà vắng khỏi manifest.
- `replace-all`: create/update + xoá MỌI resource vắng khỏi manifest, theo thứ tự ngược (relations → fields → collections) để không vỡ FK.

## 5. Zod schema — `packages/shared/src/schemas/config-manifest.ts`

- Export `ConfigManifestSchema` + type `ConfigManifest`.
- Sub-schema: `CollectionConfigSchema`, `FieldConfigSchema`, `RelationConfigSchema`, `WebhookConfigSchema`, `SettingConfigSchema`.
- `onDelete` enum khớp DB: `'restrict' | 'cascade' | 'set null' | 'no action'` (`cms.ts:168`).
- `type` field: tái dùng enum field types từ schema-service nếu đã export; nếu chưa, định nghĩa union string khớp các type hiện hành.
- Đặt ở `packages/shared` để CMS (validate) + Studio (tương lai: UI diff viewer) + SDK dùng chung — đúng quy ước của `site-config.ts`, `extension-manifest.ts`.

## 6. Round-trip & pure serialize (Req 6)

- `serializeConfig(state: ConfigState): ConfigManifest` là hàm thuần, nhận state đã load từ DB (POJO), không chạm DB → unit test round-trip dễ dàng.
- Property test (fast-check, như `policy-codec.test.ts` của setup wizard): `forAll(validConfigState, s => parse(serialize(s)) deepEqual normalize(s))`.
- Round-trip e2e (Req 6.1): export site → import `dryRun replace-all` → mọi resource `unchanged`. Integration test với DB thật trong CI.

## 7. Risk mapping (Req 3.7)

Tái dùng risk của `schema-service.diffSchema`:
- Xoá collection có items / xoá field có dữ liệu → `high`.
- Đổi `field.type` → `high`.
- Đổi `relation.onDelete` từ `set null`/`no action` sang `cascade` → `high` (mở rộng phạm vi xoá).
- Thêm field nullable, đổi label/interface/options non-breaking → `low`.
- Còn lại → `medium`.

## 8. Config CLI (Req 5)

Mở rộng `apps/cms/scripts/config-cli.ts` theo khuôn `access-cli.ts`:
```
lumibase config export [--scope all|schema|settings|webhooks] [--out file]
lumibase config diff <file>            # exit 0 = no change, 1 = changes (CI gate)
lumibase config apply <file> [--mode merge|replace-managed|replace-all]
                              [--allow-destructive] [--dry-run]
```
- CLI khởi tạo DB client từ cùng env như các CLI khác (qua `apps/cms/scripts/cli.ts` dispatcher đã route `config`).
- `diff`/`apply` gọi trực tiếp `ConfigImportService` (in-process) để không cần CMS chạy; in human-readable table.
- Không in secret (Req 5.7).

## 9. Audit & Security (Req 7)

- Endpoint gắn sau middleware auth; yêu cầu `adminAccess=true` qua permission service (như các route admin khác trong `apps/cms/src/routes/admin*.ts`).
- Audit events `config_applied`, `config_apply_failed` ghi qua audit logger sẵn có (cùng cơ chế `security-audit.ts` / audit module), metadata chỉ chứa counts + mode + scope, không nội dung resource.

## 10. Setup Impact (Req 8)

Rà soát 6 câu hỏi → dự kiến `n/a`:
1. Seed? Không — đọc/ghi config sẵn có.
2. Settings key bắt buộc? Không.
3. Policy/grant DB? Không — gated bằng `adminAccess` sẵn có.
4. Bước UI wizard? Không.
5. Capability flag? Không.
6. Backfill? Không — endpoint mới chồng lên config hiện hữu; export hoạt động ngay với mọi instance.

Ghi `n/a` vào Registry với ngày rà soát.

## 11. Open questions

1. **Managed_Marker bằng cột DB hay `managedScopes` trong manifest?** Quyết định v1: dùng `managedScopes` (không thêm cột) để zero-migration. Nếu cần xoá field-level chính xác hơn, v2 thêm cột `managed boolean` vào collections/fields (idempotent migration). — *Chốt: v1 dùng managedScopes.*
2. **`updateSchema` có nhận transaction injection không?** Cần đọc chữ ký thực của `SchemaService.updateSchema` lúc implement. Nếu nó tự mở tx nội bộ, hoặc (a) refactor cho nhận `tx` optional, hoặc (b) import service gọi các bước nhỏ hơn. — *Quyết định lúc implement, ưu tiên (a) nếu ít xâm lấn.*
3. **Webhooks có thuộc scope `schema` hay riêng?** Quyết định: scope riêng `webhooks`, gộp trong `all`. Vì webhook URL có thể chứa token trong query → cảnh báo trong docs là không commit manifest chứa webhook secret; v1 vẫn export URL như đã lưu (operator chịu trách nhiệm), v2 cân nhắc mask.
