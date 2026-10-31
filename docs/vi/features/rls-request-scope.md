---
version: 1
lastUpdated: 2026-10-17T16:36:19.946Z
sourceLang: en
translatedFrom: en
sourceHash: 5114d38102cfe297
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-17T16:36:19.946Z
codeVerifiedHash: 5114d38102cfe297
codeVerifiedClaims: 14
---

# Scope RLS trên request path

`packages/database/migrations/rls-policies.sql` đặt một cặp policy row-level-security lên mọi bảng cô lập theo site: một dòng chỉ được thấy hoặc ghi khi `site_id` của nó bằng `app_site_id()`, tức setting `app.site_id` của transaction. Với `LUMIBASE_DB_RLS=enforce`, CMS set giá trị đó cho mọi câu truy vấn của request, nên database từ chối dòng của site khác ngay cả khi code ứng dụng quên lọc `site_id`. Bộ lọc `site_id` ở tầng ứng dụng vẫn là gate chính; đây là lớp chốt phía sau.

Cờ này là opt-in. Với mặc định `LUMIBASE_DB_RLS=off`, deployment hiện có không đổi gì, trừ việc `withRls` không còn chạy câu `set_config` riêng lẻ trên mỗi request. Câu đó autocommit nên chưa bao giờ scope được request (B130).

## Cách hoạt động

- **Request path.** `withDb()` (`apps/cms/src/middleware/db.ts`) chạy ngay sau `withTenant()`. Ở `enforce`, nó bọc connection bằng `createSiteScopedSql` (`packages/runtime/src/scoped-sql.ts`), và mỗi câu chạy dạng `BEGIN; SELECT set_config('app.site_id', $1, true); <query>; COMMIT` trên một connection. Site id luôn là tham số bind. Giá trị chỉ sống trong transaction đó nên không thể rò sang request khác qua pool. `db.transaction(...)` cũng được scope như vậy, và `runSiteTransaction(db, otherSite, fn)` vẫn scope lại một transaction sang site khác.
- **Router chỉ biết site trong handler** (`/api/v1/deliver`, share công khai, `/api/v1/pageviews/:site_id/hit`, `/api/v1/email/unsubscribe`, git webhook và môi trường preview) dựng db bằng `scopedDbFor(c, siteId)`.
- **System connection.** Worker, cron, queue consumer và route hệ thống (setup, recovery, SCIM, git OAuth callback, admin-path guard, các lệnh ghi audit xuyên site) chạy xuyên site hoặc chạy trước khi có site. Chúng dùng connection thứ hai trên một role có `BYPASSRLS`: `DATABASE_SYSTEM_URL` (Docker) hoặc binding `HYPERDRIVE_SYSTEM` (Workers).
- **Fail closed.** `withRls()` kiểm tra db của request đã được scope theo đúng site của request, nếu không thì trả `503 RLS_UNAVAILABLE`. Thiếu system connection khi `enforce` thì trả `503 RLS_MISCONFIGURED`, và giá trị cờ không hợp lệ cũng vậy. Trên Docker thì process từ chối khởi động.

## Bật tính năng

1. Tạo hai role. Role ứng dụng không được bypass RLS. Nên dùng system role không phải superuser:
   ```sql
   CREATE ROLE lumibase_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOBYPASSRLS;
   CREATE ROLE lumibase_sys LOGIN PASSWORD '<system password>' NOSUPERUSER BYPASSRLS;
   GRANT USAGE ON SCHEMA public TO lumibase_app, lumibase_sys;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lumibase_app, lumibase_sys;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lumibase_app, lumibase_sys;
   ```
   Chạy migration và áp `rls-policies.sql` bằng owner của database, không phải bằng hai role này. Chạy lại lệnh grant sau các migration thêm bảng.
2. Áp policy (sau mỗi lần upgrade):
   ```bash
   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
     -f packages/database/migrations/rls-policies.sql
   ```
3. Trỏ ứng dụng tới các role:
   - Docker: `DATABASE_URL` = role ứng dụng, `DATABASE_SYSTEM_URL` = system role (cũng dùng được `DATABASE_SYSTEM_URL_FILE`), `LUMIBASE_DB_RLS=enforce`.
   - Workers: `HYPERDRIVE` = một Hyperdrive config cho role ứng dụng, thêm binding `[[env.<name>.hyperdrive]]` thứ hai tên `HYPERDRIVE_SYSTEM` cho system role (mẫu có trong `apps/cms/wrangler.toml`), và var `LUMIBASE_DB_RLS = "enforce"`.
4. Khởi động CMS. Docker in log `[db-rls] request-path RLS scope: enforce (app role "…", system role "…")`. Nó từ chối khởi động khi system role thiếu `BYPASSRLS`, và cảnh báo khi role ứng dụng bypass RLS.
5. Kiểm tra hai site: tạo một bản ghi ở site A, xác nhận danh sách của site B không có nó, và `GET /health/ready` trả 200 (nó probe cả hai connection).

Ở chế độ enforce, role ứng dụng tuyệt đối không được là superuser hay có `BYPASSRLS`: lớp chốt sẽ không thực thi gì, và lúc khởi động có cảnh báo về việc này. Role ứng dụng là superuser hoặc có `BYPASSRLS` chỉ là cấu hình `off`, tức hành vi hiện nay.

**Rollback:** đặt `LUMIBASE_DB_RLS=off` và trỏ `DATABASE_URL` (hoặc `HYPERDRIVE`) về lại role bypass RLS. Không đụng tới dữ liệu hay schema.

## Multi-tenancy

| Tài nguyên | Phạm vi |
|---|---|
| `app.site_id` | Theo từng transaction của câu truy vấn, đặt bằng site của request; không bao giờ ở mức session |
| App connection / pool | Dùng chung cho mọi tenant; cô lập nhờ scope theo từng câu |
| System connection (`DATABASE_SYSTEM_URL` / `HYPERDRIVE_SYSTEM`) | Dùng chung toàn deployment; chỉ worker, cron, queue và route hệ thống dùng, và chúng lọc theo `siteId` trong code |

Cách kiểm: `apps/cms/src/__tests__/rls-request-scope.db.integration.test.ts` chạy middleware thật với một role NOBYPASSRLS và hai site (chỉ thấy dòng của site mình, 40 request xen kẽ trên hai connection của pool, lệnh ghi xuyên site bị từ chối, worker sweep trên system role). `apps/cms/src/__tests__/rls-scope.wiring.test.ts` buộc mọi chỗ dựng db mới và mọi mount mới phải được phân loại.

## Chi phí và giới hạn

Mỗi câu tốn ba round trip thay vì một (BEGIN, scope + query chạy pipeline, COMMIT). Trên Postgres Docker cục bộ, 1000 request list tuần tự đo được p50 2.11–2.31 ms khi tắt cờ và 3.42–3.85 ms khi bật, qua ba lần chạy. Qua Hyperdrive mỗi round trip thêm là một round trip mạng, và phần đó chưa được đo.

- Các bảng không có trong `rls-policies.sql` không được bảo vệ (B127).
- `LISTEN/NOTIFY`, cursor và `sql.reserve()` ném lỗi trên client đã scope; code request không dùng chúng.
