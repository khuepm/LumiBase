---
<!-- check-parity: allow inline-code -->
version: 5
lastUpdated: 2026-08-02T19:21:21.609Z
sourceLang: en
translatedFrom: en
sourceHash: d61ac505ff51e1e6
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:21:21.609Z
codeVerifiedHash: d61ac505ff51e1e6
codeVerifiedClaims: 54
---

<!-- check-parity: allow inline-code -->

# Kiểm toán bảo mật CWE Top 100 — LumiBase

> **Trạng thái:** Tài liệu sống. Kiểm toán lại sau mỗi thay đổi ở mã xác thực, upload, lưu trữ, hoặc dựng câu truy vấn.
> **Ngày kiểm toán:** 2026-07-06 · **Nhánh:** `lumibase/inspiring-driscoll-2c1fd8` (gốc `main` @ 87a82fcb)
> **Phương pháp:** Rà soát mã tĩnh toàn monorepo (quét có agent hỗ trợ + xác minh tại call-site cho các luận điểm then chốt). Đây KHÔNG phải kiểm thử xâm nhập — verdict "Đã vá" nghĩa là *có cơ chế phòng thủ đúng trong mã kèm bằng chứng*, không phải bảo chứng không còn lỗ hổng.

## Phạm vi & cách lập danh sách

**Không tồn tại "CWE Top 100" chính thức.** MITRE chỉ công bố xếp hạng đến hạng 40:

- **Phần A (hạng 1–40, chính thức):** [2025 CWE Top 25](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html) + [2025 "On the Cusp"](https://cwe.mitre.org/top25/archive/2025/2025_onthecusp_list.html) (hạng 26–40).
- **Phần B (60 điểm yếu bổ sung, không xếp hạng):** do nhóm kiểm toán chọn từ ánh xạ CWE của OWASP Top 10 (2021) / OWASP API Security Top 10 (2023) và thực hành bảo mật web/API, lọc theo mức liên quan tới stack của LumiBase (TypeScript, Hono, Drizzle/Postgres, Cloudflare Workers + Node/Docker). Đây là lựa chọn biên tập, không phải xếp hạng chính thức.

## Chú giải verdict

| Verdict | Ý nghĩa |
|---------|---------|
| ✅ Đã vá | Có cơ chế phòng thủ đúng, đã kiểm chứng hoặc kiểm chứng được, tại vị trí trích dẫn. |
| ⚠️ Một phần | Có phòng thủ nhưng còn khoảng trống hoặc thiếu nhất quán đã ghi rõ. |
| ❌ Chưa xử lý | Không tìm thấy phòng thủ cho một điểm yếu có áp dụng. |
| — N/A | Không áp dụng cho stack này (lớp lỗi bộ nhớ/native/PHP) hoặc không có bề mặt tấn công trong mã. |

## Bảng điểm

| | Số lượng |
|---|---|
| ✅ Đã vá | **78** |
| ⚠️ Một phần | **0** |
| ❌ Chưa xử lý | **0** |
| — N/A (lớp lỗi bộ nhớ, không có bề mặt, hoặc không dùng cookie) | **22** |
| **Tổng** | **100** |

Trong **78 điểm yếu có áp dụng**: **78 đã vá (100%)**, 0 một phần, 0 chưa xử lý.

> **Nhật ký thay đổi — 2026-07-06:**
> - Đợt đầu vá 2 mục ⚠️ trong top 20 chính thức (CWE-89 SQL Injection, CWE-284 Improper Access Control) cùng CWE-668 liên quan.
> - Đợt hai đóng toàn bộ mục Một phần/Chưa xử lý còn lại: CWE-521/203 (policy mật khẩu register + validation), CWE-620/613 (endpoint đổi mật khẩu + thu hồi qua `token_version`), CWE-302 (role Cloudflare Access nay ánh xạ từ DB), CWE-362/367 (quyết định phê duyệt nguyên tử có guard), CWE-942 (không reflect origin tùy ý kèm credentials), CWE-321 (bỏ khóa fallback CDC trong repo, fail-closed), CWE-400 (rate limiter API tổng quát), CWE-359 (che payload + cap chuỗi trong audit log), CWE-1104 (dependabot + cổng `pnpm audit` CI).
> Mọi điểm yếu có áp dụng nay đều Đã vá. Như thường lệ, "Đã vá" nghĩa là *có phòng thủ đã kiểm chứng* — không phải bảo chứng; chỉ pentest mới xác nhận được.

---
<!-- check-parity: allow inline-code -->

## Phần A — Xếp hạng chính thức MITRE 2025 (1–40)

| # | CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|---|-----|----------|---------|----------------------|
| 1 | 79 | Cross-site Scripting | ✅ | Allowlist DOMPurify tập trung `apps/studio/src/lib/sanitize-html.ts`; markdown escape rồi sanitize; CSP `script-src 'self'` trong `apps/cms/src/middleware/security-headers.ts`; quét active-content SVG khi upload. |
| 2 | 89 | SQL Injection | ✅ | **Đã vá 2026-07-06.** `materialize-service.ts` nay dùng bind parameter của Drizzle cho mọi value và `sql.identifier()` cho tên bảng vật lý đã kiểm; chỗ duy nhất không thể dùng bind param (thân hàm PL/pgSQL của trigger) kiểm id fail-closed theo `/^[A-Za-z0-9_-]+$/` thay vì escape. Các nơi khác Drizzle parameterized xuyên suốt. Có test `materialize-sql-injection.test.ts` + `materialize-service.test.ts`. |
| 3 | 352 | CSRF | ✅ | Trên nhánh này auth chỉ dùng bearer header — không phát hành cookie, nên không có credential tự-gửi để CSRF lợi dụng. Origin CORS được kiểm (`apps/cms/src/config/cors.ts`). Kiểm lại nếu refresh qua cookie được merge (đang ở nhánh tính năng, commit 807d0fbd / 4469c36c — chưa có trên nhánh này). |
| 4 | 862 | Missing Authorization | ✅ | `withAuth()` phủ toàn bộ stack `/api/v1` (`apps/cms/src/index.ts`); chỉ các bypass chủ đích: login, setup wizard (chặn theo state), recovery (giới hạn tần suất), đổi ticket realtime. |
| 5 | 787 | Out-of-bounds Write | — | Lớp lỗi bộ nhớ; không có mã native. |
| 6 | 22 | Path Traversal | ✅ | `isInvalidKey()` chặn `..`/`/` đầu key (`apps/cms/src/routes/media.ts:22`); mọi storage key có tiền tố tenant `sites/{siteId}/media/`. |
| 7 | 416 | Use After Free | — | Lớp lỗi bộ nhớ. |
| 8 | 125 | Out-of-bounds Read | — | Lớp lỗi bộ nhớ. |
| 9 | 78 | OS Command Injection | — | Không có input người dùng chạm tới shell; chỉ `execFileSync('git', [...])` lúc build với argv cố định. |
| 10 | 94 | Code Injection | ✅ | Extension bundle chỉ từ allowlist `EXTENSION_BUNDLE_ORIGINS` + SSRF guard + timeout (`apps/cms/src/extensions/sandbox.ts`); AI skill là schema khai báo, không eval chuỗi người dùng. |
| 11 | 120 | Classic Buffer Overflow | — | Lớp lỗi bộ nhớ. |
| 12 | 434 | Upload file nguy hiểm | ✅ | 5 lớp trong `apps/cms/src/middleware/file-upload-policy.ts`: size body thật, MIME allowlist trong DB, đối chiếu extension↔MIME, sniff magic-byte (chặn MZ/ELF/Mach-O), quét script/XXE trong SVG. Serve kèm `Content-Disposition: attachment` + nosniff. |
| 13 | 476 | NULL Pointer Dereference | — | Lớp lỗi bộ nhớ (một `TypeError` trong JS là exception, không phải hỏng bộ nhớ). |
| 14 | 121 | Stack Buffer Overflow | — | Lớp lỗi bộ nhớ. |
| 15 | 502 | Unsafe Deserialization | ✅ | Config import qua Zod strict trước mọi xử lý (`apps/cms/src/services/config-import-service.ts:79`); không có yaml.load/vm/unserialize. |
| 16 | 122 | Heap Buffer Overflow | — | Lớp lỗi bộ nhớ. |
| 17 | 863 | Incorrect Authorization | ✅ | Postgres RLS trên 25+ bảng với `SET LOCAL app.site_id` phạm vi transaction (`packages/database/migrations/rls-policies.sql`); scope `siteId` ở tầng service; masking cấp field trong `permission-service.ts`. |
| 18 | 20 | Improper Input Validation | ✅ | Zod `safeParse()` nhất quán trên mọi input route (schema dùng chung ở `packages/shared/src/schemas`). |
| 19 | 284 | Improper Access Control | ✅ | **Đã vá 2026-07-06.** Các bề mặt route (flows, ai, cdc, uploads, shares) đều kiểm admin/permission. `/health` nay chỉ trả `status` tổng cho caller ẩn danh (chi tiết subsystem cần observability token); `/metrics` ép `METRICS_TOKEN` ở **mọi** môi trường khi được cấu hình (trước đây bỏ qua ở non-prod). Xem CWE-668. |
| 20 | 200 | Lộ thông tin nhạy cảm | ✅ | `formatSafeError()` bỏ object request/response; client chỉ nhận mã lỗi chung; stack trace chỉ log phía server (`apps/cms/src/index.ts:328`). |
| 21 | 306 | Thiếu xác thực cho chức năng trọng yếu | ✅ | Setup wizard trả 404 khi `system_state = initialized`; recovery công khai chủ đích nhưng 3/IP/giờ; metrics khoá token ở prod. |
| 22 | 918 | SSRF | ✅ | `validateOutboundUrl()` chặn RFC1918, loopback, link-local, endpoint metadata cloud, IPv6 ULA/link-local (`apps/cms/src/services/ssrf-guard.ts:33`), có test. |
| 23 | 77 | Command Injection | — | Như CWE-78: không có bề mặt. |
| 24 | 639 | Vượt phân quyền qua khóa do người dùng kiểm soát (IDOR) | ✅ | Mọi truy vấn item/revision lọc `scopeSite(items.siteId, deps.siteId)` (`apps/cms/src/services/item-service.ts:558`); test tích hợp `idor-tenant-isolation.integration.test.ts`; hướng dẫn ở `docs/en/security/idor-testing.md`; ID nanoid không đoán được. |
| 25 | 770 | Cấp phát tài nguyên không giới hạn | ✅ | Pagination `limit ≤ 200`, mệnh đề filter ≤ 100, độ sâu path filter ≤ 8 (`item-service.ts:227`), cap size upload, pressure limiter theo event-loop trả 503. Xem CWE-400 cho khoảng trống rate-limit còn lại. |
| 26 | 266 | Gán quyền sai | ✅ | Role admin bootstrap tường minh (`modules/setup/service.ts:935`); member được mời mặc định `roleId: null`, role member có `adminAccess: false`. |
| 27 | 276 | Quyền mặc định sai | ✅ | Docker chạy user non-root `lumibase` (`docker/Dockerfile`); upload policy fail-safe về mặc định hạn chế; không có policy mặc định public-read. |
| 28 | 98 | PHP File Inclusion | — | Không phải codebase PHP. |
| 29 | 269 | Quản lý đặc quyền kém | ✅ | Route control-plane chỉ admin (`middleware/control-plane-access-guard.ts`); user không tự đổi role (`requireSiteAdmin()` trên `/users`); HITL `ai_approvals` cho skill `schema:write`/`delete`. |
| 30 | 190 | Integer Overflow | — | JS dùng float 64-bit; không thấy số học size không an toàn với input người dùng. |
| 31 | 287 | Improper Authentication | ✅ | PBKDF2-SHA256 100k vòng + salt 16-byte, so sánh constant-time (`services/auth/password.ts`); JWT HS256 24h; API key hash SHA-256; lockout + cửa sổ per-IP + stall 500ms + dummy-hash chống liệt kê. |
| 32 | 400 | Tiêu thụ tài nguyên không kiểm soát | ✅ | **Đã vá 2026-07-06.** Thêm `withRateLimit()` vào chuỗi API đã xác thực (`apps/cms/src/middleware/rate-limit.ts`): throttle fixed-window theo principal (userId/API-key) hoặc IP dùng runtime cache, cộng thêm limiter auth/recovery và backpressure event-loop có sẵn. Trả `X-RateLimit-*` + `Retry-After`; cấu hình qua `LUMIBASE_RATE_LIMIT_*`. |
| 33 | 288 | Vượt xác thực qua đường thay thế | ✅ | GraphQL kế thừa cùng chuỗi `withAuth`/`withRls`; realtime dùng ticket ký hạn 1 phút; SCIM dùng token-store riêng đã hash kèm hạn; MCP kế thừa bearer auth. |
| 34 | 427 | Uncontrolled Search Path | — | Không có thực thi child-process trong mã ứng dụng. |
| 35 | 798 | Credential hard-code | ✅ | Secret qua env/`*_FILE`; khởi động production từ chối các giá trị dev-default đã biết (`apps/cms/src/config/production.ts:25`); bypass dev-auth chặn ba lớp về development. |
| 36 | 362 | Race Condition | ✅ | **Đã vá 2026-07-06.** UPDATE commit/reject phê duyệt AI nay có guard `WHERE status = 'pending'` và dùng `.returning()`; nếu 0 dòng nghĩa là một quyết định đồng thời đã thắng, caller nhận conflict thay vì ghi đè âm thầm (`services/ai-harness.ts`). Recovery token vẫn dùng-một-lần bằng consume nguyên tử. |
| 37 | 401 | Rò rỉ bộ nhớ | — | Lớp lỗi bộ nhớ. |
| 38 | 732 | Quyền trên tài nguyên trọng yếu | ✅ | `FORCE ROW LEVEL SECURITY` chặn table-owner bypass; migration bắt buộc role ứng dụng non-superuser (`rls-policies.sql:12,59`). |
| 39 | 119 | Ranh giới buffer bộ nhớ | — | Lớp lỗi bộ nhớ. |
| 40 | 601 | Open Redirect | — | Không thấy cơ chế `returnTo`/redirect theo URL người dùng ở route auth; issuer external-JWT cấu hình phía server. Hiện không có bề mặt; thêm validator redirect tập trung nếu sau này có login redirect. |

---
<!-- check-parity: allow inline-code -->

## Phần B — 60 điểm yếu bổ sung (lựa chọn theo ánh xạ OWASP, không xếp hạng)

### B1. Mật mã & quản lý khóa (12)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 327 | Thuật toán mã hóa hỏng | ✅ | AES-GCM qua WebCrypto (`services/crypto-service.ts:91`); không có MD5/SHA1/DES/RC4/ECB/`createCipher`. |
| 328 | Hash yếu | ✅ | SHA-256 cho hash token; PBKDF2-SHA256 cho mật khẩu. |
| 326 | Độ mạnh mã hóa không đủ | ✅ | DEK AES-256 (`services/crypto/envelope-encryption.ts:21`); kiểm kích thước khóa lúc khởi động. |
| 330 | Ngẫu nhiên không đủ | ✅ | `crypto.getRandomValues()` cho seed API-key, setup token, backup code (rejection-sampling); `Math.random()` chỉ ở fallback không liên quan bảo mật. |
| 338 | PRNG yếu | ✅ | Như CWE-330; jitter thời gian recovery dùng CSPRNG tường minh. |
| 311 | Thiếu mã hóa dữ liệu nhạy cảm | ✅ | Deployment token lưu dạng ciphertext envelope AES-GCM + key id (`packages/database/src/schema/deployments.ts:47`). |
| 312 | Lưu secret dạng cleartext | ✅ | API key/share token lưu dạng hash SHA-256; plaintext trả đúng một lần lúc tạo. |
| 319 | Truyền cleartext | ✅ | Production yêu cầu `sslmode=require+` cho Postgres (`config/production.ts:107`); issuer external phải HTTPS. |
| 321 | Khóa mã hóa hard-code | ✅ | **Đã vá 2026-07-06.** Bỏ khóa fallback CDC trong repo; `encrypt`/`decrypt` nay bắt buộc có khóa, ném lỗi nếu thiếu, và factory route CDC fail-closed với 503 `ENCRYPTION_KEY_MISSING` khi `ENCRYPTION_KEY` chưa đặt (`modules/cdc/registry/encryption.ts`, `modules/cdc/routes.ts`). |
| 347 | Xác minh chữ ký sai | ✅ | `jose` với allowlist thuật toán tường minh (HS256 custom / RS256 CF Access); verifier external-JWT **cấm** `none`/HS* (`modules/external-auth/verifier.ts:72`); webhook vào từ Vercel/Netlify xác minh bằng so sánh constant-time. |
| 916 | Hash mật khẩu yếu | ✅ | PBKDF2-SHA256 100k ở mọi chỗ lưu mật khẩu/backup code; không có đường yếu hơn (đã kiểm setup, SCIM). |
| 295 | Xác thực chứng chỉ sai | ✅ | Không có `rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED`; JWKS qua `createRemoteJWKSet`. |

### B2. Xử lý secret (2)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 522 | Credential bảo vệ không đủ | ✅ | Trả plaintext một lần cho API key/share token; setup token in một lần, hash lưu lại. |
| 526 | Lộ qua environment | ✅ | Không dump env; đường lỗi dùng `formatSafeError()`; validation config prod fail-closed. |

### B3. Quản lý phiên & tài khoản (12)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 384 | Session fixation | ✅ | JWT mới mỗi lần login; không mang session identifier qua các lần xác thực. |
| 613 | Hết hạn phiên không đủ | ✅ | **Đã vá 2026-07-06.** Thêm cột `users.token_version` (migration `0002_add_user_token_version.sql`) nhúng vào mọi JWT và kiểm khi verify (`middleware/auth.ts`). Đổi/reset mật khẩu sẽ tăng nó, vô hiệu tức thì mọi token đang tồn tại của user. |
| 307 | Quá nhiều lần thử xác thực | ✅ | Lockout login (`users.lockedUntil`) + cửa sổ trượt per-IP (423/429); recovery 3/IP/giờ; endpoint state setup 60/phút/IP. |
| 521 | Yêu cầu mật khẩu yếu | ✅ | **Đã vá 2026-07-06.** Thêm `PasswordSchema` dùng chung (min 12 + độ phức tạp) ở `packages/shared/src/schemas/password.ts`, nay dùng bởi register, setup, recovery nên policy đồng nhất và không lệch được. |
| 620 | Đổi mật khẩu không xác minh | ✅ | **Đã vá 2026-07-06.** Thêm `POST /api/v1/me/change-password` yêu cầu mật khẩu hiện tại (verify constant-time) và tăng `token_version` để thu hồi phiên khác, trả token mới cho caller (`routes/auth.ts`). |
| 640 | Khôi phục mật khẩu yếu | ✅ | Token CSPRNG 32-byte, TTL 15/30 phút, consume dùng-một-lần nguyên tử, delay đều 200–500ms, phản hồi chung chung (`modules/recovery/service.ts`). |
| 203 | Phân biệt quan sát được (liệt kê user) | ✅ | Login và recovery đồng nhất (dummy hash, thông báo chung). Register là **chỉ-admin** (admin đã xác thực tạo user cho site của mình), nên `EMAIL_ALREADY_EXISTS` không phải vector liệt kê ẩn danh; endpoint nay còn validate input trả 400 trước khi truy vấn. |
| 208 | Phân biệt thời gian | ✅ | So sánh byte constant-time cho mật khẩu và khớp admin-path; stall login 500ms; jitter CSPRNG trong recovery. |
| 302 | Vượt xác thực qua dữ liệu giả định bất biến | ✅ | **Đã vá 2026-07-06.** `withSiteMembership` vốn đã ràng buộc tenant `X-Lumi-Site` với membership đã kiểm trước RLS. Khoảng trống còn lại — principal Cloudflare Access hard-code `['admin']` — nay đã đóng: danh tính Access được ánh xạ tới user active + role membership thật từ DB, từ chối user chưa provision/không phải member (`middleware/auth.ts`). |
| 614 | Cookie thiếu cờ Secure | — | Không phát hành cookie trên nhánh này (bearer-only). |
| 1004 | Cookie thiếu HttpOnly | — | Như trên. |
| 1275 | Cookie SameSite | — | Như trên. Kiểm lại cả ba nếu refresh qua cookie được merge. |

### B4. Nền tảng web (12)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 611 | XXE | ✅ | Không có XML parser trong pipeline; SVG lọc bằng quét token regex (chặn `<!DOCTYPE`, `<!ENTITY`) — không thể entity expansion. |
| 776 | Bung entity XML | ✅ | Như CWE-611. |
| 1021 | Clickjacking | ✅ | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (`middleware/security-headers.ts`). |
| 942 | CORS quá lỏng | ✅ | **Đã vá 2026-07-06.** `resolveCorsOrigin` không bao giờ trả `*` và không reflect origin internet tùy ý: allowlist tường minh thắng ở mọi env, và khi không có allowlist chỉ reflect origin loopback (chỉ dev). CORS có credentials không còn bị site bên thứ ba lợi dụng (`config/cors.ts`). |
| 444 | Request smuggling | — | Không có mã proxy/forward header tùy biến; là vấn đề framework/hạ tầng. |
| 113 | Response splitting | ✅ | `sanitizeDownloadFilename` bỏ control char/nháy/backslash trước Content-Disposition (`routes/media.ts:44`). |
| 93 | CRLF injection | ✅ | Cùng sanitizer; không có input người dùng khác chạm header. |
| 116 | Output encoding sai | ✅ | API chỉ JSON qua `c.json()`. |
| 117 | Log injection | ✅ | Log structured `JSON.stringify` (`middleware/logger.ts`) — control char không thể giả dòng log. |
| 1336 | SSTI | ✅ | Template email dùng micro-engine chỉ thay `{{var}}` có HTML-escape (`services/email/render.ts:49`); không Handlebars/EJS/Liquid. |
| 425 | Forced browsing | ✅ | Admin path guard trả 404 không phân biệt (`middleware/admin-path-guard.ts`); backup/restore cần bundle admin. |
| 602 | Chỉ thực thi phía client | ✅ | Đã spot-check: route admin backup/restore và role ép `requireSiteAdmin`/PermissionService phía server, độc lập với trạng thái UI Studio. |

### B5. Đặc thù JavaScript / API (12)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 1321 | Prototype pollution | ✅ | Không có merge JSON người dùng đệ quy; ánh xạ field tường minh khi upsert; Zod object strict. |
| 915 | Mass assignment | ✅ | Không `...req.body` vào ghi DB; chỉ field trong Zod allowlist (`routes/items.ts:35`, `routes/webhooks.ts:11`). |
| 1333 | ReDoS | ✅ | Regex người dùng trong permission DSL bọc try/catch và có giới hạn (`services/permission-dsl.ts:384`); đệ quy filter có chặn. |
| 407 | Độ phức tạp thuật toán | ✅ | Mệnh đề filter ≤ 100, độ sâu path ≤ 8 (`item-service.ts:227`). |
| 674 | Đệ quy không kiểm soát | ✅ | Mở rộng relation một-pass; không đệ quy vô hạn trên dữ liệu người dùng. |
| 799 | Tần suất tương tác | ✅ | Thao tác bulk có chặn; pagination có cap. (Rate-limit API per-user theo dõi ở CWE-400.) |
| 73 | Kiểm soát ngoài lên path file | ✅ | Storage key được kiểm và có tiền tố tenant; tên file export sinh phía server. |
| 59 | Đi theo symlink | — | Đọc filesystem giới hạn ở path secret cấu hình qua env; object storage theo key. |
| 552 | File/thư mục bị lộ | ✅ | Không serve tĩnh thư mục dự án; media sau kiểm permission; bucket MinIO không public. |
| 494 | Tải mã không kiểm toàn vẹn | ✅ | Extension bundle giới hạn ở origin allowlist HTTPS + SSRF guard; toàn vẹn lockfile pnpm cho dependency. Nên cân nhắc thêm SRI hash mỗi bundle để cứng hóa. |
| 829 | Bao gồm từ nguồn không tin cậy | ✅ | `index.html` của Studio chỉ nạp module local; không có script CDN. |
| 345 | Tính xác thực dữ liệu | ✅ | Webhook ra ký HMAC-SHA256 kèm timestamp (`modules/notifications/webhook-channel.ts:144`); webhook deployment vào xác minh theo từng provider bằng so sánh constant-time. |

### B6. Phân quyền & vận hành (10)

| CWE | Điểm yếu | Verdict | Bằng chứng / ghi chú |
|-----|----------|---------|----------------------|
| 285 | Phân quyền sai (diện rộng) | ✅ | Route flows/AI/CDC/uploads/shares đều ép kiểm admin hoặc PermissionService ở tầng middleware. |
| 565 | Dựa vào cookie không kiểm | — | Không dùng cookie. |
| 367 | TOCTOU | ✅ | **Đã vá 2026-07-06.** Cùng cách vá CWE-362 — quyết định decide/reject phê duyệt nay là UPDATE nguyên tử có guard (`WHERE status='pending'` + kiểm số dòng). |
| 778 | Ghi log không đủ | ✅ | 15 mã sự kiện audit gồm login thành công/thất bại, lockout, recovery, từ chối API-key, thao tác role (`modules/audit/logger.ts:134`). |
| 223 | Bỏ sót thông tin liên quan bảo mật | ✅ | Bản ghi audit mang actor, IP, user-agent, requestId, timestamp. |
| 532 | Thông tin nhạy cảm trong log | ✅ | `maskSensitive` thay field secret bằng prefix SHA-256 8 ký tự, đệ quy (`modules/audit/logger.ts:67`). |
| 548 | Liệt kê thư mục | — | Không serve tĩnh thư mục. |
| 668 | Tài nguyên lộ sai phạm vi | ✅ | **Đã vá 2026-07-06.** `/health` chỉ lộ chi tiết subsystem cho caller có observability token; probe ẩn danh chỉ nhận `{ status }`. `/metrics` ép `METRICS_TOKEN` ở mọi môi trường khi được đặt. |
| 1104 | Thành phần bên thứ ba không bảo trì | ✅ | **Đã vá 2026-07-06.** Thêm `.github/dependabot.yml` (weekly npm + github-actions, gộp minor/patch) và job CI `dependency-audit` chạy đầy đủ `pnpm audit` và fail khi có advisory high/critical. |
| 359 | Vi phạm quyền riêng tư | ✅ | **Đã vá 2026-07-06.** Masker audit nay che các key payload thô (`data`/`payload`/`content`/`body` → `[redacted]`) và cap chuỗi tự do dài, nên PII của item không lọt nguyên văn vào metadata audit (`modules/audit/logger.ts`). Sự kiện audit item vốn chỉ log id + SQL đã redact. |

---
<!-- check-parity: allow inline-code -->

## Danh sách khắc phục (theo thứ tự ưu tiên)

Toàn bộ các mục đã hoàn tất tính đến 2026-07-06.

1. ~~**CWE-620/613 — Đổi mật khẩu & thu hồi phiên.**~~ ✅ Endpoint đổi mật khẩu yêu cầu mật khẩu hiện tại + thu hồi qua `token_version` khi đổi/reset.
2. ~~**CWE-302 — Ranh giới tin cậy trong middleware.**~~ ✅ `withSiteMembership` ràng buộc `X-Lumi-Site`; role Cloudflare Access nay ánh xạ từ DB.
3. ~~**CWE-400 — Rate limit API.**~~ ✅ `withRateLimit()` throttle per-principal/per-IP trên API đã xác thực (bao gồm REST + GraphQL vì dùng chung chuỗi).
4. ~~**CWE-521/203 — Cứng hóa đăng ký.**~~ ✅ `PasswordSchema` dùng chung (12+độ phức tạp) ở register/setup/recovery; register validate trả 400. (Register là chỉ-admin nên `EMAIL_ALREADY_EXISTS` không phải vector liệt kê ẩn danh.)
5. ~~**CWE-89 — DDL materialize.**~~ ✅ `sql.raw()` thay bằng bind parameter + `sql.identifier()`; id trong thân trigger validate fail-closed.
6. ~~**CWE-362/367 — Quyết định phê duyệt nguyên tử.**~~ ✅ `UPDATE … WHERE id = ? AND status = 'pending'` + kiểm số dòng.
7. ~~**CWE-1104 — Vệ sinh dependency.**~~ ✅ dependabot + cổng CI `pnpm audit` (fail khi high/critical).
8. ~~**CWE-359 — Quyền riêng tư audit-log.**~~ ✅ Che key payload + cap chuỗi dài trong masker audit.
9. ~~**CWE-942 — CORS dev.**~~ ✅ Không bao giờ wildcard-kèm-credentials; chỉ reflect loopback khi không có allowlist.
10. ~~**CWE-321 — Khóa fallback CDC.**~~ ✅ Bỏ fallback trong repo; fail-closed khi thiếu `ENCRYPTION_KEY`.
11. ~~**CWE-668/284 — Health & metrics.**~~ ✅ Chi tiết subsystem sau observability token; `/metrics` ép token ở mọi env.

### Cứng hóa tương lai (không chặn; ngoài phạm vi top-100)
- Quota API chính xác per-endpoint bằng counter nguyên tử (Durable Object / Redis `INCR`) — limiter hiện tại là xấp xỉ fixed-window trên cache kiểu KV.
- Đưa audit log vào quy trình data-erasure (hoặc công bố chính sách lưu trữ/xoay rõ ràng) khi PII của item đã không còn nằm trong đó.

## Tài liệu liên quan

- `docs/vi/security/route-guards.md` — kiểm kê guard cấp route
- `docs/vi/security/idor-testing.md` — hướng dẫn test IDOR
- `docs/vi/security/runtime-security-guards-plan.md` — lộ trình guard
- `docs/en/security/external-jwt-auth.md` — xác minh issuer external
- `docs/vi/security/dependency-overrides.md` — lý do ghim dependency
