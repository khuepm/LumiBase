# Implementation Plan

## Overview

Kế hoạch triển khai **Code-First Configuration** theo 4 phase. Phase A đặt nền (Zod manifest schema + pure serialize + round-trip test). Phase B xây ConfigExportService + endpoint export. Phase C xây ConfigImportService (validate → diff → apply transactional, tái dùng `SchemaService`). Phase D hoàn thiện CLI + docs + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng (theo yêu cầu goal).

## Tasks

### Phase A — Manifest schema & pure serialize foundation

- [ ] 1. Zod manifest schema
  - [ ] 1.1 Tạo `packages/shared/src/schemas/config-manifest.ts` export `ConfigManifestSchema`, `ConfigManifest` type, sub-schema `CollectionConfigSchema`/`FieldConfigSchema`/`RelationConfigSchema`/`WebhookConfigSchema`/`SettingConfigSchema`; `onDelete` enum khớp `cms.ts:168` (Req 2.1; design §5)
  - [ ] 1.2 Export từ `packages/shared/src/schemas/index.ts`; thêm `canonicalize()` helper (key-sorted JSON) dùng chung nếu chưa có (Req 6.5; design §3)
  - [ ] 1.3 Tạo `apps/cms/src/services/config-serialize.ts` với pure fn `serializeConfig(state): ConfigManifest` (drop id/siteId/timestamps, sort arrays, canonicalize) (Req 1.2-1.5, 6.2; design §6)
  - [ ] 1.4 Unit test `config-serialize.test.ts`: property test fast-check round-trip `parse(serialize(s)) deepEqual normalize(s)`; deterministic output (serialize 2× = byte-identical) (Req 1.5, 6.1; design §6)

### Phase B — Export service & endpoint

- [ ] 2. ConfigExportService
  - [ ] 2.1 Tạo `apps/cms/src/services/config-export-service.ts` class `ConfigExportService` đối xứng `access-export.ts`: load collections/fields/relations/webhooks/settings scoped theo `siteId`, map qua `serializeConfig` (Req 1.1, 1.6, 1.7; design §4.1)
  - [ ] 2.2 Tạo route `apps/cms/src/routes/config.ts` `GET /config/export?scope=` trả `{ data: manifest }`, gắn admin-only guard; mount vào app router (Req 1.1, 7.3; design §4.1, §9)
  - [ ] 2.3 Integration test export: tạo collection/field/relation/setting → export → assert manifest shape, không có id/siteId/secret, sorted deterministic (Req 1.2, 1.3, 1.5; design §4.1)

### Phase C — Import service (validate → diff → apply)

- [ ] 3. Validate + diff
  - [ ] 3.1 Tạo `apps/cms/src/services/config-import-service.ts` skeleton: parse Zod, check version, dangling-reference + duplicate-key check trước transaction (Req 2.1-2.6; design §4.2)
  - [ ] 3.2 Triển khai diff phase: reuse `SchemaService.diffSchema()` cho collections/fields/relations; diff canonical JSON cho webhooks/settings; map về `Config_Diff` status `create|update|unchanged|delete` + risk (Req 3.1-3.7; design §4.3, §7)
  - [ ] 3.3 Endpoint `POST /config/import?dryRun=true` trả `{ data: Config_Diff }` không ghi DB (Req 3.1; design §4.3)
  - [ ] 3.4 Unit test diff: create/update/unchanged/delete theo từng mode; risk high cho destructive (Req 3.2-3.7; design §4.3)

- [ ] 4. Transactional apply
  - [ ] 4.1 Đọc chữ ký thực `SchemaService.updateSchema`; nếu cần, cho nhận `tx` optional để import chạy trong một transaction (open question §11.2) (Req 4.1, 4.2; design §4.4)
  - [ ] 4.2 Triển khai apply phase: transaction, thứ tự collections→fields→relations→webhooks→settings, delegate schema cho `updateSchema`, upsert webhooks/settings theo Stable_Key (Req 4.1-4.4; design §4.4)
  - [ ] 4.3 Mode handling: `merge`/`replace-managed` (managedScopes)/`replace-all` (xoá ngược thứ tự phụ thuộc) (Req 4.5, 4.6, 3.6; design §4.5)
  - [ ] 4.4 Destructive guard: chặn risk `high` trừ khi `?allowDestructive=true`; rollback + lỗi nếu operation fail (Req 4.3, 4.7; design §4.4)
  - [ ] 4.5 Post-commit: invalidate cache `schema:<siteId>:*`, audit `config_applied` / `config_apply_failed` (Req 4.8, 7.1, 7.2; design §4.4, §9)
  - [ ] 4.6 Endpoint `POST /config/import?mode=&allowDestructive=` apply thật (Req 4.1; design §4.4)
  - [ ] 4.7 Integration test apply: merge tạo mới; replace-all xoá thừa; destructive bị chặn; rollback khi lỗi; **round-trip e2e** export→import(dryRun,replace-all)=mọi resource unchanged (Req 4.3-4.7, 6.1; design §6)

### Phase D — CLI, docs, DoD

- [ ] 5. Config CLI
  - [ ] 5.1 Hoàn thiện `apps/cms/scripts/config-cli.ts` theo khuôn `access-cli.ts`: `export --scope --out`, `diff <file>` (exit 0/1), `apply <file> --mode --allow-destructive --dry-run` (Req 5.1-5.6; design §8)
  - [ ] 5.2 Đảm bảo `diff` exit code 1 khi có thay đổi (CI gate); không in secret (Req 5.2, 5.7; design §8)
  - [ ] 5.3 Test CLI smoke: export ra file, diff trả đúng exit code, apply --dry-run no-op (Req 5.2, 5.4; design §8)

- [ ] 6. Docs & DoD
  - [ ] 6.1 Cập nhật `docs/en/api/hono-api-spec.md`: thêm `/api/v1/config/export`, `/api/v1/config/import` (params, response, error codes) (DoD §4)
  - [ ] 6.2 Thêm `docs/en/contributing/` hoặc `docs/en/` trang "Code-First Configuration" mô tả workflow CI/CD (export→commit→diff PR gate→apply) (DoD §4)
  - [ ] 6.3 CHANGELOG entry + README Release policy bump nếu version tăng (DoD §4) — giữ di sản 0.5.0 narrative
  - [ ] 6.4 **Setup Impact**: thêm dòng `n/a` vào `.kiro/specs/admin-setup-wizard/setup-impact.md` với ngày rà soát + lý do (Req 8; design §10; DoD §2)
  - [ ] 6.5 `pnpm typecheck` recursive + `pnpm test` pass; tick task done trong file này (DoD §1, §3)
