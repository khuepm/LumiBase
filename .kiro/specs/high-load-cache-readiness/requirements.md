# Requirements Document — High-Load & Cache Readiness

## Introduction

Tài liệu yêu cầu cho chương trình **High-Load & Cache Readiness** của LumiBase CMS (`apps/cms`, `packages/runtime`, `docker/`). Mục tiêu: hệ thống phục vụ được tải đọc cao trên Delivery API, ghi ổn định dưới burst, và scale ngang an toàn trên Docker — trong khi giữ đúng hai bất biến của LumiBase: **multi-tenant isolation** (mọi khoá hạ tầng mang `siteId`) và **dual-runtime** (mọi cơ chế phải hoạt động trên cả Cloudflare Workers lẫn Docker/Node qua runtime abstraction, không import CF binding trong business logic).

Chương trình chia 3 phase (xem `roadmap.md`): P0 vá nhanh (Req 1–6), P1 nền tảng cache (Req 7–13), P2 scale-out (Req 14–18). Req 0 là điều kiện tiên quyết đo đạc.

## Glossary

- **Delivery_API**: Endpoint đọc công khai `GET /api/v1/deliver/*` (`routes/deliver.ts`) phục vụ nội dung đã publish cho frontend/website — đường nóng nhất khi tải cao.
- **Cache_Provider**: Interface cache trong runtime abstraction (`packages/runtime/src/interfaces/cache.ts`), adapter KV (Cloudflare) và Redis (Docker).
- **Cache_Provider_V2**: Phiên bản mở rộng của Cache_Provider theo ADR-004: `set(key, value, {ttl, tags})`, `invalidateByTag(tag)`.
- **Cache_Tag**: Chuỗi định danh nhóm cache entry để purge theo nhóm. LUÔN mang tiền tố tenant: `items:${siteId}:${collection}`, `schema:${siteId}`, `perm:${siteId}`.
- **Tag_Index**: Cấu trúc phụ ánh xạ tag → danh sách key. Redis: `SADD tag:{tag} key` + `SMEMBERS`; KV: entry JSON `tag:{tag}` chứa mảng key.
- **Single_Flight**: Cơ chế coalesce các cache-miss đồng thời trên cùng key trong một instance — chỉ một recompute chạy, các caller còn lại await chung promise.
- **SWR (stale-while-revalidate)**: Serve bản cache đã hết hạn mềm (stale) ngay lập tức, đồng thời refresh nền; caller không chờ recompute.
- **Revalidation_Dispatch**: Cơ chế `services/revalidation.ts` gửi `POST <target>?tag=<collection>` tới các Next.js ISR target đã đăng ký.
- **Request_Context_Bundle**: Object gắn vào Hono context chứa kết quả resolve một-lần-mỗi-request: user, memberships, permission bundle — để các middleware sau không lặp lại query.
- **Rate_Limiter_Store**: Backend đếm cửa sổ trượt cho rate limit. Docker: Redis (`INCR` + `EXPIRE` hoặc sorted-set); Cloudflare: Workers Rate Limiting binding hoặc Durable Object.
- **Worker_Role**: Chế độ chạy của Node process (`LUMIBASE_PROCESS_ROLE=web|worker|all`). `web` chỉ serve HTTP; `worker` chỉ chạy queue consumer + cron; `all` (default) giữ hành vi hiện tại cho deploy đơn giản.
- **Leader_Lock**: Khoá phân tán (Redis `SET key value NX PX ttl`) bảo đảm mỗi cron tick chỉ một instance thực thi khi có nhiều replica.
- **Origin_Offload**: Tỷ lệ request đọc được phục vụ bởi cache (edge/proxy/app) mà không chạm handler + DB.
- **Pressure_Limiter**: Middleware shedding sẵn có trên Node (`serve/pressure-limiter.ts`) trả 503 khi event-loop quá tải.
- **K6_Baseline**: Bộ số liệu p50/p95/p99 + RPS từ `apps/cms/k6/` chạy trên cấu hình chuẩn, lưu trong spec này làm mốc so sánh.

## Requirements

### Requirement 0: Baseline đo đạc trước khi tối ưu

**User Story:** Là maintainer, tôi muốn có số liệu hiệu năng mốc trước mọi thay đổi, để mỗi phase chứng minh cải thiện bằng số đo chứ không bằng suy đoán.

#### Acceptance Criteria

1. THE repo SHALL chứa kết quả K6_Baseline (p50/p95/p99, RPS, error rate) cho `smoke.js`, `load-items.js`, `load-realtime.js` chạy trên cấu hình docker-compose chuẩn, lưu tại `.kiro/specs/high-load-cache-readiness/baseline/` kèm mô tả phần cứng + cấu hình.
2. THE k6 suite SHALL được bổ sung scenario `load-deliver.js` phủ `GET /deliver/page/:site_id/:slug` (hiện chưa có), vì đây là đường nóng nhất.
3. WHEN một phase hoàn tất, THE spec SHALL cập nhật bảng so sánh baseline-vs-after trong `roadmap.md` §2 bằng số đo thực, không điền số ước lượng.

### Requirement 1: HTTP caching cho Delivery API

**User Story:** Là developer tích hợp frontend, tôi muốn Delivery API phát đúng HTTP caching header và hỗ trợ conditional request, để CDN/proxy/browser gánh phần lớn tải đọc thay origin.

#### Acceptance Criteria

1. WHEN Delivery_API trả 200 cho nội dung published và request KHÔNG mang credentials (không `Authorization`, không preview token), THE CMS SHALL set header `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` (hai giá trị cấu hình được qua env `LUMIBASE_DELIVER_SMAXAGE`, `LUMIBASE_DELIVER_SWR`).
2. THE Delivery_API SHALL set header `ETag` dạng weak (`W/"…"`) dẫn xuất từ nội dung response hoặc từ `max(updatedAt)` của các item cấu thành + schema version.
3. WHEN request mang `If-None-Match` khớp ETag hiện hành, THE Delivery_API SHALL trả `304 Not Modified` với body rỗng và KHÔNG thực thi truy vấn items (được phép một truy vấn nhẹ để xác định ETag hiện hành).
4. WHEN request mang credentials hoặc ở chế độ preview/draft, THE Delivery_API SHALL set `Cache-Control: private, no-store` và KHÔNG phát ETag chia sẻ được.
5. THE Delivery_API SHALL set header `Vary` tối thiểu gồm `X-Lumi-Site` (và `Accept-Language` nếu response phụ thuộc locale) để cache trung gian không trộn tenant.
6. WHEN chạy trên Cloudflare Workers, THE Delivery_API SHALL thêm bước match/put với `caches.default` cho response cacheable (edge cache), qua runtime abstraction — business logic không import binding trực tiếp (non-negotiable rule #3).
7. THE CMS SHALL có integration test chứng minh: (a) hai request liên tiếp cùng slug trả cùng ETag; (b) request thứ hai với `If-None-Match` nhận 304; (c) sau khi item trong page được patch, ETag đổi và request cũ nhận 200 mới; (d) request có `Authorization` nhận `no-store`.

### Requirement 2: Invalidate permission cache khi thay đổi quyền

**User Story:** Là site admin, tôi muốn thay đổi role/policy/API key có hiệu lực gần như ngay lập tức, để không có cửa sổ 60 giây trong đó quyền cũ (kể cả quyền vừa bị thu hồi) còn hoạt động.

#### Acceptance Criteria

1. WHEN một mutation thành công trên roles, policies, permissions, user_roles, user_sites, hoặc api_keys của một site, THE CMS SHALL vô hiệu hoá permission bundle cache của các principal bị ảnh hưởng trước khi trả response.
2. THE PermissionService SHALL chuyển sang **key versioning**: key dạng `perm:${siteId}:v${version}:${principal}` trong đó `version` đọc từ cache key `perm-ver:${siteId}`; invalidation toàn site = tăng `perm-ver:${siteId}` (một thao tác, không cần list-by-prefix — giải quyết hạn chế KV đã ghi ở `permission-service.ts:150-152`).
3. WHEN không xác định được chính xác principal bị ảnh hưởng (vd sửa policy gắn nhiều role), THE CMS SHALL bump version toàn site thay vì bỏ qua invalidation.
4. THE CMS SHALL giữ TTL 60s hiện tại làm lưới an toàn thứ hai (bảo vệ khi bump version thất bại).
5. THE CMS SHALL có integration test: tạo API key với quyền đọc → gọi thành công → thu hồi quyền → request kế tiếp bị 403 trong cùng giây (không chờ TTL).
6. IF `PermissionService.invalidate()` theo thiết kế cũ không còn được dùng sau khi chuyển key versioning, THE codebase SHALL xoá method đó (không giữ dead code).

### Requirement 3: Giảm write amplification của API-key authentication

**User Story:** Là operator, tôi muốn request đọc bằng API key không sinh một UPDATE mỗi lần gọi, để tải đọc cao không biến thành tải ghi lên bảng `api_keys`.

#### Acceptance Criteria

1. WHEN một API key được xác thực thành công, THE CMS SHALL chỉ ghi `lastUsedAt/lastUsedIp/lastUsedUserAgent` nếu giá trị `lastUsedAt` hiện tại cũ hơn ngưỡng 60 giây (cấu hình `LUMIBASE_APIKEY_TOUCH_INTERVAL`, default 60).
2. THE việc ghi lastUsed SHALL không chặn response: thực thi sau khi trả response (`waitUntil` trên CF, fire-and-forget có catch trên Node), lỗi ghi không làm fail request.
3. THE CMS SHALL giữ nguyên semantics audit: các sự kiện security (key denied, key revoked) vẫn ghi đồng bộ như hiện tại.
4. THE CMS SHALL có unit test chứng minh 100 request liên tiếp trong 60s với cùng key sinh đúng 1 UPDATE.

### Requirement 4: Cache trạng thái setup-complete

**User Story:** Là operator, tôi muốn middleware `requireSetupComplete` không query DB trên mọi request, vì trạng thái này chỉ flip một lần trong đời instance.

#### Acceptance Criteria

1. THE `requireSetupComplete` middleware SHALL cache kết quả kiểm tra bootstrap-admin theo process với TTL 5 giây (đồng nhất mẫu `adminPathGuard`, `middleware/admin-path-guard.ts:15-23`).
2. WHEN trạng thái đã là `initialized`, THE middleware SHALL cache vô hạn trong process (trạng thái không bao giờ quay ngược về `uninitialized`).
3. WHEN trạng thái là `uninitialized`, THE middleware SHALL giữ TTL ngắn (5s) để setup vừa hoàn tất được nhận diện nhanh trên mọi instance.
4. THE thay đổi SHALL không nới lỏng hành vi bảo mật hiện có: request tới surface bị chặn khi `uninitialized` vẫn bị chặn đúng như trước (test hiện hữu của setup flow phải giữ nguyên pass).

### Requirement 5: Đếm tổng (count) opt-in trên list endpoints

**User Story:** Là developer dùng API, tôi muốn kiểm soát việc server có chạy `count(*)` hay không, để các màn hình không cần tổng số (infinite scroll, delivery) không phải trả chi phí đếm trên mỗi trang.

#### Acceptance Criteria

1. THE list endpoint items SHALL nhận query param `meta` với các giá trị `total_count` (đếm đầy đủ như hiện tại) và `none` (bỏ qua count).
2. THE default khi vắng param SHALL giữ nguyên hành vi hiện tại (`total_count`) để không phá tương thích client hiện có (tutorial compatibility — DoD mục 5).
3. WHEN `meta=none`, THE ItemService SHALL không thực thi câu `count(*)` (`item-service.ts:577-581`) và response `meta` SHALL bỏ trường `total`.
4. THE Delivery_API SHALL không bao giờ thực thi count (xác nhận hiện trạng `routes/deliver.ts` — thêm test khoá hành vi này).
5. THE Studio SHALL được cập nhật để các list view dùng `meta=none` ở những nơi không hiển thị tổng số trang.
6. THE SDK (`@lumibase/sdk`) SHALL expose option `meta` trên hàm list; docs `hono-api-spec.md` cập nhật param mới.

### Requirement 6: Giới hạn kích thước request và rate limit tầng biên

**User Story:** Là operator, tôi muốn tầng proxy chặn payload quá khổ và burst bất thường trước khi chạm ứng dụng, để một client lỗi không kéo sập instance.

#### Acceptance Criteria

1. THE Caddyfile (`docker/Caddyfile`) SHALL cấu hình `request_body max_size` (default 10MB, ghi đè được) cho toàn bộ route trừ route upload media (dùng giới hạn riêng theo `FILE_UPLOAD_MAX_BYTES`).
2. THE CMS SHALL từ chối JSON body vượt ngưỡng cấu hình (`LUMIBASE_MAX_JSON_BODY`, default 1MB) với 413 và error envelope chuẩn — lớp phòng thủ trong ứng dụng cho deployment không dùng Caddy (CF Workers có giới hạn platform riêng).
3. THE Caddyfile SHALL bật rate limiting cơ bản theo IP cho prefix `/api/` (cấu hình mẫu kèm comment hướng dẫn tuning; giá trị default nới lỏng đủ để không ảnh hưởng usage bình thường).
4. THE docs deployment (`docs/en/deployment/docker.md`) SHALL mô tả các knob mới và khuyến nghị giá trị theo kích thước deploy.

### Requirement 7: Cache Provider v2 — tag-based invalidation (thực thi ADR-004)

**User Story:** Là developer CMS, tôi muốn purge cache theo nhóm (collection, site) bằng một thao tác, để content write có thể vô hiệu hoá đúng và đủ các entry liên quan mà không cần biết từng key.

#### Acceptance Criteria

1. THE `CacheProvider` interface SHALL mở rộng thành: `set(key, value, opts?: { ttl?: number; tags?: string[] })` và `invalidateByTag(tag: string): Promise<void>`; các method cũ giữ nguyên chữ ký (backward compatible — caller hiện tại không phải sửa).
2. THE Redis adapter SHALL triển khai Tag_Index bằng `SADD tag:{tag} {key}` khi set và `SMEMBERS` + pipeline `DEL` khi invalidate; tag-index entry có TTL ≥ TTL dài nhất của member key.
3. THE KV adapter SHALL triển khai Tag_Index bằng entry `tag:{tag}` chứa JSON array key; `invalidateByTag` đọc index, xoá từng key, rồi xoá index. THE docs SHALL ghi rõ giới hạn eventual consistency ~60s của KV (đã thừa nhận trong ADR-004:61) và hệ quả: purge trên CF là best-effort trong cửa sổ đó.
4. THE mọi Cache_Tag SHALL chứa `siteId` (DoD 2b — không có khoá "trần" dùng chung giữa tenant); vi phạm bị chặn bằng unit test quét tag literal trong codebase.
5. THE CMS SHALL expose `POST /api/v1/utils/cache/purge` (admin-only, control-plane — DoD 2c) nhận `{ tags?: string[], keys?: string[] }`, chỉ chấp nhận tag/key thuộc site hiện hành của request.
6. THE `InMemoryCacheProvider` (test double, `cdc/cache-invalidator.ts:202-240`) SHALL được thay bằng implementation đúng contract mới: tôn trọng TTL, có giới hạn kích thước (LRU, max entries cấu hình), đặt tại `packages/runtime` để dùng chung — xoá bản Map không giới hạn hiện tại.
7. THE ADR-004 SHALL được cập nhật trạng thái từ đề xuất sang implemented, khớp 100% với code (hết mâu thuẫn doc-vs-code).
8. THE cả hai adapter SHALL pass chung một contract test suite (set với tags → get → invalidateByTag → get trả null), chạy trong CI với Redis thật (docker) và miniflare/mock KV.

### Requirement 8: Invalidation nội dung khi ghi + tự động dispatch revalidation

**User Story:** Là content editor, tôi muốn publish/sửa/xoá nội dung thì mọi tầng cache (app cache, edge, Next.js ISR downstream) được làm mới tự động, để độc giả không thấy nội dung cũ quá vài giây.

#### Acceptance Criteria

1. WHEN một item được create/patch/softDelete thành công, THE ItemService SHALL gọi `invalidateByTag(\`items:${siteId}:${collectionName}\`)` sau khi commit, trước khi trả response; lỗi invalidation không làm fail request nhưng PHẢI ghi metric + log warn.
2. THE Delivery_API SHALL có application-level cache: response page cacheable được set vào Cache_Provider với key `deliver:${siteId}:${slug}:${variantHash}` + tags `[items:${siteId}:${collection}…]` cho mọi collection cấu thành page, TTL 300s.
3. WHEN item mutation thành công, THE ItemService SHALL trigger Revalidation_Dispatch (`dispatchRevalidation`) cho collection tương ứng — qua queue khi có queue provider, fallback `waitUntil`/fire-and-forget khi không — thay vì chỉ chờ client tự gọi `/utils/revalidate` như hiện tại (`routes/utils.ts:51-74`).
4. THE Revalidation_Dispatch SHALL chuyển từ vòng lặp await tuần tự (`revalidation.ts:59-89`) sang `Promise.allSettled` với timeout 5s/target giữ nguyên; kết quả từng target ghi metric.
5. WHEN schema thay đổi (đã có invalidation tại `schema-service.ts:974-988`), THE CMS SHALL bổ sung purge tag `deliver:${siteId}` để page cache không serve shape cũ.
6. THE CMS SHALL có integration test two-site (DoD 2b): mutation trên site A purge cache site A và KHÔNG đụng entry cùng collection-name của site B.

### Requirement 9: Single-flight và SWR cho schema/permission cache

**User Story:** Là operator, tôi muốn khi một cache entry nóng hết hạn dưới tải cao, chỉ một recompute chạy thay vì hàng trăm, để tránh thundering-herd lên Postgres mỗi chu kỳ TTL.

#### Acceptance Criteria

1. THE SchemaService và PermissionService SHALL dùng Single_Flight per-instance: các miss đồng thời trên cùng key await chung một promise recompute; map single-flight tự dọn sau khi promise settle.
2. THE schema cache SHALL chuyển sang SWR thật (comment "SWR-style" tại `schema-service.ts:965` hiện sai): entry mang `softExpiresAt` (300s) và `hardExpiresAt` (900s); trong khoảng soft-hard, serve bản stale ngay và refresh nền (`waitUntil` trên CF, fire-and-forget có catch trên Node); quá hard, recompute blocking qua single-flight.
3. THE unit test SHALL chứng minh: 50 concurrent get trên key vừa hết hạn sinh đúng 1 lần recompute (đếm bằng spy trên hàm compile).
4. THE cơ chế SHALL nằm trong helper dùng chung (vd `packages/runtime/src/cache-helpers.ts`) để service khác tái sử dụng, kèm JSDoc nêu rõ phạm vi per-instance (không phải distributed lock).

### Requirement 10: Hợp nhất tra cứu trong middleware chain

**User Story:** Là operator, tôi muốn mỗi request authenticated tốn tối thiểu round-trip DB cho việc nhận diện người gọi, để chi phí nền của mọi request giảm xuống.

#### Acceptance Criteria

1. THE middleware chain SHALL bảo đảm mỗi request thực thi tối đa MỘT lần: lookup `users`, lookup `userSites`, và `PermissionService.bundle()` — kết quả gắn vào Request_Context_Bundle trên Hono context; `withSiteMembership` (`site-membership.ts:86-124`) và `withStudioAccess` (`studio-access.ts:69-81`) đọc từ đó thay vì query lại (hiện trùng với `withAuth`, `auth.ts:268-286`).
2. THE thứ tự và semantics guard SHALL giữ nguyên: request bị từ chối trước đây vẫn bị từ chối với cùng status code; tripwire `security-guards.wiring.test.ts` giữ nguyên pass, KHÔNG sửa assertion để "cho qua" (DoD 2c).
3. THE refactor SHALL kèm behavioural test viết TRƯỚC: bảng (loại principal × loại route) → expected status, chạy trên code cũ và code mới cho kết quả giống nhau.
4. THE số query per-request SHALL được đo trong test (đếm qua query logger của Drizzle/postgres-js) và assert ≤ 3 cho request content-plane authenticated điển hình (không tính cache miss).

### Requirement 11: Audit log và side-effect ghi bất đồng bộ

**User Story:** Là operator, tôi muốn audit/field-access log không chiếm thời gian trong request thread và không double-write, để write path nhanh và log đáng tin.

#### Acceptance Criteria

1. WHEN queue provider khả dụng, THE AuditLogger SHALL enqueue event thay vì INSERT trực tiếp trong request (`logger.ts:448-520`); worker tiêu thụ ghi batch (multi-row INSERT, flush theo 100 event hoặc 1s).
2. WHEN queue không khả dụng, THE AuditLogger SHALL giữ đường ghi đồng bộ hiện tại NHƯNG bỏ cơ chế race-1000ms-rồi-bỏ-rơi (nguyên nhân double-write tiềm ẩn): thay bằng timeout hủy đúng nghĩa hoặc chấp nhận await trọn (chọn phương án trong design, ghi lý do).
3. THE field-access log cho PII/PHI (`item-service.ts:1609-1633`) SHALL đi cùng đường queue/batch như trên; ordering trong cùng request được bảo toàn ở mức "cùng batch".
4. THE audit event SHALL không bao giờ bị mất im lặng: enqueue fail → fallback ghi đồng bộ; cả hai fail → stderr structured log (giữ hành vi fallback hiện có) + metric counter.
5. THE integration test SHALL chứng minh: (a) 100 mutation liên tiếp sinh đủ 100 audit row; (b) độ trễ ghi ≤ 5s; (c) queue chết giữa chừng không làm mất event (fallback path).

### Requirement 12: Rate limiter phân tán cho API surface

**User Story:** Là operator, tôi muốn rate limit hoạt động đúng khi chạy nhiều replica/isolate, để giới hạn 3-lần-mỗi-giờ thực sự là 3 chứ không phải 3×N.

#### Acceptance Criteria

1. THE runtime abstraction SHALL thêm interface `RateLimiterProvider` (`consume(key, limit, windowSeconds): Promise<{allowed, remaining, retryAfter}>`) với adapter Redis (Docker; INCR+EXPIRE hoặc sliding-window sorted-set) và adapter Cloudflare (Workers Rate Limiting binding; fallback per-isolate memory kèm log warn khi binding vắng).
2. THE recovery limiter (`recovery/rate-limit.ts:97`) và setup `/state` limiter (`setup/routes.ts:76`) SHALL chuyển sang `RateLimiterProvider`; docstring "not shared across instances" được gỡ vì không còn đúng.
3. THE CMS SHALL thêm middleware rate limit tổng quát áp cho `/api/v1` với limit theo cặp `(siteId, principal)` — key dạng `rl:${siteId}:${principal}` (DoD 2b: tiền tố tenant) — default nới lỏng (600 req/phút, cấu hình `LUMIBASE_API_RATE_LIMIT`), trả 429 + `Retry-After` + error envelope chuẩn.
4. THE login-guard counter SHALL nhận backend Redis đã hứa nhưng chưa làm (`login-guard/counter.ts:196-214` hiện fallback Postgres kể cả khi `LUMIBASE_REDIS_URL` set) — triển khai qua `RateLimiterProvider`, giữ Postgres làm fallback.
5. THE hai-instance test (compose scale=2 hoặc mô phỏng 2 provider chung Redis) SHALL chứng minh budget được chia sẻ: tổng request được phép đúng bằng limit, không phải limit×2.

### Requirement 13: Cache observability

**User Story:** Là operator, tôi muốn thấy hit-rate và lỗi của tầng cache trên dashboard, và được cảnh báo khi cache backend chết, để "Redis chết = chạy chậm âm thầm" không còn xảy ra.

#### Acceptance Criteria

1. THE cả hai cache adapter SHALL emit metric qua hook interface (callback tiêm từ ngoài, vì `packages/runtime` không phụ thuộc prom-client): counter `cache_operations_total{op, result=hit|miss|error, backend}` — CMS wire hook này vào registry Prometheus sẵn có (`routes/metrics.ts:63-139` đã khai báo cache metric nhưng adapter chưa emit).
2. THE Redis adapter SHALL thôi nuốt lỗi im lặng (`docker/cache.ts:33-58`): vẫn degrade-to-null (đúng), nhưng mỗi lỗi tăng error counter + structured log có error class; log throttle để không flood khi outage kéo dài.
3. WHEN cache backend lỗi liên tục vượt ngưỡng (>50% error trong 60s), THE `/health/ready` SHALL báo degraded (đã có probe cache tại `routes/health.ts:79-80` — bổ sung trạng thái degraded thay vì chỉ ok/fail).
4. THE Grafana dashboard mẫu (`docker/grafana/`) SHALL thêm panel: cache hit-rate theo backend, cache error rate, top invalidation tags.
5. THE alert rule mẫu (Prometheus) SHALL cảnh báo khi hit-rate delivery cache < 50% kéo dài 10 phút hoặc error rate > 0 kéo dài 5 phút.

### Requirement 14: Tách worker role và leader election cho cron

**User Story:** Là operator, tôi muốn scale `cms` lên N replica mà mỗi cron chỉ chạy một lần mỗi tick và HTTP process không gánh queue consumer, để scale ngang an toàn như tài liệu deployment đã hứa (`DEPLOYMENT-CHECKLIST.md:288`).

#### Acceptance Criteria

1. THE `serve.ts` SHALL đọc `LUMIBASE_PROCESS_ROLE` (`web` | `worker` | `all`, default `all`): `web` không đăng ký node-cron + queue consumer (`serve.ts:98-207`); `worker` không listen HTTP (trừ endpoint health riêng); `all` giữ nguyên hành vi hiện tại — deploy một-container không đổi gì.
2. WHEN role bao gồm cron VÀ Redis khả dụng, THE mỗi cron tick SHALL bọc trong Leader_Lock (`SET cron-lock:{jobName} {instanceId} NX PX {ttl}`): instance không lấy được lock bỏ qua tick im lặng; TTL ≥ 2× thời gian chạy điển hình của job, có renew cho job dài.
3. WHEN Redis không khả dụng, THE cron SHALL chạy như hiện tại kèm log warn một-lần rằng multi-instance sẽ nhân bản tick (không chặn deploy đơn giản).
4. THE docker-compose SHALL có profile/ví dụ tách service: `cms-web` (scale được) + `cms-worker` (1 replica hoặc lock-guarded); `DEPLOYMENT-CHECKLIST.md` cập nhật hướng dẫn scale mới thay khuyến nghị `--scale cms=3` hiện không an toàn.
5. THE integration test SHALL chứng minh: 2 process role=all cùng Redis, sau 3 tick của một cron test, side-effect counter đúng bằng 3 (không phải 6).
6. THE BullMQ consumer SHALL giữ nguyên (đã coordinate qua Redis, xử lý once) — chỉ di chuyển nơi đăng ký theo role.

### Requirement 15: Flow và AI chat thực thi bất đồng bộ

**User Story:** Là người dùng Studio/API, tôi muốn flow dài và AI chat không giữ HTTP connection nhiều phút, để worker/isolate không bị chiếm chỗ và client có trải nghiệm trạng thái rõ ràng.

#### Acceptance Criteria

1. WHEN queue provider khả dụng, THE `POST /api/v1/flows/:id/run` SHALL enqueue flow run và trả `202 { data: { runId, status: 'queued' } }`; thực thi diễn ra ở worker (Worker_Role).
2. THE CMS SHALL expose `GET /api/v1/flows/runs/:runId` trả trạng thái + kết quả (bảng `flow_runs` mới: id nanoid, siteId, flowId, status, result jsonb, error, timestamps — mọi query mang siteId).
3. WHEN queue không khả dụng, THE flow run SHALL giữ đường synchronous hiện tại NHƯNG với ceiling tổng thời gian (`LUMIBASE_FLOW_SYNC_TIMEOUT`, default 30s) — flow vượt ceiling trả lỗi hướng dẫn bật worker; op `sleep` 60s + `http` 30s/lần không còn được phép block không giới hạn (`flow-service.ts:108-126`).
4. THE `POST /api/v1/ai/chat` SHALL hỗ trợ chế độ async tương tự (202 + poll) khi client gửi `Prefer: respond-async`; default giữ synchronous để không phá client hiện có.
5. THE Studio SHALL cập nhật Flow builder + AI panel dùng poll/SSE cho run async.
6. THE HITL semantics (non-negotiable rule #4) SHALL không đổi: skill `schema:write`/`delete*` vẫn qua `ai_approvals` bất kể sync hay async.

### Requirement 16: Tối ưu DB cho hot path

**User Story:** Là operator, tôi muốn các truy vấn nóng có index đúng và write path nguyên tử, để tải cao không sinh seq-scan và dữ liệu không commit nửa vời.

#### Acceptance Criteria

1. THE schema `items` SHALL thêm index `(site_id, collection_id, updated_at DESC)` phục vụ default sort của `list` (`buildSort`, `item-service.ts:403` — hiện không index nào phủ, `cms.ts:227-241`).
2. THE schema `items` SHALL thêm partial index phủ publish-window query của Delivery_API (`site_id, collection_id, status, publish_at, unpublish_at` WHERE `deleted_at IS NULL`) — thay thế/bổ sung `items_publish_due_idx` sau khi đo bằng `EXPLAIN ANALYZE` trên dataset mẫu ≥100k rows.
3. THE migration SHALL dùng `CREATE INDEX CONCURRENTLY` cho instance đang chạy (ghi chú trong CHANGELOG upgrade steps).
4. THE `bulk()` (`item-service.ts:1079-1097`) SHALL: (a) bọc toàn bộ batch trong một transaction Drizzle; (b) gom insert item/revision/activity thành multi-row INSERT theo chunk (≤100 rows/câu); (c) side-effect fan-out (index, realtime, revalidation) gom một lần sau commit thay vì per-item; (d) giới hạn kích thước batch (`LUMIBASE_BULK_MAX`, default 500) trả 413 khi vượt.
5. THE write path đơn lẻ (create/patch) SHALL bọc item + revision + activity trong một transaction (hiện là các await độc lập, `item-service.ts:707-733`) — audit/field-access log ở ngoài transaction (đi đường Req 11).
6. THE spec SHALL ghi nhận quyết định KHÔNG thêm expression index tự động cho `data->>field` (per-field, tuỳ dataset) — thay vào đó docs vận hành hướng dẫn operator tạo index theo field nóng của họ, kèm ví dụ SQL (`docs/en/deployment/performance.md` mới).

### Requirement 17: Chốt số phận CDC CacheInvalidator

**User Story:** Là maintainer, tôi muốn module CDC cache-invalidator hoặc hoạt động thật hoặc biến mất, để không còn code "đã viết, đã test, không chạy" gây hiểu lầm về năng lực hệ thống.

#### Acceptance Criteria

1. THE design phase SHALL chốt một trong hai phương án, ghi quyết định + lý do vào design.md §CDC:
   - **(A) Wire:** instantiate trong CDC pipeline thật; key derive PHẢI chứa siteId (hiện `config:${table}:${recordId}` không có — `cache-invalidator.ts:177-183`, vi phạm DoD 2b nếu bật); namespace key/tag khớp Cache_Provider_V2 (Req 7) để purge thứ CMS thực đọc.
   - **(B) Remove:** xoá `cache-invalidator.ts` + property test + barrel export; ghi ADR ngắn lý do (tag-based invalidation ở application layer đã phủ nhu cầu).
2. WHEN chọn (A), THE hai-site test SHALL chứng minh CDC event của site A không purge entry site B.
3. THE lựa chọn mặc định khuyến nghị là **(B)** trừ khi có yêu cầu thực về invalidation từ nguồn ghi ngoài CMS (ghi vào DB không qua API) — vì Req 8 đã phủ mọi đường ghi qua API.

### Requirement 18: Performance gate trong CI

**User Story:** Là maintainer, tôi muốn CI chặn perf regression trên các đường nóng, để thành quả của chương trình này không bị bào mòn dần theo từng PR.

#### Acceptance Criteria

1. THE k6 scenario `smoke.js` + `load-deliver.js` (Req 0.2) SHALL chạy trong CI workflow riêng (nightly hoặc label-triggered, không chặn mọi PR) trên docker-compose service, với `thresholds` k6: p95 các endpoint nóng và error rate.
2. THE thresholds SHALL đặt từ số baseline + headroom 20% (không đặt số mơ ước); vượt threshold → workflow fail + báo cáo số đo.
3. THE workflow SHALL upload kết quả (JSON summary) làm artifact để so sánh lịch sử.
4. THE docs contributing SHALL mô tả cách chạy suite local và cách cập nhật threshold khi có thay đổi hiệu năng CÓ CHỦ ĐÍCH (threshold đổi phải đi cùng PR giải thích).

### Requirement 19: Chống cache penetration trên đường đọc công khai

**User Story:** Là operator, tôi muốn request tới tài nguyên KHÔNG tồn tại bị chặn ở tầng cache/biên thay vì đi xuống Postgres mỗi lần, để một kẻ tấn công (hoặc một crawler hỏng) bắn hàng trăm nghìn slug/ID ngẫu nhiên không hạ được database dù Redis/KV vẫn khoẻ.

Ba requirement liền kề dễ nhầm — phân biệt rõ: **Req 9** xử lý *cache breakdown* (khoá nóng CÓ dữ liệu hết hạn → herd), requirement này xử lý *cache penetration* (khoá KHÔNG có dữ liệu ở cả hai tầng → cache không bao giờ được điền, nên không tầng nào hấp thụ được), **Req 12** là rate limit chung cho surface đã xác thực.

#### Acceptance Criteria

**Tầng 1 — chặn hình dạng khoá sai trước khi chạm DB**

1. WHEN một request public mang tham số định danh sai hình dạng đã biết (`site_id` không phải nanoid 21 ký tự thuộc alphabet nanoid; `slug` vượt độ dài tối đa hoặc chứa ký tự ngoài `[a-z0-9/_-]`; tên collection không khớp `^[A-Za-z_][A-Za-z0-9_]*$`), THE CMS SHALL trả 404 (không phải 400, để không tiết lộ khoá nào đúng hình dạng) mà KHÔNG thực thi bất kỳ truy vấn DB nào.
2. THE tenant middleware SHALL validate hình dạng `X-Lumi-Site` trước khi ghi vào context (`middleware/tenant.ts:25-29` hiện tin tuyệt đối giá trị header) — giá trị sai hình dạng → 400 `TENANT_INVALID`, không đi tiếp xuống chuỗi middleware.
3. THE validation SHALL là kiểm tra hình dạng thuần tuý (regex/độ dài), KHÔNG tra cứu sự tồn tại — nó là bộ lọc rẻ đứng trước cache, không thay thế tầng 2.

**Tầng 2 — negative cache entry (tombstone)**

4. THE Cache_Provider_V2 (Req 7) SHALL bổ sung một phép đọc phân biệt được ba trạng thái: *hit có giá trị*, *hit rỗng (tombstone)*, *miss*. Interface hiện tại `get<T>(key): Promise<T | null>` KHÔNG biểu diễn được trạng thái giữa — cả hai adapter trả `null` cho cả ba trường hợp (`docker/cache.ts:28-37` `val ? JSON.parse(val) : null`; `cloudflare/cache.ts:34-36` `kv.get(key,'json')`), nên hôm nay không caller nào cache được kết quả âm dù muốn.
5. WHEN một đường đọc public phân giải một định danh và DB xác nhận không tồn tại, THE CMS SHALL ghi một tombstone vào cache với TTL ngắn `LUMIBASE_NEGATIVE_CACHE_TTL` (default 30 giây) cộng jitter ngẫu nhiên ±20%, để các request lặp lại cùng khoá được trả 404 từ cache mà không chạm DB.
6. THE tombstone key SHALL mang `siteId` (non-negotiable rule #2, DoD 2b): `neg:${siteId}:${kind}:${identifier}` với `kind` ∈ `page|collection|site|item`.
7. WHEN tài nguyên tương ứng được tạo (page mới, collection mới, item mới) hoặc slug được đổi thành giá trị đang bị tombstone, THE write path SHALL xoá tombstone tương ứng sau commit, trước khi trả response — TTL ngắn ở AC-5 là lưới an toàn, không phải cơ chế chính.
8. THE tombstone SHALL KHÔNG bao giờ được serve cho request mang credentials hoặc ở chế độ preview/draft (cùng ranh giới với Req 1.4) — một item draft không nhìn thấy được ở delivery không phải là "không tồn tại".
9. WHEN cache backend không khả dụng, THE đường đọc SHALL degrade về hành vi hiện tại (query DB, trả 404 thật) — negative cache là lớp giảm tải, không được biến sự cố Redis thành sự cố API.

**Tầng 3 — giới hạn tốc độ trên đường public**

10. THE Delivery_API SHALL nằm trong phạm vi rate limit, keyed theo IP client (đường này chưa xác thực nên không có principal): `LUMIBASE_DELIVER_RATE_LIMIT` (default 1200 req/phút/IP, `0` = tắt). Điều này **sửa** quyết định "skip health/metrics/deliver" ở `tasks.md` task 13.2 và chốt open question `design.md` §21.2 theo hướng CÓ.
11. WHEN một IP vượt ngưỡng, THE CMS SHALL trả 429 kèm `Retry-After` và `Cache-Control: no-store`, và SHALL KHÔNG ghi tombstone từ request bị chặn (tránh biến rate-limit thành kênh đầu độc cache).

**Phạm vi & đo đạc**

12. THE requirement SHALL phủ tối thiểu các đường đã audit: `GET /deliver/page/:site_id/:slug` (`routes/deliver.ts:411-420`), `GET /deliver/llms.txt/:site_id` (`routes/deliver.ts:287-294`), `SchemaService.getCompiled` (`schema-service.ts:1074-1080` — miss trả `null` và không ghi gì), `ItemService.resolveCollection` (`item-service.ts:642-652` — query thẳng DB, không qua cache).
13. THE k6 suite SHALL có scenario `load-penetration.js`: 95% request mang slug/ID ngẫu nhiên không tồn tại, 5% hợp lệ; đo số DB query per request (qua query counter hoặc `pg_stat_statements`) trước/sau.
14. THE tỷ lệ DB-query-per-404 SHALL giảm xuống ≤ 0.05 (tức ≥95% request rác được hấp thụ bởi validate + tombstone) trên scenario ở AC-13, đo bằng số thực chứ không ước lượng.
15. THE cache metrics (Req 13) SHALL tách riêng counter cho tombstone: `cache_negative_hits_total`, `cache_negative_writes_total` — để operator phân biệt "cache hit vì có dữ liệu" và "cache hit vì đã biết là không có".

**Quyết định kiến trúc cần chốt**

16. THE design phase SHALL ghi rõ quyết định về Bloom filter (giải pháp kinh điển thứ hai cho penetration) — chọn hay không, kèm lý do và điều kiện tái mở. Ràng buộc bắt buộc cân nhắc: dual-runtime (RedisBloom không có trên Cloudflare KV), chi phí rebuild filter khi tạo/xoá tài nguyên, và false-positive nghĩa là vẫn phải chạm DB.

## Setup impact (rà soát sơ bộ — chốt lại khi hoàn thành, theo DoD mục 2)

Trả lời 6 câu hỏi registry (`admin-setup-wizard/setup-impact.md`):

1. **Seed mặc định?** Không — không bảng mới cần seed (bảng `flow_runs` Req 15 rỗng khi khởi tạo).
2. **Settings key/feature flag operator cần biết?** Không key trong `settings`; toàn bộ knob là **env** (`LUMIBASE_DELIVER_SMAXAGE`, `LUMIBASE_APIKEY_TOUCH_INTERVAL`, `LUMIBASE_API_RATE_LIMIT`, `LUMIBASE_PROCESS_ROLE`, `LUMIBASE_MAX_JSON_BODY`, `LUMIBASE_BULK_MAX`, `LUMIBASE_FLOW_SYNC_TIMEOUT`, `LUMIBASE_NEGATIVE_CACHE_TTL`, `LUMIBASE_DELIVER_RATE_LIMIT`) — cập nhật docs env reference.
3. **Policy/grant mặc định trong DB?** Không.
4. **Bước UI wizard mới?** Không.
5. **Capability flag mới trong `/setup/capabilities`?** Không (health/metrics đã phản ánh cache/queue availability).
6. **Backfill instance cũ?** CÓ ở Req 16: migration index mới (idempotent, `CONCURRENTLY`) — thêm upgrade note CHANGELOG. Còn lại không backfill.

→ Khi merge: thêm dòng registry trạng thái tương ứng (dự kiến `n/a` cho setup wizard, kèm ghi chú migration index).
