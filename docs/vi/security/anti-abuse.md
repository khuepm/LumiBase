---
<!-- check-parity: allow inline-code -->
version: 1
lastUpdated: 2026-08-02T19:21:22.765Z
sourceLang: en
translatedFrom: en
sourceHash: e1112e0c60482f60
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:21:22.765Z
codeVerifiedHash: e1112e0c60482f60
codeVerifiedClaims: 70
---

<!-- check-parity: allow inline-code -->

# Anti-Abuse Mechanisms & Best Practices

## Tổng quan

Tài liệu này là tham chiếu duy nhất về cách LumiBase phòng chống lạm dụng —
brute-force, credential stuffing, dò tồn tại (enumeration), vắt kiệt tài nguyên,
SSRF, truy cập chéo tenant, và agent AI mất kiểm soát. LumiBase có sẵn nhiều cơ
chế nằm rải rác ở middleware, module và service. Mục tiêu ở đây là (1) lập bản đồ
những gì đã có và nằm ở đâu, (2) nêu best practice mà mỗi cơ chế thể hiện để code
mới đi theo cùng một pattern, và (3) liệt kê các khoảng trống (gap) để chúng được
lựa chọn có chủ đích, không phải do sơ suất.

Về thiết kế guard runtime sâu hơn và bản audit ánh xạ CWE, xem các tài liệu đồng
hành được cross-link ở phần "Tài liệu liên quan" — trang này giữ ở tầng bản
đồ/best-practice và không lặp lại chi tiết của chúng.

Nguyên tắc dẫn dắt là **defense-in-depth** (phòng thủ nhiều lớp): không lớp nào
được tin là đủ. Mỗi lớp đều giả định lớp phía trước nó có thể bị vượt qua.

## Mô hình phân lớp

```
┌─ Upstream (CDN / WAF) ──────── DDoS, IP reputation, chống bot (Cloudflare / Caddy)
│
├─ Middleware ───────────────── security headers, body limit, rate limit chung,
│    apps/cms/src/middleware/     control-plane guard, file-upload policy
│
├─ App logic ────────────────── login-guard, chấm điểm anomaly, giới hạn recovery,
│    apps/cms/src/modules/        AI load-guard, SSRF guard, GraphQL depth limit
│    apps/cms/src/services/
│
├─ Database (RLS) ───────────── cô lập theo tenant ở tầng row, WITH CHECK khi ghi
│    packages/database/migrations/rls-policies.sql
│
└─ Audit ────────────────────── ghi vết mọi quyết định bảo mật (deny/lock/block/
     apps/cms/src/modules/audit/    anomaly), mask secret, không bao giờ throw
```

Tầng ứng dụng lo brute-force, anomaly và lạm dụng ở tầng nghiệp vụ. DDoS thể tích
và chống bot chung được kỳ vọng xử lý ở upstream (xem phần Khoảng trống & khuyến
nghị bên dưới).

## Cơ chế hiện có (registry)

### 1. Rate limiting & phòng brute-force

**Best practice:** giới hạn theo nhiều key (IP *và* tài khoản), trả `429`/`423`
kèm `Retry-After`, và không bao giờ để một request bị từ chối kéo dài cửa sổ.

- **Giới hạn login theo IP** — `apps/cms/src/modules/login-guard/counter.ts` đếm
  các row `result='fail'` trong `login_attempts` qua `lockoutWindowSeconds`. Nó
  **dùng Postgres** (`PostgresCounterStore`), nên cửa sổ trượt được **chia sẻ**
  giữa các process và Workers isolate. Ngưỡng có floor cứng là 3
  (`Math.max(3, policy.ipMaxFailedAttempts)`, xem `login-guard/middleware.ts`);
  vượt ngưỡng trả `429 IP_BLOCKED` kèm `Retry-After` bị chặn trên bởi
  `ipLockoutDurationSeconds`.
- **Khóa tài khoản** — `apps/cms/src/modules/login-guard/middleware.ts` chặn
  login khi `users.lockedUntil > now()` và trả `423 ACCOUNT_LOCKED`.
- **Giới hạn recovery** — `apps/cms/src/modules/recovery/rate-limit.ts` áp ngân
  sách **dùng chung** 3 request / IP / giờ cho *cả* `/recover` lẫn `/forgot-path`
  (key theo IP đơn thuần, nên kẻ tấn công không thể nhân đôi ngân sách bằng cách
  chia đều qua hai path). Cửa sổ cố định; `Retry-After` giảm đơn điệu. Limiter này
  **in-memory theo từng process** (xem phần Khoảng trống & khuyến nghị bên dưới).
- **Brake cho setup** — bề mặt setup công khai (mount *trước* auth, chỉ truy cập
  được khi chưa khởi tạo) bị throttle theo IP trong
  `apps/cms/src/modules/setup/routes.ts`: `GET /setup/state` ở 60 req / 60 s, và
  `POST /setup/complete` ở **10 req / 60 s** trên bucket riêng. Brake của
  `/complete` chạy *trước* khi parse body hay hash mật khẩu, nên nó chặn
  brute-force `setupToken` và spam CPU-hashing trong cửa sổ bootstrap với chi phí
  bằng 0 cho mỗi request bị chặn. Trả `429 RATE_LIMITED` + `Retry-After`. Hàng rào
  cứng chống tạo trùng admin đầu tiên vẫn là `SELECT … FOR UPDATE` trên singleton
  `system_state` cộng unique index — brake này là defence-in-depth. Nó **in-memory
  theo từng isolate** (xem phần Khoảng trống & khuyến nghị bên dưới).
- **Throttle API chung** — `apps/cms/src/middleware/rate-limit.ts`
  (`withRateLimit`) là một lưới an toàn cửa sổ-cố-định thô trên bề mặt REST/GraphQL
  đã xác thực: mặc định 300 req / 60 s (`LUMIBASE_RATE_LIMIT_MAX` / `_WINDOW_S`),
  key theo principal (`userId`/`apiKeyId`) hoặc IP, **scope theo site** nên một
  tenant không thể vắt cạn ngân sách của tenant khác. Trả `429 RATE_LIMITED` kèm
  header `X-RateLimit-*`. Dựa trên runtime cache (KV trên Workers); nó **fail
  open** và không phải quota chính xác.
- **Policy** — ngưỡng login nằm trong bảng `settings` (`login_security_policy`)
  với fallback `STANDARD_LOCKOUT_POLICY`, nên operator chỉnh giới hạn mà không cần
  redeploy.

### 2. Chống enumeration & timing

**Best practice:** phản hồi giống nhau về hình dạng lẫn thời gian bất kể tài khoản
tồn tại hay không; chuẩn hóa định danh trước khi tra cứu.

- `apps/cms/src/modules/login-guard/email-normalize.ts` trim + lowercase email để
  `Foo@Bar` và `foo@bar` dùng chung một bộ đếm và một đường tra cứu.
- Login guard giữ timing tra cứu đồng nhất bất kể email tồn tại hay không (xem
  field policy `loginStallMs` cho phần stall cấu hình được).

### 3. Phát hiện bất thường (anomaly)

**Best practice:** chấm điểm hành vi trên nhiều trục độc lập, gate bằng giai đoạn
**warmup** để tránh false positive khi dữ liệu thưa, và cho operator tắt từng trục.

- `apps/cms/src/modules/anomaly/detector.ts` tổng hợp `max(geo, time, device)`
  (làm tròn 2 chữ số) với warmup OR-fold: nếu *bất kỳ* trục nào còn warmup thì bỏ
  qua hành động theo ngưỡng.
- `geo.ts` (tra MaxMind, timeout 2 giây, bỏ qua IP private/loopback),
  `time.ts` (histogram giờ UTC), `device.ts` (fingerprint User-Agent).
- `private-ip.ts` phân loại IP không định tuyến (RFC 1918, loopback, link-local,
  ULA) bằng so khớp prefix rẻ — được SSRF guard tái dùng.
- Kết quả lưu vào `login_attempts` (`anomalyScore`, `anomalyTriggered`,
  `baselineWarmup`); baseline nằm ở `login_baselines`.

### 4. Control-plane & route guard

**Best practice:** gate các bề mặt quản trị tập trung, để một route lỡ quên kiểm
tra role của chính nó vẫn không thể bị non-admin tiếp cận.

- `apps/cms/src/middleware/control-plane-access-guard.ts`
  (`withControlPlaneAccessGuard`) yêu cầu principal admin cho các path control-plane
  (`/settings`, `/roles`, `/policies`, `/permissions`, `/users`, `/teams`,
  `/api-keys`, `/admin`, `/agent`, `/cdc`, `/flows`, `/integrations/git`,
  `/materialize`), ghi audit `control_plane_access_denied` khi từ chối.
- `apps/cms/src/middleware/admin-path-guard.ts` enforce private admin path;
  `apps/cms/src/routes/admin-security.ts` cung cấp bề mặt security-audit.
- **Siết settings** — `apps/cms/src/routes/settings.ts` gate `POST`/`DELETE` bằng
  `requireSiteAdmin()` và redact các field trông giống secret (`redactSecrets`)
  khi đọc, nên member không thể ghi key tùy ý hay đọc secret đã lưu.
- Xem **[route-guards.md](./route-guards.md)** và
  **[runtime-security-guards-plan.md](./runtime-security-guards-plan.md)** cho toàn
  bộ danh mục guard và thứ tự mount trong pipeline.

### 5. Cô lập tenant ở tầng database

**Best practice:** đừng chỉ dựa vào bộ lọc `site_id` ở tầng ứng dụng — enforce cô
lập trong database để một `.where()` bị thiếu không làm rò rỉ dữ liệu.

- `packages/database/migrations/rls-policies.sql` áp các policy row-level-security
  RESTRICTIVE (`site_id = app_site_id()`) kèm `WITH CHECK` khi ghi. Request bind
  `SET LOCAL app.site_id` mỗi request.
- Tầng ứng dụng bổ sung việc scope mọi query theo `siteId` (`CLAUDE.md` quy tắc
  bất di bất dịch #2) — defense-in-depth chồng trên RLS.
- Xem **[idor-testing.md](./idor-testing.md)** cho ma trận test chéo tenant (IDOR).

### 6. Giới hạn tài nguyên request

**Best practice:** giới hạn kích thước và độ phức tạp *trước khi* xử lý.

- **Cap body JSON** — `apps/cms/src/middleware/body-limit.ts` (`withJsonBodyLimit`)
  từ chối request JSON mutating vượt 1 MiB (`LUMIBASE_MAX_JSON_BODY`) với
  `413 PAYLOAD_TOO_LARGE`, kiểm tra trên `Content-Length` trước khi đọc body. Đây
  là "thắt lưng" bổ trợ cho "dây đeo quần" Caddy `request_body max_size` ở upstream.
- **GraphQL depth & cost** — `apps/cms/src/graphql/yoga.ts` chặn độ sâu lồng nhau
  của field ở `MAX_QUERY_DEPTH = 12` (`depthLimitRule`) *và* chi phí query tĩnh ở
  `LUMIBASE_GQL_MAX_COST` (mặc định 1000, `costLimitRule`). Chi phí bắt các query
  nông-nhưng-rộng mà riêng độ sâu bỏ lọt — nhiều field song song, `limit` lớn, hoặc
  một field bị alias lặp lại — tính mỗi field 1 điểm và nhân subtree của một list
  với argument phân trang (`LUMIBASE_GQL_DEFAULT_LIST_SIZE` khi vắng mặt/variable,
  clamp về `LUMIBASE_GQL_MAX_LIST_MULTIPLIER`). Cả hai chạy ở mọi môi trường,
  validate trước mọi resolver; introspection bị tắt khi `LUMIBASE_ENV` là
  `production`. Xem [`graphql-api-spec.md`](../api/graphql-api-spec.md#chống-lạm-dụng).
- **Phân trang** — các query list clamp kích thước trang (vd
  `Math.min(params.limit ?? 25, 200)` trong `item-service.ts`; `PANEL_MAX_LIMIT`,
  CDC feed `max(500)`), nên caller không thể yêu cầu trang không giới hạn.
- **Upload file** — `apps/cms/src/middleware/file-upload-policy.ts` phủ cả tạo
  metadata (`POST /files`) lẫn upload byte thô (`PUT /files/upload/*`,
  `POST /media/:key`). Nó enforce cap 10 MB mặc định trên bytes **thật**, allowlist
  MIME, validate nội dung theo magic-byte, từ chối lệch đuôi/MIME, chặn active
  content trong SVG, và deep-scan polyglot (`imageHasEmbeddedActivePayload` →
  `UPLOAD_EMBEDDED_PAYLOAD`). Principal public bị từ chối; mọi lần từ chối được
  audit. Giới hạn cấu hình được **per-site** qua settings key `upload_policy`
  (Studio → Settings → Uploads), fallback về env rồi default.

### 7. Header cho bề mặt trình duyệt

**Best practice:** gửi các security header thận trọng mặc định trên mọi response.

- `apps/cms/src/middleware/security-headers.ts` (`withSecurityHeaders`) gắn CSP
  hạn chế (`default-src 'none'`, `frame-ancestors 'none'`, …),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` thận trọng, cùng
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy`.

### 8. Chống SSRF & open-redirect

**Best practice:** validate mọi URL outbound do người dùng cung cấp; chặn target
private/loopback/metadata; whitelist protocol; từ chối credential nhúng.

- `apps/cms/src/services/ssrf-guard.ts` cung cấp `validateOutboundUrl()` và wrapper
  `guardedFetch()`. Nó chặn `localhost`/`.localhost`, dải RFC 1918 / link-local /
  loopback, endpoint metadata cloud (`169.254.169.254`, `100.100.100.200`,
  `metadata.google.internal`), URL `user:pass@`, và mọi protocol ngoài
  `http`/`https`.
- **Quy tắc:** mọi tính năng fetch URL do người dùng cung cấp (import, webhook,
  fetch avatar, …) phải đi qua `guardedFetch()` / `validateOutboundUrl()`.

### 9. Quản trị agent AI

**Best practice:** giới hạn những gì agent tự động được làm — ngân sách ghi,
coalescing, backpressure, và phê duyệt của con người cho hành động nguy hiểm.

- `apps/cms/src/services/load-guard-service.ts` cung cấp `WriteRateLimiter`
  per-intent (writes/phút), write coalescing (nhiều write → một lần invalidate
  cache), và backpressure tạm dừng các run gốc-reconciler khi event-loop quá tải —
  nhưng không bao giờ tự dừng việc do con người kích hoạt.
- **HITL** — theo `CLAUDE.md` quy tắc #4, mọi skill có capability `schema:write`
  hoặc tên bắt đầu bằng `delete` phải tạo row `ai_approvals` trước.

### 10. Ghi log audit

**Best practice:** ghi mọi quyết định bảo mật, mask secret, không bao giờ throw,
và giới hạn độ trễ ghi.

- `apps/cms/src/modules/audit/logger.ts` là writer đồng bộ, mask secret, không bao
  giờ throw vào `audit_log`, đua INSERT với `DEFAULT_BUDGET_MS = 1000`; khi timeout
  nó emit fallback có cấu trúc ra `console.error`. Nó phủ các event code như
  `login_failed`, `user_locked`, `ip_blocked`, `anomaly_triggered`,
  `control_plane_access_denied`, `file_upload_policy_denied`.
- `apps/cms/src/middleware/security-audit.ts` (`auditSecurityGuardDenied`) là helper
  dùng chung mà các guard gọi khi từ chối; tab **Security audit** của Studio hiển
  thị vết này.
- `apps/cms/src/modules/audit/routes.ts` cung cấp API đọc phân trang cursor và
  export NDJSON cap ở `EXPORT_MAX_ROWS = 100_000` (`413 EXPORT_TOO_LARGE`
  pre-flight), admin-gated.

## Best practices chung (checklist cho code mới)

Khi thêm một endpoint, skill, hay tính năng fetch mới, hãy áp dụng:

1. **Rate-limit theo đúng key.** Endpoint nhạy cảm về auth giới hạn theo IP *và*
   danh tính. Tái dùng pattern `login-guard`/`recovery` và throttle chung
   `withRateLimit`; đừng chế ra một dạng limiter mới.
2. **Trả `429`/`423` kèm `Retry-After`**, và không bao giờ kéo dài cửa sổ trên một
   request bị từ chối.
3. **Phản hồi đồng nhất** cho các kiểm tra tồn tại (login, recovery, mời user) để
   chống enumeration; chuẩn hóa định danh trước.
4. **Luôn scope theo `site_id`** và dựa RLS làm backstop. Bảng domain mới cần
   policy RLS trong `rls-policies.sql`.
5. **Đặt bề mặt admin sau control-plane guard** — đừng chỉ dựa vào kiểm tra role
   của riêng route.
6. **HITL cho hành động AI nguy hiểm** (`schema:write` / `delete*`) → `ai_approvals`.
7. **Audit mọi lần từ chối/khóa/chặn** qua `auditSecurityGuardDenied` / logger
   `audit` — đừng bao giờ `throw` từ đường audit.
8. **Đưa fetch outbound qua `guardedFetch()`** — đừng gọi `fetch()` trực tiếp trên
   URL do người dùng cung cấp.
9. **Giới hạn kích thước và độ phức tạp trước khi xử lý** (body size, depth,
   page size).

## Khoảng trống & khuyến nghị

Các hạn chế hiện tại, đại khái theo mức ưu tiên. Được ghi lại để đánh đổi rõ ràng —
không phải tất cả đều là bug; một số cố ý ủy thác cho upstream.

| Ưu tiên | Khoảng trống | Khuyến nghị |
|---|---|---|
| Trung bình | **Recovery limiter** (`recovery/rate-limit.ts`) in-memory theo process — không chia sẻ giữa Workers isolate / nhiều Node process | Hậu thuẫn bằng store dùng chung (Redis qua `LUMIBASE_REDIS_URL`, hoặc counter dựa DB như login limiter Postgres-backed). Interface `CounterStore` đã có; `RedisCounterStore` nằm trong kế hoạch (Phase C+) |
| Trung bình | Throttle API chung **thô và không nguyên tử** (read-modify-write có thể đếm hụt khi concurrency cao) và fail open | Chấp nhận được như lưới an toàn; muốn quota per-endpoint chính xác thì dùng counter nguyên tử (Durable Object / Redis `INCR`) |
| Trung bình | Không có IP allowlist/blocklist, không CAPTCHA / chống bot | Ủy thác cho WAF upstream (Cloudflare) ở production; cân nhắc CAPTCHA trên các endpoint nhạy cảm nhất |
| Thấp | API key hỗ trợ hết hạn + thu hồi (`api_keys.expiresAt` / `revokedAt`) nhưng **không** có policy xoay khóa bắt buộc | Thêm policy rotation / nhắc hết hạn nếu compliance yêu cầu |
| Thấp | Kênh realtime có read-gate khi subscribe và field masking nhưng **không** rate-limit per-connection | Thêm limiter per-connection cho tầng realtime |

> **Ghi chú triển khai (suy luận, dựa trên kiến trúc dual-runtime):** trên
> Cloudflare Workers, DDoS thể tích, chống bot chung và IP reputation nên xử lý ở
> edge (Cloudflare); trên Docker, cửa trước Caddy lo giới hạn body và connection.
> Tầng ứng dụng tập trung vào brute-force, anomaly và lạm dụng nghiệp vụ. Hãy xác
> nhận cấu hình edge thực tế cho deployment của bạn.

## Kiểm thử & xác minh

- **Load test brute-force:** `apps/cms/k6/login-brute-force.js`.
- **Wiring guard:** `apps/cms/src/__tests__/security-guards.wiring.test.ts`,
  `apps/cms/src/middleware/__tests__/` (`rate-limit`, `body-limit`,
  `security-headers`, `control-plane-access-guard`, `file-upload-policy`, …).
- **Cô lập chéo tenant:**
  `apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`.
- **Chạy bộ test CMS:** `pnpm -F @lumibase/cms test`.

## Tài liệu liên quan

- [route-guards.md](./route-guards.md) — danh mục route/control-plane guard.
- [runtime-security-guards-plan.md](./runtime-security-guards-plan.md) — nền tảng
  bảo mật runtime (trách nhiệm guard + điểm mount).
- [cwe-top-100-audit.md](./cwe-top-100-audit.md) — audit bảo mật ánh xạ CWE.
- [idor-testing.md](./idor-testing.md) — hướng dẫn test chéo tenant (IDOR).
- [external-jwt-auth.md](./external-jwt-auth.md) — xác thực JWT issuer bên ngoài.
- [user-management.md](./user-management.md) — quản lý user & auth realm (ADR-010).
- [dependency-overrides.md](./dependency-overrides.md) — siết supply-chain / dependency.
- [../features/permissions-rbac.md](../features/permissions-rbac.md) — engine RBAC / policy field-level.
- [../features/extensions-system.md](../features/extensions-system.md) — quyền sandbox extension.
