# Implementation Plan — RLS Request Scope (B130)

## Overview

Post-v1 (1.x minor). Phase 0 đã xong ở `54213661`/`a83d4e86`; Phase 1–4 xong trong PR #552 (owner chọn phương án B, một PR thay vì một PR mỗi phase).

## Implementation status

Hoàn tất sau cờ `LUMIBASE_DB_RLS` (mặc định `off`), 2026-10-17. Chưa làm: biến thể golden-path E2E chạy `enforce` trong CI và đo trên Hyperdrive staging (ghi ở `v1-scope-classification.md`). Mọi task qua DoD (`.kiro/steering/definition-of-done.md`), đặc biệt §2b (multi-tenant, parity provider và consumer giữa `serve.ts` và `cloudflare.ts`) và §2c.

Tiền đề: #550 (B125, cặp policy) đã vào `main`. Lấy số backlog / setup-impact / migration mới **sau** khi rebase, bằng `pnpm registry:check`.

## Tasks

### Phase 0 — Docs + backlog (xong)

- [x] 0. Docs EN/VI, `CHANGELOG` (Known limitation), comment trong code nói đúng hành vi; dòng backlog B130; spec này; xếp spec vào post-v1.

### Phase 1 — Scoped client + cờ (chưa đổi hành vi mặc định)

- [x] 1.1 Tạo `packages/runtime/src/scoped-sql.ts`: `createSiteScopedSql(base: postgres.Sql, siteId: string)` theo design §3c (`unsafe` thenable có `.values()`, `begin` set scope trước cb, giữ `.count`/`.columns`, forward thuộc tính khác qua `Proxy`). Unit test bằng fake `begin`/`unsafe` + property test siteId luôn là tham số (Req 1.1, 1.2, 2.1).
      Status: Done: `scoped-sql.ts` + `__tests__/scoped-sql.test.ts` (15) + `apps/cms/src/__tests__/scoped-sql.property.test.ts`.
      Verify: `pnpm -F @lumibase/runtime test`.
- [x] 1.2 Export an toàn cho Worker trong `packages/runtime/src/index.ts` (không kéo dependency chỉ có ở Node) (Req 4.2).
      Status: Done: export ở barrel; `verify:worker-bundle` OK.
      Verify: `pnpm verify:worker-bundle`.
- [x] 1.3 Parse cờ `LUMIBASE_DB_RLS` (`off` | `enforce`, mặc định `off`) trong `apps/cms/src/config/` + `env.ts` (Req 5.1).
      Status: Done: `config/db-rls.ts` + test.
      Verify: `pnpm -F @lumibase/cms test src/config`.
- [x] 1.4 `withDb`: khi `enforce` và có `siteId` thì `drizzle(createSiteScopedSql(conn, siteId))`. `withRls`: bỏ câu `set_config` autocommit; khi `enforce` mà db chưa scoped thì `503 RLS_UNAVAILABLE` (giữ fail-closed). Cập nhật `middleware/__tests__/rls.test.ts` (Req 1.1, 5.1).
      Status: Done: `middleware/db.ts`, `middleware/rls.ts`, `db.test.ts`, `rls.test.ts`.
      Verify: `pnpm -F @lumibase/cms test src/middleware`, `pnpm typecheck`, `pnpm -F @lumibase/cms build`.

### Phase 2 — System connection

- [x] 2.1 `DatabaseProvider.getSystemConnection()` ở cả hai adapter (`packages/runtime/src/adapters/{docker,cloudflare}/database.ts`); thiếu cấu hình thì trả connection chính (Req 3.1, 4.1).
      Status: Done: cả hai adapter + `docker-database.test.ts`, `cloudflare-database.test.ts`.
      Verify: `pnpm -F @lumibase/runtime test`.
- [x] 2.2 `DATABASE_SYSTEM_URL` (Docker) + binding `HYPERDRIVE_SYSTEM` (mọi profile `wrangler.toml`, tuỳ chọn); kiểm tra lúc khởi động theo design §4 (Req 5.2, 5.3).
      Status: Done: `config/db-rls-startup.ts` + test; `wrangler.toml` chỉ có khối comment (D9).
      Verify: `pnpm -F @lumibase/cms build`, `pnpm -F @lumibase/cms build:node`, `pnpm verify:worker-startup`.
- [x] 2.3 `serve.ts`: `rotatorDb` dùng system connection. `cloudflare.ts` / `cloudflare-queue.ts` / `cloudflare-flow-queue.ts`: db của `scheduled`/`queue` dùng system connection (Req 3.1).
      Status: Done: `serve.ts`, `cloudflare.ts`, `cloudflare-agent-queue.ts` qua `cloudflare-system-db.ts`. `cloudflare-queue.ts` / `cloudflare-flow-queue.ts` thuộc #551, chưa có trên base: tripwire T3 đỏ khi hai nhánh gặp nhau cho tới khi `cloudflare-queue-common.ts` dùng `createCloudflareSystemDb`.
      Verify: `pnpm typecheck`, `pnpm test`, `pnpm verify:worker-bundle`.
- [x] 2.4 Router hệ thống ở design §4 (`setup`, `/health`, `adminPathGuard`, `scim/v2`, git OAuth callback) và `auditApiKeyUseDenied` dùng system db (Req 3.2, 3.3).
      Status: Done.
      Verify: `pnpm -F @lumibase/cms test`.

### Phase 3 — Router tự scope + bỏ anti-pattern

- [x] 3.1 `deliver`, `shares` public, `pageviews` hit, `email/unsubscribe`, `deployments/webhook`, git webhook + preview dùng `scopedDbFor(c, siteId)`; xoá `set_config` độc lập ở `webhook/handler.ts` và `preview.ts` (Req 3.4).
      Status: Done (deployments/webhook không cần đổi: `withTenant` + `withDb`).
      Verify: `pnpm -F @lumibase/cms test`.
- [x] 3.2 Scope nằm trong `withDb` (đã đứng sau `withTenant` ở `index.ts`), nên các middleware đọc bảng có RLS trước `withRls` (F1) cũng có scope (Req 1.1).
      Status: Done.
      Verify: test DB integration ở 4.1.

### Phase 4 — Test, tripwire, docs

- [x] 4.1 Test DB integration `apps/cms/src/__tests__/rls-request-scope.db.integration.test.ts` theo design §6 (role `app` NOSUPERUSER NOBYPASSRLS + `sys` BYPASSRLS, hai site, chuỗi middleware thật, worker sweep, ca "before"). Import `helpers/db-harness` (Req 6.1).
      Status: Done: 13 ca; kiểm âm ghi trong mô tả PR.
      Verify: chạy với `DATABASE_URL` trỏ tới postgres riêng: `pnpm -F @lumibase/cms test src/__tests__/rls-request-scope.db.integration.test.ts`; kiểm âm bằng cách gỡ wrapper khỏi `withDb` thì test đỏ.
- [x] 4.2 Tripwire T1–T3 (design §7) (Req 6.2).
      Status: Done: `rls-scope.wiring.test.ts`; kiểm âm từng tripwire.
      Verify: `pnpm -F @lumibase/cms test src/__tests__/rls-scope.wiring.test.ts`; kiểm âm từng tripwire.
- [x] 4.3 Đo before/after + chi phí `off` vs `enforce` theo design §8; ghi vào mô tả PR (Req 6.3).
      Status: Done: xem design.md "Kết quả đo".
- [x] 4.4 Thêm dòng Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`): setup wizard / deployment checklist cần hỏi role app + system connection khi bật `enforce`.
      Status: Done: dòng #177.
      Verify: `pnpm registry:check`.
- [x] 4.5 Docs EN/VI: `deployment/environment-variables.md` (biến mới), `DEPLOYMENT-CHECKLIST.md` (thủ tục hai role + cờ, gỡ caveat Phase 0), `operations/upgrades.md`, `security/anti-abuse.md`; `CHANGELOG` (Security + upgrade note); stamp từng cặp.
      Status: Done: 18 cặp + cặp mới `features/rls-request-scope.md`, stamp.
      Verify: `pnpm docs:i18n:verify`, `pnpm docs:i18n:detect`, `pnpm check:all`.
- [x] 4.6 DoD §2b: thêm dòng "db của request phải scoped; mọi `drizzle(`/`getConnection()` mới phải được phân loại" kèm blockquote nêu B130.
      Status: Done.
- [x] 4.7 Cập nhật B130 trong `.kiro/steering/out-of-scope-backlog.md` sang `fixed`.
      Status: Done.
