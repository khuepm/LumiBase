# Requirements Document — RLS Request Scope (B130)
> Status: implemented behind opt-in flag `LUMIBASE_DB_RLS` (owner option B, 2026-10-16; PR #552, 2026-10-17). Mặc định `off`; xem `tasks.md` và mục Implementation decisions trong `design.md`.

## Introduction

`packages/database/migrations/rls-policies.sql` (sau B125) cho mỗi bảng có scope một cặp policy `site_isolation` (RESTRICTIVE) + `site_isolation_permit` (PERMISSIVE) trên predicate `site_id = app_site_id()`. Các policy đúng, nhưng ứng dụng chưa đặt `app.site_id` lên đúng transaction chạy truy vấn:

- `withRls` (`apps/cms/src/middleware/rls.ts`) chạy `SELECT set_config('app.site_id', …, true)` như một câu autocommit riêng trên pool. Setting hết hiệu lực cùng câu đó; câu kế tiếp (có thể trên connection khác) đọc `''`.
- Chỉ `runSiteTransaction` (`apps/cms/src/services/rls-transaction.ts`) đặt scope đúng (`set_config` bên trong cùng `db.transaction`).
- Worker, cron và queue consumer dùng chung một db không có scope và quét xuyên site.

Hệ quả: operator áp file policy rồi cho ứng dụng kết nối bằng role NOSUPERUSER NOBYPASSRLS thì request path và background job thấy 0 dòng hoặc fail WITH CHECK. Hiện docs bảo operator giữ ứng dụng ở role có BYPASSRLS (Phase 0, B130).

Spec này là **post-v1** (xem `.kiro/steering/v1-scope-classification.md`). Nó thêm public surface mới (biến môi trường + Hyperdrive binding), dạng additive, nên chỉ ship ở một bản minor 1.x.

## Glossary

- **App_Role**: role Postgres mà ứng dụng dùng cho request path có scope. NOSUPERUSER NOBYPASSRLS khi bật enforce.
- **System_Role**: role có BYPASSRLS, dùng cho đường hệ thống (setup, health, worker/cron xuyên site).
- **System_Connection**: kết nối dùng System_Role. Docker: `DATABASE_SYSTEM_URL`. Cloudflare: binding `HYPERDRIVE_SYSTEM`.
- **Scoped_Client**: wrapper quanh client postgres.js, mở `BEGIN; set_config('app.site_id', $1, true); <query>; COMMIT` cho mỗi câu hoặc mỗi transaction.
- **RLS_Mode**: cờ `LUMIBASE_DB_RLS` = `off` (mặc định) | `enforce`.

## Requirements

### Requirement 1: Scope đúng cho mọi câu của request

**User story:** Là operator, tôi muốn bật RLS backstop với App_Role NOBYPASSRLS mà ứng dụng vẫn chạy, để một `.where(siteId)` bị thiếu không làm rò dữ liệu chéo tenant.

1. WHEN `LUMIBASE_DB_RLS=enforce` và request có `siteId` THEN mọi câu truy vấn mà request đó chạy qua `c.get('db')` SHALL thấy `current_setting('app.site_id', true)` = `siteId` của request, kể cả sau các điểm `await` và khi pool trả về connection khác nhau.
2. WHEN handler gọi `db.transaction(...)` (hoặc `runSiteTransaction`) THEN transaction đó SHALL có scope của request trước câu đầu tiên của callback.
3. WHEN `runSiteTransaction(db, otherSiteId, fn)` được gọi trong request THEN phần thân `fn` SHALL chạy dưới `otherSiteId` (câu `set_config` sau thắng).
4. WHEN một câu lỗi trong một request THEN các câu sau của request SHALL không bị ảnh hưởng (giữ ngữ nghĩa autocommit từng câu như hiện nay).
5. WHEN việc chạy sau response (`waitUntil`, fire-and-forget, streaming) truy vấn qua db của request THEN nó SHALL vẫn có scope của request.

### Requirement 2: Không rò scope qua pool

1. WHEN một connection được trả về pool THEN nó SHALL không mang `app.site_id` của request trước (chỉ dùng `set_config(…, true)` bên trong transaction; không dùng `SET` cấp session).
2. WHEN hai request của site A và site B chạy đồng thời trên cùng pool THEN mỗi câu SHALL chỉ thấy dòng của site mình.

### Requirement 3: Đường hệ thống và background job

1. WHEN worker, cron hoặc queue consumer chạy (Docker `serve.ts`; Cloudflare `cloudflare.ts` `scheduled`/`queue`) THEN nó SHALL dùng System_Connection.
2. WHEN `setup`, `/health`, `adminPathGuard`, `scim/v2`, OAuth callback của git integration hoặc `auditApiKeyUseDenied` truy vấn THEN chúng SHALL dùng System_Connection.
3. WHEN một đường hệ thống chạy trên App_Role (cấu hình sai) THEN nó SHALL fail closed (0 dòng hoặc từ chối ghi), không mở rộng quyền.
4. WHEN router công khai chỉ biết `siteId` trong handler (`deliver`, `shares` public, `pageviews` hit, `email/unsubscribe`, `deployments/webhook`, git webhook, git preview) THEN handler SHALL mở Scoped_Client cho `siteId` đó.

### Requirement 4: Parity Docker / Cloudflare

1. WHEN `enforce` bật THEN hành vi ở Req 1–3 SHALL giống nhau trên Docker (pg pool) và Cloudflare (Hyperdrive, transaction pooling).
2. WHEN build Worker THEN `pnpm verify:worker-bundle` SHALL vẫn pass (Scoped_Client không kéo dependency chỉ có ở Node).

### Requirement 5: Mặc định tắt, không đổi latency khi tắt

1. WHEN `LUMIBASE_DB_RLS` không set hoặc `off` THEN request path SHALL không mở transaction thêm và SHALL bỏ câu `set_config` autocommit vô dụng hiện nay.
2. WHEN `enforce` bật mà thiếu System_Connection THEN Docker SHALL fail lúc khởi động và Cloudflare SHALL trả `503 RLS_MISCONFIGURED`.
3. WHEN `off` mà role đang kết nối là NOBYPASSRLS và `pg_policies` có `site_isolation_permit` THEN ứng dụng SHALL log cảnh báo lúc khởi động.

### Requirement 6: Kiểm chứng

1. Có test DB integration (`*.db.integration.test.ts`) chạy với App_Role NOSUPERUSER NOBYPASSRLS + System_Role và chứng minh Req 1–3 qua chuỗi middleware thật.
2. Có tripwire chặn `set_config('app.site_id'` ngoài Scoped_Client và `runSiteTransaction`, và chặn `drizzle(`/`getConnection()` mới chưa được phân loại.
3. Có số đo before/after (scope quan sát được, số dòng thấy được) và chi phí latency `off` vs `enforce`.
