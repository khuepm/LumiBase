# Implementation Plan — RLS Request Scope (B130)

## Overview

Post-v1 (1.x minor). Phase 0 (docs + backlog + comment, không đổi logic) đã xong trong PR của B130. Các phase dưới đây chưa bắt đầu; mỗi phase một PR. Mọi task qua DoD (`.kiro/steering/definition-of-done.md`), đặc biệt §2b (multi-tenant, parity provider và consumer giữa `serve.ts` và `cloudflare.ts`) và §2c.

Tiền đề: #550 (B125, cặp policy) đã vào `main`. Lấy số backlog / setup-impact / migration mới **sau** khi rebase, bằng `pnpm registry:check`.

## Tasks

### Phase 0 — Docs + backlog (xong)

- [x] 0. Docs EN/VI, `CHANGELOG` (Known limitation), comment trong code nói đúng hành vi; dòng backlog B130; spec này; xếp spec vào post-v1.

### Phase 1 — Scoped client + cờ (chưa đổi hành vi mặc định)

- [ ] 1.1 Tạo `packages/runtime/src/scoped-sql.ts`: `createSiteScopedSql(base: postgres.Sql, siteId: string)` theo design §3c (`unsafe` thenable có `.values()`, `begin` set scope trước cb, giữ `.count`/`.columns`, forward thuộc tính khác qua `Proxy`). Unit test bằng fake `begin`/`unsafe` + property test siteId luôn là tham số (Req 1.1, 1.2, 2.1).
      Verify: `pnpm -F @lumibase/runtime test`.
- [ ] 1.2 Export an toàn cho Worker trong `packages/runtime/src/index.ts` (không kéo dependency chỉ có ở Node) (Req 4.2).
      Verify: `pnpm verify:worker-bundle`.
- [ ] 1.3 Parse cờ `LUMIBASE_DB_RLS` (`off` | `enforce`, mặc định `off`) trong `apps/cms/src/config/` + `env.ts` (Req 5.1).
      Verify: `pnpm -F @lumibase/cms test src/config`.
- [ ] 1.4 `withDb`: khi `enforce` và có `siteId` thì `drizzle(createSiteScopedSql(conn, siteId))`. `withRls`: bỏ câu `set_config` autocommit; khi `enforce` mà db chưa scoped thì `503 RLS_UNAVAILABLE` (giữ fail-closed). Cập nhật `middleware/__tests__/rls.test.ts` (Req 1.1, 5.1).
      Verify: `pnpm -F @lumibase/cms test src/middleware`, `pnpm typecheck`, `pnpm -F @lumibase/cms build`.

### Phase 2 — System connection

- [ ] 2.1 `DatabaseProvider.getSystemConnection()` ở cả hai adapter (`packages/runtime/src/adapters/{docker,cloudflare}/database.ts`); thiếu cấu hình thì trả connection chính (Req 3.1, 4.1).
      Verify: `pnpm -F @lumibase/runtime test`.
- [ ] 2.2 `DATABASE_SYSTEM_URL` (Docker) + binding `HYPERDRIVE_SYSTEM` (mọi profile `wrangler.toml`, tuỳ chọn); kiểm tra lúc khởi động theo design §4 (Req 5.2, 5.3).
      Verify: `pnpm -F @lumibase/cms build`, `pnpm -F @lumibase/cms build:node`, `pnpm verify:worker-startup`.
- [ ] 2.3 `serve.ts`: `rotatorDb` dùng system connection. `cloudflare.ts` / `cloudflare-queue.ts` / `cloudflare-flow-queue.ts`: db của `scheduled`/`queue` dùng system connection (Req 3.1).
      Verify: `pnpm typecheck`, `pnpm test`, `pnpm verify:worker-bundle`.
- [ ] 2.4 Router hệ thống ở design §4 (`setup`, `/health`, `adminPathGuard`, `scim/v2`, git OAuth callback) và `auditApiKeyUseDenied` dùng system db (Req 3.2, 3.3).
      Verify: `pnpm -F @lumibase/cms test`.

### Phase 3 — Router tự scope + bỏ anti-pattern

- [ ] 3.1 `deliver`, `shares` public, `pageviews` hit, `email/unsubscribe`, `deployments/webhook`, git webhook + preview dùng `scopedDbFor(c, siteId)`; xoá `set_config` độc lập ở `webhook/handler.ts` và `preview.ts` (Req 3.4).
      Verify: `pnpm -F @lumibase/cms test`.
- [ ] 3.2 Scope nằm trong `withDb` (đã đứng sau `withTenant` ở `index.ts`), nên các middleware đọc bảng có RLS trước `withRls` (F1) cũng có scope (Req 1.1).
      Verify: test DB integration ở 4.1.

### Phase 4 — Test, tripwire, docs

- [ ] 4.1 Test DB integration `apps/cms/src/__tests__/rls-request-scope.db.integration.test.ts` theo design §6 (role `app` NOSUPERUSER NOBYPASSRLS + `sys` BYPASSRLS, hai site, chuỗi middleware thật, worker sweep, ca "before"). Import `helpers/db-harness` (Req 6.1).
      Verify: chạy với `DATABASE_URL` trỏ tới postgres riêng: `pnpm -F @lumibase/cms test src/__tests__/rls-request-scope.db.integration.test.ts`; kiểm âm bằng cách gỡ wrapper khỏi `withDb` thì test đỏ.
- [ ] 4.2 Tripwire T1–T3 (design §7) (Req 6.2).
      Verify: `pnpm -F @lumibase/cms test src/__tests__/rls-scope.wiring.test.ts`; kiểm âm từng tripwire.
- [ ] 4.3 Đo before/after + chi phí `off` vs `enforce` theo design §8; ghi vào mô tả PR (Req 6.3).
- [ ] 4.4 Thêm dòng Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`): setup wizard / deployment checklist cần hỏi role app + system connection khi bật `enforce`.
      Verify: `pnpm registry:check`.
- [ ] 4.5 Docs EN/VI: `deployment/environment-variables.md` (biến mới), `DEPLOYMENT-CHECKLIST.md` (thủ tục hai role + cờ, gỡ caveat Phase 0), `operations/upgrades.md`, `security/anti-abuse.md`; `CHANGELOG` (Security + upgrade note); stamp từng cặp.
      Verify: `pnpm docs:i18n:verify`, `pnpm docs:i18n:detect`, `pnpm check:all`.
- [ ] 4.6 DoD §2b: thêm dòng "db của request phải scoped; mọi `drizzle(`/`getConnection()` mới phải được phân loại" kèm blockquote nêu B130.
- [ ] 4.7 Cập nhật B130 trong `.kiro/steering/out-of-scope-backlog.md` sang `fixed`.
