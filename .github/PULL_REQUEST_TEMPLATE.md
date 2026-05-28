## Summary

<!-- Mô tả ngắn gọn thay đổi trong PR này. -->

## Loại thay đổi

- [ ] `feat` — Tính năng mới
- [ ] `fix` — Sửa bug
- [ ] `refactor` — Cải thiện code, không thay đổi hành vi
- [ ] `chore` — Công việc bảo trì (deps, CI, config)
- [ ] `docs` — Cập nhật tài liệu
- [ ] `perf` — Cải thiện hiệu năng
- [ ] `test` — Thêm / sửa test
- [ ] `security` — Vá lỗ hổng bảo mật

## Phase / Feature liên quan

<!-- Ghi rõ phase / task trong roadmap (ví dụ: POST-GA1 – AI Copilot). -->

---

## ✅ Definition of Done (DoD)

> **Tất cả mục bên dưới phải được tích ✅ trước khi merge.**

### Code Quality

- [ ] Không có TypeScript error (`pnpm typecheck` pass ✅)
- [ ] Tất cả tests pass (`pnpm test` — 0 failures)
- [ ] Không có lint error (`pnpm lint` / ESLint clean)
- [ ] Self-review: đọc lại diff line-by-line trước khi request review

### Architecture & Docs

- [ ] Cập nhật `architecture.md` nếu có thay đổi cấu trúc hệ thống
- [ ] Cập nhật `apps/cms/openapi.yaml` cho **mọi** endpoint mới / thay đổi
- [ ] Cập nhật `packages/sdk` types tương ứng với API changes
- [ ] Cập nhật docs trong `docs/en/features/` nếu thay đổi ảnh hưởng người dùng

### Testing

- [ ] Viết unit test cho logic mới
- [ ] Viết integration test cho các endpoint / service
- [ ] Với logic phức tạp / boundary conditions: có property-based test (fast-check)
- [ ] Test thủ công trên Docker runtime (`docker compose up`)

### Runtime Compatibility

- [ ] Route / service hoạt động trên **Cloudflare Workers** runtime
- [ ] Route / service hoạt động trên **Node.js / Docker** runtime
- [ ] Nếu dùng API chỉ có trên một runtime: đã gate bằng feature flag và ghi chú trong `docs/en/features/runtime-abstraction.md`

### Security

- [ ] Không có secret / credential hardcoded trong code
- [ ] Input validation: tất cả payload đầu vào được validate (Zod / schema)
- [ ] Multi-tenant isolation: query có `WHERE siteId = ?` (không leak data cross-tenant)
- [ ] Với SCIM / OAuth: token không được log hoặc lưu plaintext

### Database / Migrations

- [ ] Migration file có trong `packages/database/drizzle/` nếu có schema change
- [ ] Migration có thể chạy lại nhiều lần (idempotent) hoặc có guard `IF NOT EXISTS`
- [ ] Rollback plan được ghi chú trong PR description nếu migration phức tạp

### Conventional Commits

- [ ] Commit messages theo format `type(scope): description`
  - `feat(cms): add SCIM token rotation`
  - `fix(studio): correct flow editor drag offset`
  - `docs: update AI copilot feature guide`

---

## Screenshots / Recordings

<!-- Gắn ảnh chụp màn hình hoặc video nếu có UI change. -->

## Rollback Plan

<!-- Mô tả cách rollback nếu PR gây ra sự cố production. -->

## Notes for Reviewers

<!-- Ghi chú thêm cho người review (context, trade-offs, TODO sau merge, ...). -->
