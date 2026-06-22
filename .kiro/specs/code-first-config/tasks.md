# Implementation Plan

## Overview

Kế hoạch triển khai **Code-First Configuration** theo 4 phase. Phase A đặt nền (Zod manifest schema + pure serialize + round-trip test). Phase B xây ConfigExportService + endpoint export. Phase C xây ConfigImportService (validate → diff → apply transactional, tái dùng `SchemaService`). Phase D hoàn thiện CLI + docs + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng (theo yêu cầu goal).

## Tasks

### Phase A — Manifest schema & pure serialize foundation

- [x] 1. Zod manifest schema
  - [x] 1.1 Tạo `packages/shared/src/schemas/config-manifest.ts` export `ConfigManifestSchema`, `ConfigManifest` type, sub-schema `CollectionConfigSchema`/`FieldConfigSchema`/`RelationConfigSchema`/`WebhookConfigSchema`/`SettingConfigSchema`; `onDelete` enum khớp `cms.ts:168`; thêm `stableKey` helpers + `parseConfigManifest()` (Req 2.1; design §5)
  - [x] 1.2 Export từ `packages/shared/src/schemas/index.ts`; `canonicalize()` helper sống trong `config-serialize.ts` (Req 6.5; design §3)
  - [x] 1.3 Tạo `apps/cms/src/services/config-serialize.ts` với pure fn `serializeConfig(state): ConfigManifest` (drop id/siteId/timestamps, sort arrays, canonicalize) + `canonicalize()` (Req 1.2-1.5, 6.2; design §6)
  - [x] 1.4 Unit test `config-serialize.test.ts`: property test fast-check round-trip, deterministic + order-independent output, no id/siteId leak, scope filter (6 tests) (Req 1.5, 6.1; design §6)

### Phase B — Export service & endpoint

- [x] 2. ConfigExportService
  - [x] 2.1 Tạo `apps/cms/src/services/config-export-service.ts` class `ConfigExportService`: load collections/fields/relations/webhooks/settings scoped theo `siteId`, join field collectionId→name, map qua `serializeConfig` (Req 1.1, 1.6, 1.7; design §4.1)
  - [x] 2.2 Tạo route `apps/cms/src/routes/config.ts` `GET /config/export?scope=` trả `{ data: manifest }`, `requireSiteAdmin()` guard; mount `/api/v1/config` trong `index.ts` (Req 1.1, 7.3; design §4.1, §9)
  - [x] 2.3 Route-wiring test `config-export.test.ts` (fake DB): manifest shape + version, scope filter, no id/siteId leak, 403 non-admin (3 tests). Round-trip với DB thật ở task 4.7 (Req 1.2, 1.3, 1.5; design §4.1)

### Phase C — Import service (validate → diff → apply)

- [x] 3. Validate + diff
  - [x] 3.1 Tạo `apps/cms/src/services/config-import-service.ts`: parse Zod, check version, dangling-reference + duplicate-key check trước transaction (Req 2.1-2.6; design §4.2)
  - [x] 3.2 Diff phase trong `config-diff.ts` (pure): **deviation** — so sánh canonical JSON theo Stable_Key (đối xứng `access-import.buildDiff`) thay vì `SchemaService.diffSchema()`; giữ round-trip property by construction. Risk: field type change / widening onDelete→cascade → high (Req 3.1-3.7; design §4.3, §7)
  - [x] 3.3 Endpoint `POST /config/import?dryRun=true` trả `{ data: { valid, errors, diff } }` không ghi DB (Req 3.1; design §4.3)
  - [x] 3.4 Unit test `config-diff.test.ts`: validate (dangling/duplicate), create/update/unchanged/delete theo từng mode, risk high (12 tests) (Req 3.2-3.7; design §4.3)

- [x] 4. Transactional apply
  - [x] 4.1 Xác nhận `SchemaService.updateSchema` đã duck-type `db.transaction` (`schema-service.ts:774`) — import mở một outer `db.transaction` và dựng SchemaService bound vào tx (open question §11.2 RESOLVED) (Req 4.1, 4.2; design §4.4)
  - [x] 4.2 Apply phase: transaction, thứ tự collections→fields/relations(per-collection updateSchema)→webhooks→settings; merge union incoming với existing để không xoá (Req 4.1-4.4, 4.6; design §4.4)
  - [x] 4.3 Mode handling: `merge`/`replace-managed` (managedScopes)/`replace-all` (xoá collection vắng + relations theo thứ tự FK-safe) (Req 4.5, 4.6, 3.6; design §4.5)
  - [x] 4.4 Destructive guard: chặn risk `high` trừ khi `allowDestructive`; transaction rollback nếu operation fail (Req 4.3, 4.7; design §4.4)
  - [x] 4.5 Post-commit: cache invalidation do `updateSchema` tự lo per-call; audit `config_applied` / `config_apply_failed` ở route layer (Req 4.8, 7.1, 7.2; design §4.4, §9)
  - [x] 4.6 Endpoint `POST /config/import?mode=&allowDestructive=` apply thật (Req 4.1; design §4.4)
  - [x] 4.7 Tests: `config-import-service.test.ts` (fast, fake DB — validate/diff/destructive-guard, 5 tests) + `config-import.db.integration.test.ts` (Postgres thật — round-trip clean, merge tạo-không-xoá, replace-all xoá thừa, 3 tests). **Đã chạy thật trên Postgres local: 3/3 pass** (Req 4.3-4.7, 6.1; design §6)

### Phase D — CLI, docs, DoD

- [x] 5. Config CLI
  - [x] 5.1 Rework `apps/cms/scripts/config-cli.ts` lên các endpoint manifest: `export --scope --out`, `diff <file>` (exit 0/1/2), `apply <file> --mode --allow-destructive --dry-run` (Req 5.1-5.6; design §8)
  - [x] 5.2 `diff` exit code 1 khi có thay đổi (CI gate), 2 khi manifest invalid; không in secret (Req 5.2, 5.7; design §8)
  - [x] 5.3 **Deviation**: smoke-test bằng `tsx` (help + arg parsing verified) thay vì vitest; HTTP plumbing dựa trên endpoint đã được route+DB-integration test phủ. Live-CLI e2e cần CMS server đang chạy (Req 5.2, 5.4; design §8)

- [x] 6. Docs & DoD
  - [x] 6.1 Cập nhật `docs/en/api/hono-api-spec.md` §2: thêm subsection "Code-First Configuration (Config Manifest)" (endpoints, modes, response, error codes) (DoD §4)
  - [x] 6.2 Thêm `docs/en/contributing/code-first-config.md` mô tả manifest + CLI + CI/CD workflow + round-trip guarantee + limitations (DoD §4)
  - [x] 6.3 CHANGELOG `[Unreleased] → Added` entry. Không bump README Release policy (không cắt version mới, không migration) — giữ di sản 0.5.0 narrative (DoD §4)
  - [x] 6.4 **Setup Impact**: thêm dòng #21 `n/a` vào `setup-impact.md` (rà soát 2026-06-22, 6 câu hỏi) (Req 8; design §10; DoD §2)
  - [ ] 6.5 `pnpm typecheck` recursive + `pnpm test` (cms) pass trước khi mở PR (DoD §1, §3)
