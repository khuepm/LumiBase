## Summary

Triển khai hardening lớn cho Access Control: API key security, access manifest import/export, extension access enforcement, baseline access seed, và share links theo role permission.

Các thay đổi chính:

- API key bearer auth được enforce fail-closed: API key không truy cập Studio, revoked/expired key trả 401, quyền read bị giới hạn theo policy fields/rows.
- Access manifest v1 hỗ trợ export/import roles, policies, permission rows, bindings và API key metadata bằng stable refs, không chứa secrets; có dry-run, conflict report và CLI.
- Studio có Access Import/Export page, API Keys page đã có create/rotate/revoke/attach roles-policies/preview conflicts, và system permission targets được group/hide đúng ngữ cảnh.
- Extension targets được seed/enforce cho install/configure/enable/grant capability/execute, bao gồm data access hardening trong extension sandbox.
- Share links mới dùng bảng `shares`, token hash, password hash, validity window, max uses, revoke; public read payload luôn đi qua quyền `read` của share role.
- Roadmap EN/VI đã tick toàn bộ checklist liên quan access/API key/extensions/share.

## Loại thay đổi

- [x] `feat` — Tính năng mới
- [ ] `fix` — Sửa bug
- [ ] `refactor` — Cải thiện code, không thay đổi hành vi
- [ ] `chore` — Công việc bảo trì (deps, CI, config)
- [x] `docs` — Cập nhật tài liệu
- [ ] `perf` — Cải thiện hiệu năng
- [x] `test` — Thêm / sửa test
- [x] `security` — Vá lỗ hổng bảo mật

## Phase / Feature liên quan

Access Control roadmap: Role / Policy / Permission hardening, API keys theo role/policy, access manifest import/export, extension permission targets, và share links.

---

## ✅ Definition of Done (DoD)

> **Tất cả mục bên dưới phải được tích ✅ trước khi merge.**

### Code Quality

- [x] Không có TypeScript error (`pnpm typecheck` pass ✅) — root `pnpm typecheck` pass, 12/12 tasks successful.
- [x] Tất cả tests pass (`pnpm test` — 0 failures) — pre-commit đã chạy `turbo run test`, 6/6 tasks successful; CMS 92 files / 959 tests pass.
- [x] Không có lint error (`pnpm lint` / ESLint clean) — root `pnpm lint` pass, 6/6 tasks successful.
- [x] Self-review: đọc lại diff line-by-line trước khi request review

### Architecture & Docs

- [x] Cập nhật `architecture.md` nếu có thay đổi cấu trúc hệ thống — không có thay đổi architecture doc bắt buộc; thay đổi được track trong roadmap.
- [x] Cập nhật `apps/cms/openapi.yaml` cho **mọi** endpoint mới / thay đổi — thêm access import/export, API key management và share link endpoints; YAML parse OK.
- [x] Cập nhật `packages/sdk` types tương ứng với API changes — thêm access import/export, API key, share link types/helpers.
- [x] Cập nhật docs trong `docs/en/features/` nếu thay đổi ảnh hưởng người dùng — cập nhật roadmap EN/VI; access manifest docs đã có trong `docs/en/features/access-manifest-v1.md`.

### Testing

- [x] Viết unit test cho logic mới — access import/export, access conflicts, share service, API key security, extension access.
- [x] Viết integration test cho các endpoint / service — access import route, extension access routes, API key middleware/security gates.
- [x] Với logic phức tạp / boundary conditions: có property-based test (fast-check) — access conflict classifier property tests, import idempotency/security invariants.
- [x] Test thủ công trên Docker runtime (`docker compose up`) — stack build/start OK, CMS lắng nghe `11989 -> 1989`, `/health` trả `200 OK` với `status: "healthy"` và tất cả services healthy.

### Runtime Compatibility

- [x] Route / service hoạt động trên **Cloudflare Workers** runtime — dùng Web Crypto/Hono/Zod/Drizzle patterns hiện có; không thêm Node-only API trong share/API-key path.
- [x] Route / service hoạt động trên **Node.js / Docker** runtime — covered by Vitest/Node runtime; Docker smoke xác nhận CMS boot và `/health` reachable.
- [x] Nếu dùng API chỉ có trên một runtime: đã gate bằng feature flag và ghi chú trong `docs/en/features/runtime-abstraction.md` — không thêm API runtime-specific cần feature flag.

### Security

- [x] Không có secret / credential hardcoded trong code — API key/share plaintext chỉ trả một lần; hashes không được expose qua SDK response.
- [x] Input validation: tất cả payload đầu vào được validate (Zod / schema) — API key/share/access import routes có schema validation.
- [x] Multi-tenant isolation: query có `WHERE siteId = ?` (không leak data cross-tenant) — access/API key/share/extension queries scope theo `siteId`.
- [x] Với SCIM / OAuth: token không được log hoặc lưu plaintext — API key/share tokens dùng SHA-256 hash; audit không log plaintext.

### Database / Migrations

- [x] Migration file có trong `packages/database/drizzle/` nếu có schema change — thêm `0013_extension_access_targets.sql` và `0014_shares.sql`.
- [x] Migration có thể chạy lại nhiều lần (idempotent) hoặc có guard `IF NOT EXISTS` — `0013` đã idempotent; `0014_shares.sql` dùng `CREATE TABLE/INDEX IF NOT EXISTS` và guard duplicate constraints.
- [x] Rollback plan được ghi chú trong PR description nếu migration phức tạp — xem mục Rollback Plan bên dưới.

### Conventional Commits

- [x] Commit messages theo format `type(scope): description`
  - `test(cms): cover api key security gates`
  - `feat(cms): export access manifest`
  - `feat(cms): dry-run access import`
  - `feat(cms): apply access imports`
  - `feat(access): add share link permissions`

---

## Screenshots / Recordings

Không đính kèm. UI thay đổi nằm ở Studio Access Import/Export, API Keys page, system permission grouping, và item detail Share dialog.

## Rollback Plan

- Revert PR để gỡ toàn bộ access import/export, API key hardening, extension target enforcement và share link routes/UI.
- Với database:
  - Drop bảng `shares` nếu rollback sau migration `0014_shares`.
  - Nếu rollback extension target migration `0013_extension_access_targets`, remove các permission/action rows seed tương ứng hoặc rollback DB snapshot theo migration tooling.
- Token/API key/share hashes không chứa plaintext nên không cần secret rotation khi rollback, trừ khi production đã phát hành token/link mới trong thời gian PR hoạt động.

## Notes for Reviewers

- Full `turbo run test` đã pass trong pre-commit hook khi tạo commit `0fd6c57`.
- Root `pnpm typecheck` pass, 12/12 tasks successful.
- Root `pnpm lint` pass, 6/6 tasks successful.
- Focused CMS suite pass: `share-service`, `api-key-security`, `access-conflicts`, `access-import`, `extension-access` — 7 files / 40 tests.
- OpenAPI đã sync cho access import/export, API keys và share links; `apps/cms/openapi.yaml` parse OK.
- Docker compose smoke: image build/start OK, CMS reachable at `http://127.0.0.1:11989/health` with `200 OK`; repeated checks returned `status: "healthy"` for database/cache/search/storage/queue.
