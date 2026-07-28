---
version: 1
lastUpdated: 2026-07-28T11:45:25.135Z
sourceLang: en
translatedFrom: en
sourceHash: 21badc3a0a607d14
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:45:25.135Z
codeVerifiedHash: 21badc3a0a607d14
codeVerifiedClaims: 52
---

# OWASP API Security Top 10 (2023) — Audit LumiBase

> **Phạm vi.** Tài liệu này map bề mặt API của LumiBase CMS với
> [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/),
> kèm bằng chứng `file:line` cụ thể, một điểm được đánh giá cho mỗi hạng mục, và
> phần khắc phục đã áp cho các khoảng trống tìm được.
>
> **Trạng thái của việc đánh giá.** Sự hiện diện của từng control bên dưới đều
> verify được từ code được dẫn. Các **điểm số theo hạng mục là một đánh giá**,
> không phải con số do OWASP hay một công cụ audit bên ngoài cấp. Các mục đánh dấu
> **[Inference]** là suy luận từ code, không phải điều code nói trực tiếp.

## Chuỗi middleware (xương sống của phần lớn các control)

Chuỗi theo từng request (`apps/cms/src/index.ts:213`):

```
withTenant → withDb → withAuth → withSiteMembership → withRateLimit
  → requireSetupComplete → withStudioAccess → withControlPlaneAccessGuard
  → withFileUploadPolicy → withRls
```

Toàn cục (trước chuỗi): `withLogger, withTracing, withSecurityHeaders, withMetrics,
withRuntime, cors, withJsonBodyLimit, withAuditContext, adminPathGuard`
(`index.ts:104-153`).

## Bảng điểm

| # | Hạng mục | Trạng thái | Điểm |
|---|----------|--------|:-----:|
| API1 | Broken Object Level Authorization (BOLA) | Đã xử lý (nhiều lớp) | 9/10 |
| API2 | Broken Authentication | Đã xử lý | 9/10 |
| API3 | Broken Object Property Level Authorization | Đã xử lý | 8.5/10 |
| API4 | Unrestricted Resource Consumption | Đã xử lý | 8/10 |
| API5 | Broken Function Level Authorization | Đã xử lý (tập trung) | 9/10 |
| API6 | Unrestricted Access to Sensitive Business Flows | Một phần | 6.5/10 |
| API7 | Server-Side Request Forgery (SSRF) | Đã xử lý | 9/10 |
| API8 | Security Misconfiguration | Đã xử lý | 9/10 |
| API9 | Improper Inventory Management | Đã xử lý (đã cải thiện) | 7.5/10 |
| API10 | Unsafe Consumption of APIs | Đã xử lý | 8/10 |

**Tổng đánh giá: ~83.5 / 100 (Hạng A−, "Strong").** API4, API7, và API9 tăng lên
sau các lần khắc phục trong changeset này (xem [Khắc phục](#các-khắc-phục-đã-áp-trong-changeset-này)).

---

## API1:2023 — Broken Object Level Authorization (BOLA)

**Trạng thái: Đã xử lý (mạnh, nhiều lớp). Điểm 9/10.**

- **Scope theo `site_id` ở tầng query** — mọi list/read đều dựng `where` của nó
  bằng `scopeSite(items.siteId, siteId)` (`services/item-service.ts:654-665`,
  `:642-651`); `scopeSite` được dùng khắp các service.
- **Postgres RLS làm lớp chốt, fail-closed** — `middleware/rls.ts:35-81` set
  `app.site_id` theo từng request và trả `503 RLS_UNAVAILABLE` nếu không set được
  scope (`:54-76`). Các policy RESTRICTIVE nằm ở
  `packages/database/migrations/rls-policies.sql`.
- **Ràng buộc membership ngăn việc nhảy tenant** — `middleware/site-membership.ts:86-98`
  yêu cầu có một row `user_sites` cho site được yêu cầu, nếu không thì
  `403 TENANT_FORBIDDEN`; API key được khớp theo site trong `withAuth`
  (`middleware/auth.ts:276-282`).
- **Rule ở mức row khi read/write** — `permission-service.ts` `whereFor(perm)`
  chèn một WHERE clause theo permission (`item-service.ts:657`); `matches()`
  validate các snapshot create/patch (`item-service.ts:779-781`).
- **Tests** — `apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`;
  ma trận ở `docs/vi/security/idor-testing.md`.

Còn lại: RLS bị bỏ qua trong development (`rls.ts:43-45`), nên các đường chỉ có ở
dev thiếu lớp chốt ở DB. [Inference] các service không phải `ItemService` phải tự
áp `scopeSite`; RLS là lớp chốt ở production cho mọi trường hợp bỏ sót.

## API2:2023 — Broken Authentication

**Trạng thái: Đã xử lý (mạnh). Điểm 9/10.**

- **Nhiều scheme đã được verify** — Cloudflare Access RS256 được verify với JWKS
  từ xa rồi **map lại thành một DB user + site role** thay vì tin vào assertion
  của edge (`middleware/auth.ts:187-245`, CWE-302); HS256 custom có ghim audience
  vào realm `studio`/`frontend` (`:53-61`); API-key qua tra cứu hash SHA-256
  (`:262-268`).
- **Thu hồi token** — `tokenVersion` trong JWT phải khớp `users.tokenVersion`;
  việc đổi/reset password nâng nó lên (`auth.ts:408-417`, `routes/auth.ts:216-217`).
- **Xử lý password** — PBKDF2-SHA256, 100k iteration, salt 16 byte
  (`services/auth/password.ts:19-22`); policy 12+ ký tự qua `PasswordSchema` dùng
  chung (`packages/shared/src/schemas/password.ts:12-28`).
- **Chống brute-force/lockout** — limiter theo IP dựa trên Postgres + lockout
  account (`modules/login-guard/`), làm chặt chống liệt kê qua việc chuẩn hoá
  email + thời gian phản hồi đồng nhất.
- **Đường bypass dev-auth bị gate ba lớp** vào một runtime development
  (`auth.ts:145-156`).
- **Issuer JWT bên ngoài** — `modules/external-auth/verifier.ts` từ chối
  `alg:none`/HS*, enforce một allowlist thuật toán theo issuer trước khi verify
  (`:142-152`).

Còn lại: limiter cho recovery nằm in-memory theo từng process; không có CAPTCHA
(xem API6).

## API3:2023 — Broken Object Property Level Authorization

**Trạng thái: Đã xử lý (mạnh). Điểm 8.5/10.**

- **Chống mass-assignment** — `assertWritablePermissionFields`
  (`item-service.ts:2017-2040`) throw `403` cho mọi field ngoài tập được phép của
  permission; được gọi trong `create` (`:765`) và `patch` (`:860`).
- **Mask khi đọc ở mức field** — `permission-service.ts:209-217` `maskItem` /
  `applyFieldMask`; dùng ở list (`item-service.ts:691-692`), get one (`:740`), và
  relation expansion (`:1438-1442`).
- **Realtime/CDC tôn trọng việc mask** — subscriber đọc lại qua đường đã mask,
  không bao giờ dùng `row.data` (`item-service.ts:1531-1551`).
- **Validate input** — Zod theo compiled schema (`services/validation.ts`,
  `item-service.ts:1038`); redact secret của settings khi đọc (`routes/settings.ts`).

Còn lại (được chấp nhận): với một role full-access (`perm.fields = ['*']`),
`assertWritablePermissionFields` short-circuit (`item-service.ts:2023`) và tầng
Zod không `.strict()`-từ chối các key lạ, nên key tuỳ ý sẽ vào cột JSON `data`.
Đây là chủ ý — cột `data` linh hoạt về schema theo thiết kế, và allowlist field-mask
chi phối mọi role không phải `*`.

## API4:2023 — Unrestricted Resource Consumption

**Trạng thái: Đã xử lý. Điểm 8/10 (trước là 7.5 — xem phần khắc phục).**

- **Rate limit API chung** — `middleware/rate-limit.ts`, cửa sổ cố định mặc định
  300 req/60s, key theo principal, nếu không thì theo IP, **scope theo từng site**,
  `429` + `X-RateLimit-*`/`Retry-After`.
- **Cap body JSON** — `middleware/body-limit.ts`, mặc định 1 MiB, `413`.
- **Clamp phân trang** — `item-service.ts:667` `min(limit ?? 25, 200)`; filter
  clause ≤100, độ sâu path ≤8.
- **Giới hạn depth + cost của GraphQL** — depth ≤12 + giới hạn cost tĩnh (mặc định
  1000), tắt introspection ở prod (`graphql/yoga.ts`).
- **Cap upload file** — `middleware/file-upload-policy.ts` (mặc định 10 MiB).
- **Budget/backpressure cho AI khi ghi** — `services/load-guard-service.ts`.

Khắc phục đã áp: throttle chung trước đây **fail open** vô điều kiện khi cache
không sẵn sàng. Giờ nó hỗ trợ một chế độ fail-closed
(`LUMIBASE_RATE_LIMIT_FAIL_CLOSED='true'` → `503 RATE_LIMIT_UNAVAILABLE`) cho các
bản deploy đã làm chặt, đồng thời giữ fail-open làm mặc định an toàn để một lần
cache mất kết nối không bao giờ làm sập API.

Còn lại: throttle vẫn không atomic (read-modify-write); quota chính xác theo từng
endpoint cần một counter atomic (Durable Object / Redis `INCR`).

## API5:2023 — Broken Function Level Authorization

**Trạng thái: Đã xử lý (mạnh, tập trung). Điểm 9/10.**

- **Guard control-plane tập trung** — `middleware/control-plane-access-guard.ts:5-24`
  đòi một principal admin cho một danh sách `CONTROL_PLANE_PATHS` tường minh
  (`/access`, `/api-keys`, `/admin`, `/agent`, `/cdc`, `/flows`, …) kể cả khi một
  route quên kiểm tra riêng của nó; các lần từ chối đều được audit
  (`control_plane_access_denied`).
- **Tường studio-access** — `middleware/studio-access.ts`; một token `frontend`
  (subscriber) không bao giờ tới được bề mặt Studio (`:75-80`, ADR-011).
- **Engine RBAC** — `services/permission-service.ts:184-199,406-422` compile các
  permission theo (collection, action) kèm invalidate cache.
- **Guard theo từng route xếp lớp lên trên** — `requireSiteAdmin`,
  `requireSchemaPermission`, `adminOnly`.
- **Test tripwire** — `apps/cms/src/__tests__/security-guards.wiring.test.ts`
  assert thứ tự chuỗi + độ phủ control-plane.

Còn lại: [Inference] `isAdminPrincipal` khớp các role key `'admin'`/
`'administrator'` (`control-plane-access-guard.ts:65`); một role custom tương
đương admin nhưng có key khác sẽ phụ thuộc vào kiểm tra permission của chính route.

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**Trạng thái: Một phần. Điểm 6.5/10.**

Mạnh với các flow AI/agent:

- **HITL approval** — `services/ai-harness.ts` buộc các skill write/delete và
  control-plane đi qua approval (`:202-215`); status `pending_approval`
  (`:53-62`).
- **Cap cho hành động không thể hoàn tác** — `IRREVERSIBLE_SKILLS` bị cap cứng ở
  autonomy L2 (`ai-harness.ts:222-230`).
- **Gradient autonomy + kill switch + cửa sổ veto** — `AutonomyService`,
  `KillSwitchService`, `VetoService`, `load-guard-service`.
- **Phanh cho luồng setup** — 10 req/60s trên `/setup/complete` +
  `SELECT … FOR UPDATE` singleton cho admin đầu tiên.
- **Guard admin-path** — 404 không phân biệt được về byte/thời gian
  (`admin-path-guard.ts:248-292`).

Còn lại (được chấp nhận, giao lên tầng trên): **không có CAPTCHA / phát hiện bot /
device fingerprint**. Đây là một quyết định kiến trúc có chủ đích — trên Cloudflare
Workers, việc giảm thiểu volumetric/bot do edge Cloudflare (WAF, Turnstile, Bot
Management) đảm nhận; trên Docker, cửa trước Caddy đảm nhận giới hạn kết nối. Tầng
ứng dụng tập trung vào brute-force, anomaly (`modules/anomaly/detector.ts`), và
lạm dụng ở mức business. Không có limiter chống lạm dụng tổng quát theo từng flow
ngoài `withRateLimit` ở mức thô.

## API7:2023 — Server-Side Request Forgery (SSRF)

**Trạng thái: Đã xử lý (mạnh). Điểm 9/10 (trước là 8 — xem phần khắc phục).**

- **Guard tập trung** — `services/ssrf-guard.ts` `validateOutboundUrl` chặn các
  protocol không phải http(s), credential nhúng trong URL,
  `localhost`/`.localhost`, các host bị chặn tường minh + IP metadata
  (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`), và
  RFC1918/loopback/link-local qua `isPrivateOrLoopback`.
- **Được áp ở mọi sink nhận URL từ người dùng** — bộ gửi webhook CDC
  (`modules/cdc/change-feed/webhook-sender.ts`), `revalidation.ts`,
  `flow-service.ts`, `extension-verifier.ts`, `extensions/sandbox.ts`, các
  deployment provider, `domains/cloudflare-saas.ts`.
- **Tests** — `services/__tests__/ssrf-guard.test.ts`.

Khắc phục đã áp: guard trước đây chỉ validate **chuỗi hostname** và không bắt được
DNS-rebinding (một tên công khai resolve về một IP private). Đã thêm
`resolveAndValidateOutboundUrl()`, nối vào `guardedFetch()`, hàm này resolve
hostname rồi kiểm tra lại **mọi IP đã resolve** theo các dải bị chặn/private. Việc
resolve dùng một resolver `node:dns` load lười trên Node và bị bỏ qua trên Workers
(mặc định là best-effort; `requireDnsResolution` fail closed khi không resolve
được). Resolver có thể inject để test.

Còn lại: trên Workers, việc resolve DNS không có ở tầng app, nên phòng thủ chống
rebinding ở đó dựa vào edge; các kiểm tra theo chuỗi ký tự vẫn áp ở mọi nơi.

## API8:2023 — Security Misconfiguration

**Trạng thái: Đã xử lý (mạnh). Điểm 9/10.**

- **CORS có credential và không bao giờ wildcard** — `config/cors.ts:37-55`
  `resolveCorsOrigin` tôn trọng một allowlist khớp chính xác, bỏ qua `*` với các
  response có credential (`:43-45`, CWE-942); production mà không khớp → bị từ chối.
- **Security header trên mọi response** — `middleware/security-headers.ts:23-32`
  CSP hạn chế (`default-src 'none'`, `frame-ancestors 'none'`), `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP.
- **Xử lý lỗi an toàn** — `onError` toàn cục trả về `INTERNAL` chung + requestId
  (`index.ts:375-382`); lỗi auth trả về code chung khi hướng ra ngoài.
- **Làm chặt ở prod** — tắt introspection GraphQL ở production; enforce
  `METRICS_TOKEN` khi đã đặt; làm mờ admin-path kèm 404 không phân biệt được.

Còn lại: [Inference] không có HSTS ở tầng app (khả năng được kết thúc ở
Caddy/Cloudflare — hãy xác nhận theo từng bản deploy); CSP mặc định cho phép
`style-src 'unsafe-inline'`.

## API9:2023 — Improper Inventory Management

**Trạng thái: Đã xử lý (đã cải thiện). Điểm 7.5/10 (trước là 6.5 — xem phần khắc phục).**

- **Versioning nhất quán** — mọi bề mặt nằm dưới `/api/v1` (`index.ts:156-364`).
- **Spec/docs** — `docs/vi/api/hono-api-spec.md`, `graphql-api-spec.md`; service/route
  typegen; OpenAPI 3.1.0 sinh theo yêu cầu từ schema đang chạy
  (`ai-harness.ts:981-1054`).
- **Bề mặt public so với đã xác thực được liệt kê và ghi chú** trong `index.ts`
  (`:155-370`) — một bản kiểm kê trên thực tế cho các endpoint không xác thực.

Khắc phục đã áp:
1. **Endpoint debug không còn tới được ở production** — sân chơi auth `/test-auth`
   giờ trả về một `404` không phân biệt được khi runtime là production
   (`routes/test-auth.ts`), đóng lại một điểm phơi endpoint shadow/debug.
2. **Cơ chế báo hiệu deprecation** — `middleware/deprecation.ts`
   (`withDeprecation`) phát ra header `Deprecation`/`Sunset` theo RFC 8594 cộng một
   `Link rel="deprecation"`, nên khi cho một endpoint về hưu thì consumer có một
   cửa sổ cảnh báo dạng máy đọc được.

Còn lại: chưa có một artifact OpenAPI/AsyncAPI dạng máy đọc được duy nhất bao phủ
toàn bộ bề mặt REST và được commit vào repo (OpenAPI được sinh theo yêu cầu). Một
spec có version, được commit, sẽ làm mạnh thêm việc quản lý kiểm kê.

## API10:2023 — Unsafe Consumption of APIs

**Trạng thái: Đã xử lý. Điểm 8/10.**

- **Verify JWT bên thứ ba một cách chặt chẽ** — `modules/external-auth/verifier.ts`
  (verify bằng JWKS công khai, từ chối `alg:none`/HS*, allowlist thuật toán theo
  từng issuer trước khi verify `:142-152`, ràng buộc audience + issuer theo site,
  fail-closed).
- **Output của AI/LLM được coi là không tin cậy** — `ai-harness.ts` `extractJson`
  fail cứng `LLM_INVALID_JSON` với dữ liệu không phải JSON (`:158-177`); các skill
  sinh nội dung validate/định hình kết quả trước khi dùng (`:836-846`, `:894-897`,
  `:1093-1099`).
- **Các lệnh gọi ra bên thứ ba đều đi qua `guardedFetch`** — cùng guard SSRF (giờ
  đã nhận biết DNS-rebinding) bảo vệ khỏi các host độc hại/hay redirect.
- **Import config được validate bằng Zod** trước khi apply (`config-import-service.ts`).
- **Bundle extension** — allowlist `EXTENSION_BUNDLE_ORIGINS` + guard SSRF +
  timeout, được verify trong sandbox.

Còn lại: [Inference] các kiểm tra hình dạng ở phía sau với output của model là
theo từng skill và mức độ chặt chẽ khác nhau; chưa có một đảm bảo ở mức schema
rằng mọi response từ bên thứ ba/AI đều được validate theo một response schema đã
khai báo trước khi lưu.

---

## Các khắc phục đã áp trong changeset này

| Hạng mục | Khoảng trống | Cách sửa | Bằng chứng |
|----------|-----|-----|----------|
| API4 | Throttle fail open vô điều kiện | Chế độ fail-closed cấu hình được (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED`) → `503 RATE_LIMIT_UNAVAILABLE` | `middleware/rate-limit.ts`, `env.ts`, `middleware/__tests__/rate-limit.test.ts` |
| API7 | Guard SSRF chỉ validate chuỗi hostname (không phòng thủ DNS-rebinding) | `resolveAndValidateOutboundUrl()` resolve DNS và kiểm tra lại mọi IP đã resolve; nối vào `guardedFetch()` | `services/ssrf-guard.ts`, `services/__tests__/ssrf-guard.test.ts` |
| API9 | Bề mặt debug `/test-auth` mount được ở production | `404` không phân biệt được ở production | `routes/test-auth.ts` |
| API9 | Chưa có cơ chế deprecation cho endpoint | Middleware `withDeprecation` (RFC 8594 `Deprecation`/`Sunset`/`Link`) | `middleware/deprecation.ts`, `middleware/__tests__/deprecation.test.ts` |
| API7/API8 | Các dependency có lỗ hổng đã biết bị cổng audit của CI phát hiện (Next.js SSRF/DoS/bypass middleware, `sharp`, `fast-uri`) — đã tồn tại từ trước, nằm ở các frontend app (`landing`/`consumer`) và ở dạng chuyển tiếp, **không** nằm trên đường API của CMS | Nâng `next` → `16.2.11`; `overrides` của pnpm cho `fast-uri >=3.1.4` và `sharp >=0.35.0`. `pnpm audit --prod --audit-level high` giờ đã pass | `package.json`, `apps/{consumer,landing}/package.json`, `pnpm-lock.yaml` |

> **Lưu ý về row dependency-audit.** Việc `pnpm audit --prod --audit-level high`
> pass không chỉ đến từ các lần nâng version: `package.json` ở gốc còn mang
> `pnpm.auditConfig.ignoreGhsas` với `GHSA-qwww-vcr4-c8h2`, tức là **triệt tiêu**
> advisory đó thay vì khắc phục nó. Hãy coi đó là một residual được chấp nhận và
> có hạn, không phải một bản sửa — hãy kiểm tra lại xem đã có bản upgrade không
> gây phá vỡ nào xuất hiện chưa.

## Các residual được chấp nhận (không sửa ở đây — có chủ đích)

- **API6 — CAPTCHA / phát hiện bot:** giao cho edge Cloudflare (Workers) / cửa
  trước Caddy (Docker); tầng app đảm nhận brute-force, anomaly, và các control ở
  mức business flow. Xem `anti-abuse.md`.
- **API3 — key lạ với các role có field `*`:** cột JSON `data` linh hoạt về schema
  theo thiết kế; allowlist field-mask chi phối mọi role không phải `*`.
- **API4 — counter throttle không atomic:** chấp nhận được cho một lưới an toàn
  nhiều lớp; quota chính xác cần một counter atomic.
- **API9 — chưa có artifact OpenAPI được commit:** spec được sinh theo yêu cầu từ
  schema đang chạy.

## Tài liệu liên quan

- `docs/vi/security/anti-abuse.md` — registry control + bảng khoảng trống
- `docs/vi/security/route-guards.md` — chuỗi guard + lịch sử sự cố BFLA
- `docs/vi/security/idor-testing.md` — ma trận test BOLA/IDOR
- `docs/vi/security/cwe-top-100-audit.md` — bảng điểm CWE → `file:line`
- `docs/vi/security/external-jwt-auth.md` — verify issuer bên thứ ba
