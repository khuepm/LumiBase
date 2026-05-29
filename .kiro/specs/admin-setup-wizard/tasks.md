# Implementation Plan

## Overview

Kế hoạch triển khai **Admin Setup Wizard** cho LumiBase Studio, gồm 6 phase tuần tự (A→F) theo rollout sketch trong design.md §14. Phase A đặt nền (schema + state detection + setup transaction); Phase B siết chặt admin path; Phase C xây lockout core; Phase D thêm anomaly detection; Phase E phủ notification + recovery; Phase F hoàn thiện audit log + export. Mỗi task gắn ref tới requirement cụ thể và section thiết kế tương ứng.

## Tasks

### Phase A — Foundation (system state, bootstrap admin, atomic setup transaction)

- [x] 1. Schema migrations và shared password helper
  - [x] 1.1 Tạo migration mở rộng bảng `users` thêm cột `is_bootstrap` (boolean, default false), `locked_until` (timestamp), `failed_count` (integer, default 0), `failed_count_window_start` (timestamp); thêm partial unique index `users_is_bootstrap_unique` ở `packages/database/src/schema/core.ts` và migration tương ứng (Req 1.3, 3.1; design §3.1)
  - [x] 1.2 Thêm bảng `system_state` vào schema mới `packages/database/src/schema/security.ts` với các cột `id` (singleton check), `state` enum, `admin_path` (unique), `setup_token_hash`, `initialized_at`, `updated_at`; export từ `packages/database/src/schema/index.ts` (Req 1.1, 4.6; design §3.2)
  - [x] 1.3 Thêm bảng `audit_log` vào `packages/database/src/schema/security.ts` với các cột `id`, `timestamp`, `event`, `actor_email`, `target_email`, `ip`, `user_agent`, `country_code`, `metadata` (jsonb), `request_id`; index `(timestamp)`, `(event, timestamp)`, `(actor_email, timestamp)` (Req 15.1, 15.2; design §3.6)
  - [x] 1.4 Sinh và commit migration SQL từ Drizzle Kit (`pnpm --filter @lumibase/database run generate`); kiểm tra migration apply sạch trên DB trống
  - [x] 1.5 Refactor PBKDF2 helper từ `apps/cms/src/routes/auth.ts` thành `apps/cms/src/services/auth/password.ts` exporting `hashPassword(plaintext)` và `verifyPassword(plaintext, stored)`; cập nhật `auth.ts` import từ vị trí mới (Req 3.6, 14.2; design §6.5)

- [x] 2. Setup service (state + capabilities + complete)
  - [x] 2.1 Tạo `apps/cms/src/modules/setup/policy-codec.ts` với `serializeLockoutPolicy(policy)` (canonical JSON, key sorted) và `parseLockoutPolicy(json)` validate Zod schema khớp Req 6.3; default-fill cho missing optional field, ignore field thừa (Req 16.1, 16.2, 16.4, 16.5, 16.6; design §6.1)
  - [x] 2.2 Tạo `apps/cms/src/modules/setup/path-validator.ts` với `normalizeAdminPath(input)` (lowercase, trim, single leading slash, no trailing) và `validateAdminPath(normalized)` kiểm regex `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`, blacklist Default_Admin_Paths, reserved prefixes (`/api`, `/setup`, `/health`, `/metrics`, `/scim`, `/.well-known`, `/static`, `/assets`) (Req 4.2, 4.3, 4.4, 4.8; design §6.1)
  - [x] 2.3 Tạo `apps/cms/src/modules/setup/service.ts` với class `SetupService` triển khai `getState()` (query system_state + check is_bootstrap), `getCapabilities()` (probe GeoIP file + SMTP env), `complete(input, ctx)` (transaction với row lock, validate, hash password + 8 backup codes, insert users, upsert settings, update system_state, audit `setup_completed` post-commit) (Req 1.1, 1.2, 1.3, 1.5, 1.7, 3.6, 6.6, 6.7, 14.2; design §6.5)
  - [x] 2.4 Tạo `apps/cms/src/modules/setup/setup-token.ts` với `generateSetupToken()` (CSPRNG ≥24 ký tự, entropy ≥128 bit, hash sha256 lưu DB), `verifySetupToken(plain)` (constant-time compare), in stdout đúng một lần khi startup nếu `LUMIBASE_REQUIRE_SETUP_TOKEN=true` và `state='uninitialized'` (Req 2.6, 2.7; design §7.3)
  - [x] 2.5 Tạo `apps/cms/src/modules/setup/routes.ts` exposing `GET /setup/state`, `GET /setup/capabilities`, `POST /setup/complete` (rate limit 60 req/min/IP cho `/state`); mount vào `apps/cms/src/index.ts` ở `/api/v1/setup` không qua auth middleware (Req 1.1, 1.4, 2.1, 4.6, 4.7; design §4.1, §4.2, §4.3)
  - [x] 2.6 Viết unit test `apps/cms/src/modules/setup/__tests__/policy-codec.test.ts` round-trip property test với fast-check `forAll(validPolicy, p => parseLockoutPolicy(serializeLockoutPolicy(p)) deepEqual p)` (Req 16.3; design §13.1, Property 5)
  - [x] 2.7 Viết unit test `apps/cms/src/modules/setup/__tests__/path-validator.test.ts` bảng input/expected cho regex hợp lệ, blacklist, reserved prefix, normalization edge case (whitespace, control chars, double slash); property test `normalize(normalize(x)) === normalize(x)` (Req 4.8; design §13.5, Property 11)
  - [x] 2.8 Viết integration test `apps/cms/src/__tests__/setup-flow.integration.test.ts` cover happy path setup + verify Audit_Log entry + verify second `/setup/state` trả `initialized`; verify duplicate concurrent setup race trả 404 hoặc 409 với 5 promise đồng thời (Req 1.5, 1.7; design §13.2, Property 1, 3)

- [ ] 3. Studio scaffold cho Setup Wizard (no AppShell)
  - [x] 3.1 Refactor `apps/studio/src/router.tsx` tách `adminLayoutRoute` (component AppShell, chứa toàn bộ module hiện tại) khỏi `publicLayoutRoute` (component `BareLayout`, không AppShell); giữ nguyên route tree existing dưới adminLayout (Req 2.5; design §5.1)
  - [x] 3.2 Tạo `apps/studio/src/modules/setup/setup-layout.tsx` (BareLayout với progress indicator 5 bước) và `apps/studio/src/modules/setup/setup-state-gate.tsx` gọi `useQuery(['setup','state'])` + render 404 cứng khi `initialized`, retry UI khi network/5xx, SetupTokenPrompt khi yêu cầu token (Req 2.1, 2.2, 2.3, 2.8; design §5.1, §5.2)
  - [x] 3.3 Tạo Zod schemas `apps/studio/src/modules/setup/schemas/{account,admin-path,policy}.ts` khớp validation rules requirement (Req 3.1-3.5, 4.2-4.4, 6.3; design §5.5)
  - [x] 3.4 Tạo Zustand store `apps/studio/src/modules/setup/setup-store.ts` với persist middleware sessionStorage key `lumibase.setup`, lưu `accountValid`, `pathValid`, `policyValid`, `confirmed`, `completed` flags (không lưu plaintext password) (design §5.3)
  - [~] 3.5 Tạo `step-account.tsx` với React Hook Form + Zod resolver, lazy-load zxcvbn cho password meter (chặn submit khi score <3), trim firstName/lastName, length bounds; emit `accountValid=true` vào store khi submit pass (Req 3.1-3.5, 3.7, 3.10; design §5.5)
  - [~] 3.6 Tạo `step-path.tsx` với input adminPath + nút "Generate Random" (wordlist `apps/studio/src/modules/setup/wordlist.ts` ≥256 từ + 6 hex chars, retry max 8 lần nếu trùng blacklist), preview banner cảnh báo, checkbox confirm gate; emit `pathValid=true` (Req 4.1, 4.2, 4.5; design §5.5)
  - [~] 3.7 Tạo `step-done.tsx` hiển thị adminPath + reminder save bookmark + link tới `${adminPath}/login` (Req 4.5; design §5.4)
  - [~] 3.8 Tạo `useCompleteSetup` mutation hook gọi `POST /api/v1/setup/complete`, on-success clear sessionStorage và navigate `/setup/done` (design §5.2)
  - [~] 3.9 Wiring routes mới `/setup`, `/setup/account`, `/setup/path`, `/setup/done` vào `publicLayoutRoute`; thêm guard logic redirect sang step thiếu nhất khi deep-link (Req 3.11; design §5.4, §11.2)
  - [~] 3.10 Tạo i18n keys `apps/studio/src/locales/{en,vi}/setup.json` cho toàn bộ field, error, button text (design §5.6)

### Phase B — Custom Admin Path Guard

- [ ] 4. Admin path guard middleware (post-setup)
  - [~] 4.1 Tạo helper `apps/cms/src/modules/setup/path-compare.ts` với `pathEqualsConstantTime(a, b)` pad cả hai về buffer 64 byte fixed, XOR loop toàn bộ 64 byte kèm length-XOR để tránh leak độ dài (Req 5.7; design §7.1, Property 6)
  - [~] 4.2 Tạo middleware `apps/cms/src/middleware/admin-path-guard.ts`: khi `state='initialized'`, request path nằm trong scope Studio (HTML/asset, không phải `/api/*`), so sánh với `system_state.admin_path` constant-time; mismatch trả 404 envelope chuẩn với SELECT 1 no-op để khớp latency profile, header set chỉ chứa Content-Type + Content-Length (Req 5.1, 5.2, 5.6, 5.7; design §6.2, §7.2)
  - [~] 4.3 Mount admin-path-guard sớm trong middleware chain `apps/cms/src/index.ts` (sau request-id, audit-context, trước routes); bypass khi `state='uninitialized'` để Setup_Wizard accessible tại `/setup` (Req 5.3, 5.4; design §6.2)
  - [~] 4.4 Tạo endpoint `GET /api/v1/me/admin-path` trong `apps/cms/src/routes/auth.ts` trả `{ adminPath }` cho user đã authenticate (auth middleware), để Studio fetch path post-login hiển thị bookmark (Req 4.7; design §7.3)
  - [~] 4.5 Audit-log helper masking: tạo `apps/cms/src/modules/audit/path-mask.ts` thay raw admin path bằng `<admin_path>` ở log level info/warn/error; raw path chỉ ghi khi `LOG_LEVEL=debug` (Req 5.5; design §10.1)
  - [~] 4.6 Viết security test `apps/cms/src/__tests__/path-compare.timing.test.ts` 10,000 iteration đo timing variance giữa diff-at-pos-1 và diff-at-pos-63; assert std deviation chênh lệch <1ms (Req 5.7; design §13.3, Property 6)
  - [~] 4.7 Viết integration test `apps/cms/src/__tests__/404-indistinguishable.test.ts` 500 req tới Default_Admin_Path không khớp vs random path; assert latency p95 delta ≤5ms, response body byte-equal, header set match (Req 5.1, 5.6; design §13.3, Property 7)
  - [~] 4.8 Cập nhật Vite config `apps/studio/vite.config.ts` thêm assertion fail build nếu phát hiện env var bắt đầu bằng `VITE_ADMIN_PATH` (Req 4.7; design §7.3)

### Phase C — Lockout Core (user lockout + IP rate limit)

- [ ] 5. Login attempts table và counter store
  - [~] 5.1 Thêm bảng `login_attempts` vào `packages/database/src/schema/security.ts` với cột `id`, `email_lower`, `user_id`, `ip`, `user_agent`, `country_code`, `geo_lookup_status`, `result`, `reason`, `anomaly_score`, `anomaly_triggered`, `baseline_warmup`, `created_at`; index `(email_lower, created_at)` và `(ip, created_at)` (Req 7.1, 8.1; design §3.4)
  - [~] 5.2 Sinh và apply migration cho `login_attempts`
  - [~] 5.3 Tạo `apps/cms/src/modules/login-guard/counter.ts` exporting `userFailedCount(email, windowSeconds)` và `ipFailedCount(ip, windowSeconds)` query SQL count trên `login_attempts`; interface `CounterStore` để cho phép thay Redis qua env `LUMIBASE_REDIS_URL` sau này (Req 7.1, 8.1; design §6.4, Property 12)
  - [~] 5.4 Tạo `apps/cms/src/modules/login-guard/ip-extract.ts` với `extractClientIp(c)` ưu tiên `CF-Connecting-IP` → `X-Forwarded-For` (chỉ nếu remote nằm trong `LUMIBASE_TRUSTED_PROXIES`) → remote socket; trả về `'127.0.0.1' | '::1'` cho loopback (Req 8.4; design §6.1)

- [ ] 6. Login guard middleware và endpoints
  - [~] 6.1 Tạo `apps/cms/src/modules/login-guard/middleware.ts` chạy trước `/auth/login` handler: kiểm `users.lockedUntil > now()` (trả 423 ACCOUNT_LOCKED + retryAfterSeconds), kiểm `ipBlockedUntil > now()` (trả 429 + Retry-After header); apply identical body + identical latency cho email tồn tại / không tồn tại (Req 7.3, 8.3; design §6.3, Property 8)
  - [~] 6.2 Mở rộng handler `apps/cms/src/routes/auth.ts` `/login` với hooks `onFailure(email, ip, reason)` (insert login_attempts, tăng counter, set lockedUntil khi đạt threshold; tăng ip counter, set ipBlockedUntil khi đạt) và `onSuccess(userId, email, ip, attempt)` (insert success attempt, reset failed_count + locked_until + ip counter) (Req 7.1, 7.2, 7.4, 8.1, 8.2, 8.6; design §6.3)
  - [~] 6.3 Áp dụng email normalization (lowercase + trim) khi key counter và verify user (Req 7.1; design §6.5)
  - [~] 6.4 Tạo `apps/cms/src/routes/admin-security.ts` với `POST /admin/security/unlock-user` (auth admin role), `POST /admin/security/unblock-ip` (auth admin role); validate IPv4/IPv6, reset counter và xóa lockedUntil/ipBlockedUntil; audit `user_unlocked`/`ip_unblocked` (Req 7.6, 7.7, 8.7, 8.8, 8.9; design §4.5, §4.6)
  - [~] 6.5 Mở rộng StepSecurity `apps/studio/src/modules/setup/steps/step-security.tsx` Phase C-only fields: preset chooser (Standard/Strict/Lenient), nhóm "Failed Attempts" với inline range validation, nhóm "Notifications" với danh sách Notification_Channel (Req 6.1, 6.2, 6.3 phần Failed Attempts + Notifications; design §5.5)
  - [~] 6.6 Wiring `/setup/security` route vào publicLayoutRoute với deep-link guard
  - [~] 6.7 Viết unit test `apps/cms/src/modules/login-guard/__tests__/counter.test.ts` sliding window correctness với time-mock; verify cửa sổ trượt cleanup sau windowSeconds (Req 7.1, 8.1; design §13.1, Property 12)
  - [~] 6.8 Viết integration test `apps/cms/src/__tests__/lockout-flow.integration.test.ts` 5 fail attempts → 423 ACCOUNT_LOCKED; success login sau lockout duration → 200 + counter reset; verify IP block sau 10 fail từ một IP đa email (Req 7.2-7.5, 8.2, 8.3; design §13.2)
  - [~] 6.9 Viết security test `apps/cms/src/__tests__/user-enum.timing.test.ts` 500 fail login với email tồn tại vs random; assert response body byte-equal, latency p95 delta ≤50ms (Req 7.5; design §13.3, Property 8)
  - [~] 6.10 Viết k6 load test `apps/cms/k6/login-brute-force.js` 50 VU spam `/auth/login` với password sai; assert IP bị block đúng sau N attempts, throughput route khác không degrade (Req 8.2, 8.3; design §13.4)

### Phase D — Anomaly Detection

- [ ] 7. Login baselines table và detector modules
  - [~] 7.1 Thêm bảng `login_baselines` vào `packages/database/src/schema/security.ts` với cột `user_id` (PK FK users), `countries` (jsonb default []), `hour_histogram` (jsonb default 24-int array), `device_fingerprints` (jsonb default []), `successful_logins` (integer default 0), `updated_at`; sinh migration (Req 9.6, 10.5, 11.6; design §3.5)
  - [~] 7.2 Tạo `apps/cms/src/modules/anomaly/geo.ts` với `geoSubscore(userId, ip, attempt)`: integrate `maxmind` package đọc `data/geoip/GeoLite2-Country.mmdb` lazy ở startup; timeout 2s với Promise wrapper; skip cho RFC1918/loopback IP set `geoLookupStatus='unavailable'`; subscore 0/1 với baselineWarmup khi `successfulLogins<3` (Req 9.1-9.6; design §8.1)
  - [~] 7.3 Tạo `apps/cms/src/modules/anomaly/time.ts` với `timeSubscore(userId, now)` đọc `hour_histogram`, tính `totalLogins = Σ histogram[i]`, kiểm tỷ lệ `histogram[h]/totalLogins < 0.02`; baselineWarmup khi `successfulLogins<10`; emit anomaly alert event nếu subscore=1 (Req 10.1-10.5, 10.6, 10.7; design §8.2)
  - [~] 7.4 Tạo `apps/cms/src/modules/anomaly/device.ts` với `normalizeUA(ua)` (slice 1024, lowercase, strip version digits regex `/\b\d+(\.\d+)+\b/g`, collapse whitespace), `fingerprint(ua, acceptLanguage)` SHA-256 truncate 16 hex chars; LRU 20 entries; missing/empty UA → status `unavailable` không warmup (Req 11.1-11.6; design §8.3)
  - [~] 7.5 Tạo `apps/cms/src/modules/anomaly/baseline-store.ts` với `updateBaseline(userId, attempt)` atomic SQL `jsonb_set` cho histogram, append country (cap 50), LRU device fingerprint cap 20, increment `successful_logins` — chạy trong cùng transaction với `onSuccess` của LoginGuard (Req 9.6, 10.5, 11.5, 11.6; design §8.2, §8.3)
  - [~] 7.6 Tạo `apps/cms/src/modules/anomaly/detector.ts` với `aggregate(g, t, d)` trả `{ score: max(...).toFixed(2), baselineWarmup }`; xử lý case detector tắt → subscore 0 (Req 12.1, 12.6; design §8.4, Property 9)

- [ ] 8. Tích hợp anomaly vào LoginGuard và wizard
  - [~] 8.1 Mở rộng `LoginGuard.onSuccess` gọi detector tuần tự `geoSubscore`, `timeSubscore`, `deviceSubscore`, `aggregate`; nếu `score >= threshold && !baselineWarmup` áp `anomalyAction`: `notify_only` (cho phép login + anomaly_triggered=true), `lock` (423 ANOMALY_LOCK + set lockedUntil), `require_mfa` (401 MFA_REQUIRED, không issue JWT) (Req 12.2, 12.3, 12.4, 12.5; design §8.5)
  - [~] 8.2 Ghi `login_attempts` đầy đủ với `anomaly_score`, `anomaly_triggered`, `baseline_warmup`, `country_code`, `geo_lookup_status` (Req 9.5, 12.2, 12.3; design §3.4)
  - [~] 8.3 Mở rộng StepSecurity với 3 nhóm còn lại "Geographic Anomaly", "Time Anomaly", "Device Anomaly"; warning dismissible khi `geoAnomalyEnabled=true` mà capabilities trả `geoip.available=false`; disable lựa chọn `require_mfa` cho `anomalyAction` (Req 6.1, 6.5, 12.4; design §5.5)
  - [~] 8.4 Viết unit test `apps/cms/src/modules/anomaly/__tests__/geo.test.ts`, `time.test.ts`, `device.test.ts` với fixture user baseline biết trước; assert subscore boundary case (warmup, exact threshold, missing UA) (Req 9, 10, 11; design §13.1)
  - [~] 8.5 Viết integration test `apps/cms/src/__tests__/anomaly-flow.integration.test.ts` cover login từ country mới với `anomalyAction='lock'` → 423 + lockedUntil set; login warmup không trigger lock (Req 12.2, 12.3, 12.5; design §13.2)

### Phase E — Notifications + Recovery

- [ ] 9. Notification dispatcher và channels
  - [~] 9.1 Tạo interface `apps/cms/src/modules/notifications/types.ts` với `NotificationChannel`, `NotificationPayload`, `SecurityEvent` enum (Req 13.1; design §9.1)
  - [~] 9.2 Tạo `apps/cms/src/modules/notifications/email-channel.ts` factory `EmailChannelFactory.fromEnv()` chọn `NodemailerChannel` cho self-hosted Node (add `nodemailer` dependency vào `apps/cms/package.json`) hoặc `MailchannelsChannel` cho Cloudflare Workers; subject `[LumiBase Security] <event_code>`, body template với substitution variables (Req 13.2; design §9.2)
  - [~] 9.3 Tạo `apps/cms/src/modules/notifications/webhook-channel.ts` với HMAC-SHA256 sign over `${timestamp}.${body}`, header `X-Lumibase-Signature: sha256=<hex>`, `X-Lumibase-Timestamp`; timeout 10s; status 2xx = success (Req 13.3; design §9.3, §7.4)
  - [~] 9.4 Tạo `apps/cms/src/modules/notifications/dispatcher.ts` với queue in-process: tick 250ms, exponential backoff 1s/2s/4s max 3 attempts, drop sau fail → audit `notification_delivery_failed`; rate-limit Map `(event, emailLower)` TTL 60s, drop khi hit → audit `notification_rate_limited` (Req 13.4, 13.5; design §9.4, §9.5)
  - [~] 9.5 Wiring dispatcher vào LoginGuard events `user_locked`, `ip_blocked`, `anomaly_triggered`, `anomaly_lock` (Req 13.1; design §6.3)
  - [~] 9.6 Cho Cloudflare Workers runtime: wrap dispatch trong `ctx.waitUntil()` để giữ task sau response

- [ ] 10. Recovery flow (backup codes + forgot path)
  - [~] 10.1 Thêm bảng `admin_backup_codes` vào `packages/database/src/schema/security.ts` với cột `id`, `user_id`, `code_hash`, `created_at`, `used_at`, `used_from_ip`; partial index `(user_id) WHERE used_at IS NULL`; sinh migration (Req 14.2; design §3.3)
  - [~] 10.2 Mở rộng `SetupService.complete()` sinh 8 backup codes alphabet `[A-Z, 2-9]` (loại I, O, 0, 1, L), CSPRNG ≥128 bit/code, format `XXXX-XXXX`; hash PBKDF2 per-code salt 16 byte; lưu vào `admin_backup_codes`; trả plaintext list duy nhất một lần trong response (Req 14.1, 14.2; design §6.5)
  - [~] 10.3 Tạo StepRecovery `apps/studio/src/modules/setup/steps/step-recovery.tsx` hiển thị 8 backup codes dạng monospace, nút copy/download .txt, checkbox xác nhận "I have saved these backup codes" gating "Finish setup" (Req 14.1, 14.3; design §5.2)
  - [~] 10.4 Tạo `apps/cms/src/modules/recovery/service.ts` với `recover(email, backupCode, ip)`: lookup user theo email lower, verify hash khớp row có `used_at IS NULL`, set `used_at=now()`, clear lockedUntil + ipBlockedUntil cho `ip`, sinh `oneTimeUnlockToken` (CSPRNG, 15 phút TTL, hash lưu DB), trả `{ adminPath, oneTimeUnlockToken }`; mọi nhánh fail trả 401 generic sau random delay 200-500ms (Req 14.4; design §6.3)
  - [~] 10.5 Mở rộng `recovery/service.ts` với `forgotPath(email, ip)`: lookup Bootstrap_Admin, sinh `Recovery_Token` 30 phút TTL hash sha256 lưu DB, gửi email; mọi nhánh trả 200 generic chống enumeration (Req 14.5, 14.6, 14.7; design §6.3)
  - [~] 10.6 Tạo `apps/cms/src/modules/recovery/rate-limit.ts` rate-limit 3 req/IP/giờ cho `/recover` và `/forgot-path` chia sẻ counter; trả 429 + Retry-After header khi vượt (Req 14.8; design §4.7, §4.8)
  - [~] 10.7 Tạo `apps/cms/src/modules/recovery/routes.ts` exposing `POST /admin/security/recover` và `POST /admin/security/forgot-path`; mount vào `/api/v1/admin/security` không qua admin auth (Req 14.4, 14.5; design §4.7, §4.8)
  - [~] 10.8 Tạo Studio routes `apps/studio/src/modules/recovery/{backup-code-page,forgot-path-page}.tsx` form input + i18n; mount `/recovery/backup-code`, `/recovery/forgot-path` vào publicLayoutRoute (design §5.1)
  - [~] 10.9 Viết integration test `apps/cms/src/__tests__/recovery-flow.integration.test.ts` cover lock user → recover backup code → unlock + adminPath returned; verify backup code single-use (lần thứ hai trả 401); verify rate-limit 3/IP/giờ (Req 14.4, 14.7, 14.8; design §13.2, Property 4)

### Phase F — Audit Log + Export

- [ ] 11. Audit logger và rotation
  - [~] 11.1 Tạo `apps/cms/src/modules/audit/logger.ts` với class `AuditLogger`: `write(entry)` synchronous insert ≤1s budget; helper `maskSensitive(metadata)` thay `passwordHash`/`setupToken`/`backupCode`/`recoveryToken` bằng sha256 hex 8 ký tự đầu hoặc null; fallback `console.error` JSON structured khi DB write fail (Req 15.1, 15.2, 15.3; design §10.1)
  - [~] 11.2 Wiring `AuditLogger.write` vào tất cả events từ Req 15.1: `setup_started`, `setup_completed`, `bootstrap_admin_created`, `admin_path_set`, `lockout_policy_updated`, `login_success`, `login_failed`, `user_locked`, `user_unlocked`, `ip_blocked`, `ip_unblocked`, `anomaly_triggered`, `recovery_initiated`, `recovery_completed`, `backup_code_used`; thêm middleware `audit-context` populate `requestId`, `ip`, `userAgent` vào ctx (Req 15.1, 15.2; design §6.2, §10.1)
  - [~] 11.3 Tạo `apps/cms/src/modules/audit/rotator.ts` với `rotate()` xóa rows `audit_log` và `login_attempts` cũ hơn `LUMIBASE_AUDIT_RETENTION_DAYS` (default 90, range 1-3650); trigger qua cron 1h hoặc khi count >10,000 (throttle 1/h) (Req 15.5; design §10.2)
  - [~] 11.4 Cho self-hosted Node: thêm `node-cron` schedule trong `apps/cms/src/serve.ts` chạy `auditRotator.rotate()` mỗi giờ; cho Workers: dùng Cloudflare Cron Triggers route handler

- [ ] 12. Audit log query và export API
  - [~] 12.1 Tạo `apps/cms/src/modules/audit/routes.ts` với `GET /admin/security/audit-log` cursor-based pagination (cursor base64 `${ts}|${id}`), filter `event`, `email` (lowercase normalize), `from`, `to` (validate ≤366 ngày, from<to), limit 1-100 default 50; budget P95 ≤2s (Req 15.4; design §10.3)
  - [~] 12.2 Mở rộng routes với `GET /admin/security/audit-log/export` streaming NDJSON via Hono `c.body(new ReadableStream(...))` pull-based, batch 500 row; cap 100,000 rows / ≤366 ngày, vượt → 413 EXPORT_TOO_LARGE (Req 15.6; design §10.4)
  - [~] 12.3 Mount routes audit dưới `/api/v1/admin/security` qua auth middleware role admin
  - [~] 12.4 Mở rộng Studio module `apps/studio/src/modules/settings/activity-page.tsx` thêm tab "Security audit" gọi `/audit-log` với filter UI (event dropdown, email input, date range picker), nút "Export NDJSON" download blob (Req 15.4, 15.6; design §10.3)
  - [~] 12.5 Viết integration test `apps/cms/src/__tests__/audit-log.integration.test.ts` cover write event → query trả entry; cover retention rotation xóa rows cũ; cover export streaming với 1000 row mock (Req 15.1, 15.4, 15.5, 15.6; design §13.2, Property 10)


## Task Dependency Graph

Mũi tên `A → B` nghĩa là task `B` phụ thuộc task `A` đã xong. Trong cùng task cha (1, 2, ...), các sub-task được làm tuần tự theo thứ tự đánh số.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "depends_on": [] },
    { "wave": 2, "tasks": ["2"], "depends_on": ["1"] },
    { "wave": 3, "tasks": ["3"], "depends_on": ["2"] },
    { "wave": 4, "tasks": ["4"], "depends_on": ["3"] },
    { "wave": 5, "tasks": ["5"], "depends_on": ["4"] },
    { "wave": 6, "tasks": ["6"], "depends_on": ["5"] },
    { "wave": 7, "tasks": ["7"], "depends_on": ["6"] },
    { "wave": 8, "tasks": ["8"], "depends_on": ["7"] },
    { "wave": 9, "tasks": ["9"], "depends_on": ["8"] },
    { "wave": 10, "tasks": ["10"], "depends_on": ["9"] },
    { "wave": 11, "tasks": ["11"], "depends_on": ["10"] },
    { "wave": 12, "tasks": ["12"], "depends_on": ["11"] }
  ]
}
```

Diagram tham khảo:

```
1 (schema + password helper)
└─→ 2 (setup service + routes)
    └─→ 3 (Studio scaffold + steps Account/Path/Done)
        └─→ 4 (admin path guard + tests)
            └─→ 5 (login_attempts + counter store)
                └─→ 6 (login guard middleware + StepSecurity Phase C)
                    └─→ 7 (login_baselines + anomaly detector modules)
                        └─→ 8 (anomaly integration + StepSecurity Phase D)
                            └─→ 9 (notification dispatcher + channels)
                                └─→ 10 (recovery flow + StepRecovery)
                                    └─→ 11 (audit logger + rotation)
                                        └─→ 12 (audit query/export + Studio activity tab)
```

Phase boundary explicit:
- Phase A = task 1, 2, 3
- Phase B = task 4
- Phase C = task 5, 6
- Phase D = task 7, 8
- Phase E = task 9, 10
- Phase F = task 11, 12

Notes về parallel hóa:
- Trong task 3, các sub-task 3.3 (Zod schemas), 3.4 (Zustand store), 3.10 (i18n) có thể chạy song song với 3.5–3.7 (UI steps) sau khi 3.1, 3.2 hoàn tất.
- Trong task 6, 6.7 (unit test counter) có thể bắt đầu sau 5.3 mà không cần đợi 6.1–6.6.
- Test tasks (2.6, 2.7, 4.6, 4.7, 6.7–6.10, 8.4, 8.5, 10.9, 12.5) có thể được chạy song song với task tiếp theo của cùng phase miễn là dependencies hạ tầng đã sẵn.

## Notes

### Decisions cần xác nhận trước khi bắt đầu (từ design.md §15)

1. **DB target**: spec giả định Postgres-only theo `packages/database/src/schema/core.ts`. Nếu cần SQLite fallback cho local dev, partial unique index ở task 1.1 phải đổi sang trigger.
2. **Redis dependency**: task 5.3 thiết kế `CounterStore` interface để swap; mặc định Postgres-backed. Confirm có cần adapter Redis sẵn từ đầu không.
3. **GeoIP source**: task 7.2 dùng `maxmind` + `data/geoip/GeoLite2-Country.mmdb`. Cần quyết định cách phân phối file (volume mount, init container, hay external API như ip-api.com qua adapter) trước khi implement.
4. **SMTP library**: task 9.2 add `nodemailer` cho self-hosted. Confirm hay dùng external service (Postmark/Resend) chỉ qua webhook-only.
5. **Studio serving**: design giả định CMS serve Studio assets nên admin-path-guard nằm trong Hono. Nếu Studio deploy riêng (CDN/Workers), task 4.2 phải đặt guard ở edge layer thay vào.
6. **Edge runtime**: task 9.4 (notification retry) và 11.4 (audit rotator) phụ thuộc long-running process; trên Cloudflare Workers cần Durable Objects hoặc Cron Triggers.
7. **Multi-tenancy**: bootstrap admin = super-admin instance-wide hay admin của site default? Ảnh hưởng task 2.3 (insert users phải gắn `siteId` hay không).

### Test gating

- Mỗi phase phải pass toàn bộ unit + integration test trước khi sang phase kế.
- Security/timing tests (4.6, 4.7, 6.9) phải chạy ở môi trường ổn định (không CI shared); dùng `vitest --run` với `--isolate` flag.
- k6 load test (6.10) chạy on-demand, không gate CI; document threshold trong README.

### Migration safety

- Task 1.4 (initial migration) chạy trên DB trống. Task 5.2, 7.1, 10.1 (subsequent migrations) phải có rollback script và test trên DB có data fixture từ phase trước.
- Bảng `users` (task 1.1) đã tồn tại ở production tiềm năng; thêm cột phải nullable + default an toàn để zero-downtime.

### i18n coverage

- Task 3.10 và 12.4 thêm key cho EN + VI tối thiểu. Các locale khác trong Studio sẽ kế thừa fallback EN cho đến khi translator bổ sung.
