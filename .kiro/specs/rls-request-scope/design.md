# Design — RLS Request Scope (B130)

> Status: implemented behind opt-in flag `LUMIBASE_DB_RLS` (owner option B, 2026-10-16; PR #552, 2026-10-17). Mặc định `off`; xem `tasks.md` và mục Implementation decisions trong `design.md`.
>
> Trạng thái ban đầu (Phase 0): **post-v1, chưa bắt đầu.** Đây là thay đổi public surface **additive** (env var `DATABASE_SYSTEM_URL`, binding `HYPERDRIVE_SYSTEM`, cờ `LUMIBASE_DB_RLS`), nên chỉ ship ở một bản minor 1.x (`v1-release-criteria.md` §6). Phase 0 (docs + backlog + comment, không đổi logic) đã làm ở PR ghi trong B130.
>
> Số dòng code trích dẫn bên dưới đo ở commit `356a859e` (+ #550 `9d130b24`). Đối chiếu lại trước khi làm.

## 1. Vấn đề đã kiểm chứng

- `apps/cms/src/middleware/rls.ts` `withRls()`: chạy `runtime.database.getConnection()` rồi `` sql`SELECT set_config('app.site_id', ${siteId}, true)` `` như **một câu autocommit riêng** trên pool postgres.js. Vì `is_local=true`, setting mất ngay khi transaction ngầm của câu đó kết thúc. Câu kế tiếp (có thể trên connection khác của pool) đọc `''`, nên `app_site_id()` trả NULL và mọi bảng trong `rls-policies.sql` cho 0 dòng với role NOBYPASSRLS. Không có runtime nào bọc request trong một transaction (Hyperdrive dùng transaction pooling; pool Docker autocommit).
- Cùng anti-pattern ở `modules/git-integration/webhook/handler.ts` và `modules/git-integration/preview.ts` (`setContext`).
- `withDb()` (`middleware/db.ts`) dựng `drizzle(runtime.database.getConnection())`, tức drizzle trên **pool**. Mỗi `await db.select()` lấy một connection bất kỳ ở chế độ autocommit.
- Chỉ đường đi qua `runSiteTransaction` (`services/rls-transaction.ts`, gọi từ `item-service.ts` và `review-run-retention.ts`) có scope đúng: `db.transaction` + `set_config(…, true)` trên cùng `tx`.

### Số đo (Phase 0, 2026-10-16)

postgres:16 riêng, `pnpm db:migrate` + `rls-policies.sql` của #550, role `b130_app` NOSUPERUSER NOBYPASSRLS, site A có 2 dòng `lumibase_settings`, site B có 1. Chạy middleware `withRls` thật trong một app Hono với `LUMIBASE_ENV=production`, rồi handler truy vấn bằng drizzle trên pool (`max: 4`): một câu, `await` 5 ms, rồi 4 câu song song.

| Đường | Site | `current_setting('app.site_id', true)` | Dòng thấy được | Backend pid |
|---|---|---|---|---|
| `withRls` + pool (hiện tại) | A | `''` ở cả 5 câu | 0 ở cả 5 câu | 4 pid khác nhau |
| `withRls` + pool (hiện tại) | B | `''` ở cả 5 câu | 0 ở cả 5 câu | 4 pid khác nhau |
| `runSiteTransaction` | A | `site_a` (trước và sau `await`) | 2 | 1 pid |
| `runSiteTransaction` | B | `site_b` (trước và sau `await`) | 1 | 1 pid |

## 2. Các phát hiện khiến bản vá lớn

| # | Phát hiện | Bằng chứng |
|---|---|---|
| F1 | `withRls` đứng **cuối** chuỗi `api.use('*', withTenant(), withDb(), withTenantExists(), withAuth(), withSiteMembership(), withRateLimit(), requireSetupComplete(), withStudioAccess(), withControlPlaneAccessGuard(), withFileUploadPolicy(), withRls())` (`index.ts:220`). Các middleware trước nó đã truy vấn bảng có RLS: `PermissionService` (roles/policies/user_policies/permissions) trong `site-membership.ts:189`, `studio-access.ts:134`; `AuditLogger` (audit_log) trong `auth.ts:102,418`. Dù `withRls` có hoạt động thì vị trí đó cũng quá muộn. | `index.ts:220`, grep middleware |
| F2 | Worker/cron dùng chung **một** `rotatorDb = drizzle(runtime.database.getConnection())` (`serve.ts:198`) cho: audit rotation, pageview flush, agent-run, content-indexing, revalidation, audit-log worker, CDC dispatch, flow-event, flow-runs, veto commit + sweep, claim sweep, stale-run sweep, scheduler tick + retention, goal dispatch, deployment poller (`sweepAllSites`), flow schedule sweep, envelope migration. Cloudflare: `cloudflare.ts` (`scheduled`, `queue` qua `processCloudflareQueue`). Phần lớn là sweep **xuyên site**, không có scope. | `serve.ts:198–599`, `cloudflare.ts:99–135` |
| F3 | Audit-log batcher insert **nhiều site trong một câu INSERT** (B64). Dưới RLS câu này không bao giờ qua được WITH CHECK, dù scope đặt là site nào. | backlog B64 |
| F4 | Router mount trên `app` chỉ có `withDb()`, không có siteId tại thời điểm `withDb`: `deliver` (siteId lấy từ `c.req.param('site_id')` trong handler, `routes/deliver.ts:300`), `shares` public, `pageviews/:site_id/hit`, `email/unsubscribe`, `deployments/webhook` (có `withTenant`), `scim/v2`, `integrations/git` public, `setup`. | `index.ts:163–400` |
| F5 | Ghi **xuyên site** ngay trong request: `auditApiKeyUseDenied` ghi audit dưới site **của key**, không phải site của request (B64 fix `85ed2925`). Dưới scope của request, câu này fail WITH CHECK. | `middleware/auth.ts:93–102` |
| F6 | Công việc chạy **sau** response dùng db của request: `lib/detached.ts` (`waitUntil`/fire-and-forget), `void new AuditLogger(...)` (`deployment-service.ts:89`), `runRevalidationDispatch` (`content-invalidation.ts:135`), `emitAgentNotification` (`notify-context.ts:29`), stream trong `routes/admin.ts:214`. Một transaction mở theo từng request (phương án a) sẽ đã commit trước khi các việc này chạy. | grep |
| F7 | 21 lời gọi `.transaction(` (không tính test). Rất nhiều handler bắt lỗi DB (unique violation → 409) rồi tiếp tục. Trong một transaction bao cả request, sau lỗi đầu tiên mọi câu tiếp theo trả `current transaction is aborted`. | grep |
| F8 | Code bỏ qua `c.get('db')` và tự dựng drizzle/sql: `admin-path-guard.ts:407` (`resolveDb`), `routes/health.ts:93`, hai file git ở trên, `serve.ts:88` (setup token). | grep `getConnection()` |
| F9 | Chi phí: drizzle 0.45.3 + postgres 3.4.9. `sql.begin` gửi `begin` như một round trip riêng (`postgres/src/index.js:242`), sau đó callback, rồi `commit` (`:278`). Mọi phương án scope theo từng câu đều tốn ≥3 round trip thay cho 1. Qua Hyperdrive đó là latency thật cho **mọi** deployment, kể cả deployment không bật RLS (đa số). | đọc source |

## 3. Cơ chế cho request path — các phương án

Ràng buộc: chạy được trên Docker (pg pool, `serve.ts`) và Cloudflare (Hyperdrive, `cloudflare.ts`/`index.ts`); không rò scope qua pool; worker không vỡ; đường hệ thống chạy được trên BYPASSRLS và fail closed (0 dòng) trên role thường.

### (a) Một transaction cho mỗi request — LOẠI

`db.transaction(async tx => { set_config; c.set('db', tx); await next() })`.

- Giữ một connection và một transaction mở suốt request. Request dài (gọi LLM, upload, chat AI sync) gây cạn pool (Docker `max: 20`, CF `max: 5` mỗi isolate) và tạo `idle in transaction` giữ lock.
- Đổi ngữ nghĩa lỗi (F7): handler bắt lỗi rồi chạy tiếp sẽ vỡ hàng loạt.
- Việc chạy sau response và streaming (F6) chạy trên transaction đã đóng.
- Phải quyết định commit/rollback theo status code, tức đổi hành vi ghi một phần của mọi route.
- `runSiteTransaction` lồng bên trong thành savepoint. Chạy được, nhưng không bù được các điểm trên.

### (b) Mở transaction lười ở câu đầu tiên — LOẠI

Mang toàn bộ nhược điểm của (a) (transaction vẫn sống tới hết request), lại thêm câu hỏi "khi nào commit" mà không có điểm kết thúc rõ ràng. Không giải quyết được F6.

### (c) Scope theo từng câu / từng transaction qua wrapper client của driver — CHỌN

Bọc client postgres.js trước khi đưa cho drizzle. Drizzle postgres-js session chỉ dùng: `client.unsafe(query, params)` (thenable), `.values()`, `client.begin(cb)`, `client.savepoint(cb)` bên trong tx, và `client.options.parsers/serializers` (`drizzle-orm/postgres-js/session.js:33,43,65,103,106,109,131`; `driver.js:18–22`). Wrapper:

- `unsafe(q, p)` trả một thenable có `.values()`. Khi được await, nó chạy `base.begin(async tx => { const [, r] = await Promise.all([tx\`SELECT set_config('app.site_id', ${siteId}, true)\`, mode === 'values' ? tx.unsafe(q, p).values() : tx.unsafe(q, p)]); return { r }; })` rồi trả `.r`. Phải bọc trong `{ r }` vì `begin` gọi `Promise.all` lên kết quả dạng Array (`index.js:262`), làm mất `.count`/`.columns` của RowList. Hai câu bên trong pipeline nên tổng là 3 round trip: BEGIN, (set_config + query), COMMIT.
- `begin(cb)` gọi `base.begin(async tx => { await tx\`SELECT set_config(…, true)\`; return cb(tx); })`. Như vậy **mọi** `db.transaction(...)` của request tự động có scope. Savepoint lồng bên trong dùng thẳng `tx.savepoint`, scope là của transaction ngoài.
- Các thuộc tính khác (`options`, `end`, `reserve`…) forward qua `Proxy` về `base`. Lời gọi tagged-template trực tiếp lên wrapper (`apply` trap) cũng đi đường bọc.

Vì sao chọn (c):

- Đúng connection, đúng transaction: `set_config` và câu truy vấn nằm trong cùng `BEGIN…COMMIT` trên cùng connection đã reserve. `is_local=true` chỉ sống trong transaction đó nên **không thể** rò qua pool.
- Giữ nguyên ngữ nghĩa autocommit của từng câu như hiện tại (F7 không đổi) và không giữ connection suốt request.
- Việc sau response, streaming, `waitUntil` vẫn đúng (F6): mỗi câu tự mở scope của nó.
- Chạy giống nhau trên hai runtime vì cả hai adapter trả cùng `postgres.Sql` (`packages/runtime/src/adapters/{docker,cloudflare}/database.ts`). Hyperdrive ở transaction pooling vẫn tôn trọng `BEGIN…COMMIT`.

Chi phí của (c) (F9) buộc phải **gate bằng cờ opt-in** `LUMIBASE_DB_RLS=enforce` (mặc định `off`). Khi `off`, `withDb` giữ nguyên như hiện nay và chỉ bỏ câu `set_config` vô dụng (tiết kiệm 1 round trip mỗi request). Khi `enforce`, dùng wrapper.

### (d) `SET` cấp session trên connection reserve (`sql.reserve()`) + `RESET` khi trả — LOẠI

Hyperdrive dùng transaction pooling nên session state không được bảo đảm giữ giữa các câu, tức sai trên Cloudflare. Trên Docker, chỉ cần `RESET` lỗi một lần (request abort, exception) là connection quay về pool **mang scope của site khác**. Đây chính là rủi ro rò rỉ mà ràng buộc cấm. Nó cũng giữ connection suốt request như (a).

### (e) Nhúng `set_config` vào cùng câu (CTE / multi-statement) — LOẠI

CTE không bảo đảm thứ tự đánh giá so với policy. Multi-statement có tham số không chạy được ở extended protocol, còn inline giá trị thì mở đường SQL injection.

## 4. Thành phần bắt buộc đi kèm: kết nối hệ thống BYPASSRLS

Phương án (c) chỉ xử lý request có siteId. Mọi thứ ở F2–F5, F8 cần một kết nối **không** bị RLS. Mô hình hai role:

- `DATABASE_URL` / `HYPERDRIVE` là role app (NOSUPERUSER NOBYPASSRLS), dùng cho request path có scope.
- Env mới `DATABASE_SYSTEM_URL` (Docker) và binding `HYPERDRIVE_SYSTEM` (Cloudflare) cho role có BYPASSRLS. `DatabaseProvider` thêm `getSystemConnection()`. Khi không cấu hình thì trả lại connection chính (tương thích ngược: deployment hiện tại dùng role BYPASSRLS/superuser nên không đổi gì).
- Kiểm tra lúc khởi động: `LUMIBASE_DB_RLS=enforce` mà thiếu system connection thì Docker fail start, CF trả `503 RLS_MISCONFIGURED`. Nếu `off` mà role đang kết nối là NOBYPASSRLS và `pg_policies` có `site_isolation_permit`, log cảnh báo (đúng ca "operator áp file nhưng quên bật cờ").

Đây là thay đổi **public surface** (env var + binding mới, theo `v1-release-criteria` §6), dạng additive. Chỉ hợp lệ ở bản minor, cần ghi CHANGELOG + `environment-variables.md` EN/VI.

### Danh sách đường cần BYPASSRLS (system connection)

Đường request không có siteId hoặc cố ý xuyên site:

- `setup` router (`modules/setup/routes.ts:311`) + `runSetupTokenStartup` (`serve.ts:88`): tạo site đầu tiên, chưa có scope.
- `/health`, `/health/ready` (`routes/health.ts:93`): probe, không đọc dữ liệu tenant.
- `adminPathGuard` (`middleware/admin-path-guard.ts:407`): chạy trước `withTenant`.
- `scim/v2` (cross-site user provisioning), `integrations/git` public (OAuth callback).
- `auditApiKeyUseDenied` (`middleware/auth.ts:93`): ghi dưới site của key ≠ site của request. Dùng system connection, hoặc mở `runSiteTransaction(keySiteId)` riêng.
- Marketplace/extension global rows (`site_id IS NULL`): policy đã cho phép, không cần BYPASSRLS, chỉ ghi chú.

Đường không cần BYPASSRLS, nhưng phải tự mở scope vì siteId chỉ biết trong handler:

- `deliver/*` (`routes/deliver.ts:300`), `shares/*` public, `pageviews/:site_id/hit`, `email/unsubscribe`, `deployments/webhook/*`, git webhook (`webhook/handler.ts`), git preview (`preview.ts`). Cách xử lý: `withDb` không gắn db chung cho các router này nữa. Handler gọi `scopedDbFor(c, siteId)` (cùng wrapper ở §3c). Câu `set_config` độc lập ở hai file git bị xoá.

Toàn bộ worker/cron/queue (F2, F3), trên cả `serve.ts` lẫn `cloudflare.ts` / `cloudflare-queue.ts` / `cloudflare-flow-queue.ts`: dùng system connection. Đây là chỗ thay đổi tập trung nhất, vì Docker chỉ có **một** `rotatorDb` dùng chung. Đổi job sang `runSiteTransaction` theo từng site (như B114) là tuỳ chọn về sau, **không** thuộc spec này.

## 5. `runSiteTransaction` lồng nhau

- Có wrapper: `runSiteTransaction(db, siteId, fn)` gọi `db.transaction`, tức `wrapper.begin`. Wrapper `set_config` site của request trước, rồi `runSiteTransaction` `set_config` lần nữa với `siteId` của nó, trong **cùng** transaction. Câu sau thắng, nên việc chủ động scope sang site khác (ví dụ retention theo từng site) vẫn đúng. Chi phí thêm một câu, chấp nhận được.
- Đã ở trong một transaction (gọi với `tx`): drizzle tạo savepoint (`client.savepoint`). `set_config` trong savepoint đổi giá trị cho phần còn lại của transaction, và rollback savepoint thì khôi phục giá trị cũ. Đúng ngữ nghĩa mong muốn.
- Không cần sửa logic `rls-transaction.ts`.

## 6. Kế hoạch test

- Unit (`scoped-sql`): thứ tự `set_config` → query, cùng handle tx; `.values()`; giữ `.count`; `begin` set scope trước cb; siteId đi qua tham số chứ không nội suy. Property test (fast-check): siteId bất kỳ, kể cả chuỗi dạng injection `x' OR '1'='1`, luôn đi vào tham số `$1`.
- DB integration `apps/cms/src/__tests__/rls-request-scope.db.integration.test.ts`. Không chạy được trong một transaction rollback như suite B125, vì app dùng pool. Cách làm: `CREATE DATABASE lumibase_rls_<rand>` trong `beforeAll`, migrate, áp `rls-policies.sql` bằng owner, tạo role `app` NOSUPERUSER NOBYPASSRLS (GRANT trên bảng) và role `sys` BYPASSRLS, seed site A/B. Dựng app Hono với runtime có DB chính = `app`, system = `sys`, `LUMIBASE_DB_RLS=enforce`, rồi gọi `app.fetch`:
  - `GET /api/v1/items/<col>` với `X-Lumi-Site: A` + token admin của A: trả đúng dòng của A, không có dòng của B.
  - Ghi item ở A rồi đọc bằng `sys`: `site_id = A`.
  - `GET /api/v1/deliver/<B>/…`: chỉ thấy B.
  - Worker: chạy một sweep (`runDueScheduledFlows`, audit batch nhiều site) trên system db: chạy được.
  - Thử ngược: cờ `off` với role `app` thì list trả 0 dòng (bằng chứng "before").
  - `afterAll` `DROP DATABASE`.
  Đặt tên file `*.db.integration.test.ts` để chạy trong job CI `DB integration suites`, import `helpers/db-harness` (tripwire `db-integration-guard`).
- E2E: chạy golden path (`e2e-golden-path`) một lần với role app + cờ enforce, thêm một job CI biến thể.

## 7. Tripwire

- **T1** (source scan, `apps/cms/src/__tests__/rls-scope.wiring.test.ts`): `set_config('app.site_id'` chỉ được xuất hiện trong `packages/runtime/src/scoped-sql.ts` và `apps/cms/src/services/rls-transaction.ts`. Khoá class "set_config autocommit" (ba chỗ hiện tại).
- **T2** (source scan): mọi `drizzle(`, `createDb(`, `getConnection()`, `getSystemConnection()` ngoài test trong `apps/cms/src` phải nằm trong allow-list có phân loại `scoped | system | dev` kèm lý do. Allow-list chỉ được co, giống `DOCKER_ONLY_CONSUMERS`.
- **T3** (source scan, mẫu `worker-queue-consumers.wiring.test.ts`): mọi `register*Worker`/`register*Poller` trong `serve.ts` và mọi consumer trong `WORKER_QUEUE_CONSUMERS` nhận db từ system connection.
- **T4** (hành vi): ca "cờ `off` + role app → 0 dòng" ở §6, cùng mutation gỡ wrapper khỏi `withDb` thì test đỏ. Kiểm âm thủ công khi làm PR.

## 8. Đo before/after và chi phí

- **Before** (trên nền #550): postgres riêng, `log_statement=all`, `log_line_prefix='%p %x '`. Migrate, áp file, tạo role `app` NOBYPASSRLS. Chạy CMS bằng `tsx src/serve.ts` với `DATABASE_URL=app`, `LUMIBASE_ENV=production`. Gọi list items cho site A: **0 dòng**. Trong log, câu `set_config` và câu `SELECT … lumibase_items` có `%x` (xid) khác nhau (hoặc 0) và có thể khác `%p`. Số đo Phase 0 ở §1 đã xác nhận phần này ở mức middleware.
- **After**: cùng thủ tục với `LUMIBASE_DB_RLS=enforce` + `DATABASE_SYSTEM_URL`. List trả dòng của A, không có dòng của B. Trong log, mỗi query có `BEGIN` → `set_config` → query → `COMMIT` trên **cùng** `%p`/`%x`.
- **Chi phí**: 1000 lần `GET /items` tuần tự và song song (k6 `apps/cms/k6/load-items.js`) với cờ `off` vs `enforce` trên Docker local. Ghi p50/p95 vào mô tả PR. Hyperdrive staging đo riêng; không suy từ local.

## Implementation decisions (PR #552, 2026-10-17)

- **D1** Cờ parse ở `apps/cms/src/config/db-rls.ts` (Worker-safe): `''`/`off` → off, `enforce` → enforce, giá trị khác → `DbRlsConfigError` (fail closed). Đọc `c.env` trước, rồi `process.env`.
- **D2** `enforce` áp cho mọi nhánh của `withDb` (dev, runtime, Hyperdrive fallback). `withRls` không còn chạm DB nên không còn dev-skip; `runSiteTransaction` chỉ skip ở dev khi cờ không phải `enforce`.
- **D3** Nhận biết db đã scope qua marker `SITE_SCOPED_SQL` trên client (`db.$client`), đọc qua `isSiteScopedSql` / `scopedSiteIdOf`; `unscopedSqlOf` lấy lại client gốc để scope sang site khác.
- **D4** Toàn bộ helper phía request ở `middleware/db.ts`: `withDb`, `withSystemDb`, `scopedDbFor(c, siteId)` (off → `c.get('db')`), `systemDbFor(c)` (memo trong `Variables.systemDb`; off không có system connection riêng → dùng lại `c.get('db')`).
- **D5** Workers: `enforce` thiếu system connection → `503 RLS_MISCONFIGURED` theo từng request.
- **D6** `DatabaseProvider.getSystemConnection()` + `hasSystemConnection()`; thiếu cấu hình thì trả connection chính. Docker: pool thứ hai lazy (`max: 10`); Cloudflare: Hyperdrive thứ hai lazy (`max: 5`).
- **D7** Docker startup check `config/db-rls-startup.ts` (`assertDbRlsStartup`): cờ sai / `enforce` thiếu `DATABASE_SYSTEM_URL` / system role không bypass RLS → throw; app role bypass RLS ở `enforce` → cảnh báo; `off` + role NOBYPASSRLS + đã có policy → cảnh báo (probe tư vấn, lỗi kết nối không chặn khởi động). `DATABASE_SYSTEM_URL` hỗ trợ `_FILE`.
- **D8** Workers dùng `cloudflare-system-db.ts` `createCloudflareSystemDb(env)`: `HYPERDRIVE_SYSTEM` → (chỉ khi off) `HYPERDRIVE` → (chỉ dev) `DATABASE_SYSTEM_URL ?? DATABASE_URL`.
- **D9** `wrangler.toml` chỉ có khối `HYPERDRIVE_SYSTEM` dạng comment (binding Hyperdrive cần id thật); deploy hiện tại không đổi.
- **D10** Đường hệ thống: setup, recovery, `/scim/v2`, git OAuth callback, `adminPathGuard`, `auditApiKeyUseDenied`; `/health` probe cả hai connection.
- **D11** `PreviewEnvManager` nhận `scopedDb(siteId)`; mỗi câu chạy trên site nó tác động; `setContext` đã xoá.
- **D12** Client đã scope ném `SCOPED_SQL_UNSUPPORTED` cho `reserve`, `listen`, `notify`, `subscribe`, `savepoint` (top level), `file` và các API cursor/stream của query.
- **D13** Property test (fast-check) ở `apps/cms` để không thêm devDependency vào `packages/runtime`.
- **D14** Fixture role/DB dùng chung: `apps/cms/src/test-utils/rls-roles.ts` (suite DB + script bench).
- **D15** Spec vẫn post-v1 trong `v1-scope-classification.md`; nếu merge trước tag `v1.0.0` thì ba tên biến môi trường thành surface 1.0, đối chiếu lúc cắt RC.
- **D16** Doc tính năng: cặp `docs/{en,vi}/features/rls-request-scope.md`.
- Hộp `{ r }` trong `runScoped` là phòng thủ: kiểm âm cho thấy với callback `async` của postgres.js 3.4.9 nó không bắt buộc; `.count` được kiểm trên DB thật.
- Biến thể golden-path E2E chạy `enforce` trong CI (kế hoạch item 17) **chưa làm** trong PR này; hành vi được chứng minh bằng suite DB integration (chạy trong job `DB integration suites`).

## Kết quả đo (local Docker, 2026-10-17)

Postgres 16.15 trong container trên cùng máy (loopback), Node 24.15.0, postgres.js 3.4.9, máy dùng chung (load 5–9). **Không đại diện cho Hyperdrive.** Script `apps/cms/scripts/bench-rls-scope.ts`, middleware `withDb`/`withRls` thật, list 50 item, 2 site × 200 item, ba lần chạy:

| | off (role BYPASSRLS) | enforce (role NOBYPASSRLS) |
|---|---|---|
| Câu SQL / request | 1 | 4 (`begin`, `set_config($1)`, query, `commit`) |
| Tuần tự 1000 req, p50 | 2.11–2.31 ms | 3.42–3.85 ms |
| Tuần tự 1000 req, p95 | 4.45–7.01 ms | 6.73–9.10 ms |
| Song song 20, p50 | 18.56–26.04 ms | 29.69–33.37 ms |
| Song song 20, throughput | 575–939 rps | 435–620 rps |

Log `log_statement=all` xác nhận `begin` → `set_config('app.site_id', $1, true)` (tham số `$1`) → query → `commit` trên cùng backend pid. k6 không chạy (chưa cài); Hyperdrive staging chưa đo.

