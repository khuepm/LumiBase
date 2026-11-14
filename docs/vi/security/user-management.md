---
version: 12
lastUpdated: 2026-11-14T02:15:28.142Z
sourceLang: en
translatedFrom: en
sourceHash: cefe43edb3328c1d
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:15:28.142Z
codeVerifiedHash: cefe43edb3328c1d
codeVerifiedClaims: 122
---

# User Management Best Practices

> **Đối tượng:** operator và integrator đang nối một frontend công khai (ví
> dụ Next.js) tới một site LumiBase nơi khách truy cập đăng ký, đăng nhập và
> đọc nội dung — trong khi staff quản lý nội dung đó trong Studio.
>
> **TL;DR:** Một bảng `users` toàn cục duy nhất là ổn và đúng chủ đích. Thứ
> giữ cho nó an toàn là **ranh giới phân quyền giữa các realm**, không phải
> các bảng riêng biệt. Khách tự phục vụ nhận role `subscriber` đặc quyền tối
> thiểu (`appAccess: false`); staff chỉ được onboard qua invite với role
> Studio; session token mang một claim `aud` để một token frontend không bao
> giờ có thể chạm tới Studio. Xem **ADR-011** để có bản ghi quyết định.

---

## 1. Câu hỏi cốt lõi: bảng dùng chung vs. realm riêng biệt

Một câu hỏi thường gặp: *"Nếu khách frontend đăng ký vào chung một bảng với
admin thì không nguy hiểm sao?"*

Có hai cách hiểu:

| Cách diễn giải | Phán quyết |
|----------------|-----------|
| Cấp cho user tự đăng ký một **admin role** | ❌ Không bao giờ. Thảm họa. |
| Lưu họ trong **cùng bảng `users`**, role khác nhau | ✅ Ổn — *với điều kiện* phân tách realm nghiêm ngặt |

Rủi ro nằm ở **ranh giới phân quyền**, không phải ở bảng. LumiBase giữ một
kho định danh duy nhất và phân tách *realm* theo role + token audience. Lợi
ích của một kho duy nhất: một định danh con người duy nhất (một người có thể
là staff ở một site và là subscriber ở một site khác), auth đồng nhất, không
có sự trôi dạt do tài khoản trùng lặp.

### Tổng quan các realm

| Realm | Ai | Role | `appAccess` | Onboarding | Auth |
|-------|-----|------|-------------|------------|------|
| **Staff** | editor, admin, đồng đội | `administrator`, `member` | `true` | Invite-only (`POST /users/invite`) | CF Access JWT, hoặc password `/login` (Studio token) |
| **Frontend end-user** | khách công khai / subscriber | `subscriber` | `false` | Tự phục vụ công khai (`POST /auth/register`) | password `/login` (frontend token) |
| **Integration** | server-to-server (ISR, build) | n/a (API key) | theo policy đính kèm | Admin tạo API key | `Authorization: Bearer lbk_…` |
| **Organization key** | tự động hóa organization | `admin` cố định | kế thừa administrator tại site | Owner/admin tạo qua `/orgs/:orgId/keys` | `Authorization: Bearer lbo_…` |

---

## 2. Data model (kho định danh duy nhất)

```
users (global)                 ← one row per human identity
  ├─ id (nanoid), email, passwordHash?, status (active|invited|suspended)
  └─ isBootstrap
user_sites (membership N–N)     ← which sites + the PRIMARY role there
  └─ (userId, siteId) → roleId
roles (per site)                ← administrator | member | subscriber | custom
  └─ adminAccess, appAccess, systemKey
policies → permissions          ← what a role can actually do (Policy DSL, ADR-008)
organization_members (membership N–N)
  └─ (userId, organizationId) → owner | admin | billing | member
organizations → sites.organizationId
api_keys → site role/policy links OR fixed organization admin (scope=organization)
```

- Query thuộc site lọc theo `site_id`; query thuộc organization lọc theo `organization_id`. Postgres RLS là lớp phòng thủ chiều sâu khi `LUMIBASE_DB_RLS=enforce` (B130; mặc định tắt).
- **`subscriber`** là role frontend đặc quyền tối thiểu. Nó không cấp gì cho
  tới khi bạn gắn quyền đọc nội dung vào nó (ví dụ `articles::read WHERE
  status = 'published'`). Nó được tạo idempotent ở lần đăng ký đầu tiên
  (`ensureSubscriberRole`), nên các instance hiện có không cần backfill.

> ⚠️ **Không bao giờ gắn policy Studio/admin vào `subscriber`.** Toàn bộ mục
> đích của role đó là làm mặt sàn an toàn cho các đăng ký tự phục vụ.

---

## 2b. Chính sách định danh email (alias)

`users` là định danh toàn cục, nên câu hỏi "hai địa chỉ này có phải cùng một
tài khoản không?" là câu hỏi ở cấp instance. Trước #794 quy tắc duy nhất là
`lower(email)`: `test+a@gmail.com`, `test+b@gmail.com` và `t.est@gmail.com` là
ba tài khoản cùng nhận thư vào một hộp thư. Giờ policy được chọn tường minh, ở
hai tầng — và một site chỉ có thể **chặt hơn** instance:

| Mode của instance | Site `strict` | Kết quả |
|---|---|---|
| `exact` (mặc định) | tắt (mặc định) | Hành vi trước #794: mỗi địa chỉ khác nhau là một tài khoản riêng |
| `exact` | bật | Alias vẫn tồn tại toàn cục, nhưng site chỉ nhận một membership cho mỗi hộp thư gốc |
| `root` | bất kỳ | Một hộp thư gốc = một tài khoản trên toàn instance; cờ của site không có tác dụng |

Hộp thư gốc: `+tag` bị bỏ khỏi phần local trên mọi domain (giữ `+` ở đầu);
với Gmail phần local còn bỏ dấu chấm và `googlemail.com` quy về `gmail.com`.

> **Đây là một policy, không phải bảo đảm về việc giao thư.** Sub-addressing
> (`+tag`) là quy ước của từng nhà cung cấp. Trên domain không hỗ trợ nó,
> `a+b@example.com` có thể là hộp thư khác với `a@example.com`, nhưng mode
> `root` (hoặc site strict) vẫn coi chúng là một định danh — nên các chủ hộp thư
> đó tranh nhau một tài khoản hoặc một membership. Chỉ chọn `root` / strict khi
> chấp nhận được đánh đổi này với tập người dùng của mình; mode mặc định `exact`
> không bao giờ áp dụng nó.

Quy tắc nằm ở hai nơi, `emailRoot()`
(`apps/cms/src/modules/email-identity/normalize.ts`) và hàm SQL
`lumibase_email_root()` (migration `0027`); một integration test ghim cả hai
vào cùng một danh sách fixture. Trigger database ghi `users.email_canonical` /
`users.email_root` và `user_sites.identity_key`, nên mọi writer — register,
invite, SCIM, setup, seed — đều gán khoá giống nhau, và unique index (không
phải kiểm-tra-rồi-chèn) bảo đảm kết quả.

**Chọn và thay đổi.** Mode của instance được chọn trong Setup Wizard (bước
Security, hoặc bước review của quick setup); instance hiện có được backfill
thành `exact`, nên nâng cấp không thay đổi gì. Về sau chỉ bootstrap admin đổi
được (`PUT /api/v1/admin/email-identity/instance`); site admin bật/tắt strict
cho site của mình (`PUT /api/v1/admin/email-identity/site`). Siết chặt sẽ kiểm
tra trước và từ chối bằng `409 IDENTITY_COLLISION` kèm danh sách tài khoản xung
đột — gộp hoặc đổi địa chỉ các tài khoản đó rồi thử lại. Nới lỏng luôn thành
công. Cả hai nhận `dryRun: true`, và mọi thay đổi được áp dụng đều có audit log.

**Quyết định.**

- **Dưới `root`, đăng nhập bằng alias nào cũng được.** `POST /auth/login` (và
  forgot-password / resend-verification) resolve địa chỉ được gõ về tài khoản
  theo hộp thư gốc, nên `test+anything@gmail.com` đăng nhập vào tài khoản
  `test@gmail.com` bằng mật khẩu của tài khoản đó. Đây là hệ quả của "một hộp
  thư = một tài khoản": mọi alias đều giao thư vào cùng inbox, nên không cấp
  thêm quyền nào mà chủ hộp thư chưa có.
- **Lockout theo từng hàng tài khoản, không theo địa chỉ được gõ.** Lần thất
  bại được đếm theo địa chỉ đã lưu của tài khoản được resolve và khoá được đặt
  lên chính hàng đó theo khoá chính; bước pre-check đọc khoá qua cùng phép
  resolve. Xoay vòng alias không reset bộ đếm và không né được khoá. Lần thử với
  địa chỉ không khớp tài khoản nào vẫn được đếm theo địa chỉ được gõ (và theo
  IP) như trước.
- **Chống dò tài khoản (anti-enumeration) không đổi.** `/register` trả cùng
  `202` chung dù địa chỉ, một alias của nó, hay một alias trên site strict đã
  tồn tại; tài khoản và membership được commit trong một transaction, nên
  membership bị từ chối không bao giờ để lại tài khoản mồ côi.

Liên kết nhiều định danh ngoài (social / SSO) vào một tài khoản là việc tiếp
theo tách riêng (`user_identities`), không thuộc policy này.

---

## 3. Các phương thức xác thực

`withAuth` (`apps/cms/src/middleware/auth.ts`) thử, theo thứ tự:

1. **Dev token** (`Bearer dev:<email>:<role>`) — chỉ dùng cho dev cục bộ,
   được gate ba lớp.
2. **Cloudflare Access JWT** (header `cf-access-jwt-assertion`) — luồng
   **staff/Studio** chính trong production.
3. **API key** (`Authorization: Bearer lbk_…`) — integration principal.
4. **Custom JWT** (`Authorization: Bearer <HS256>`) — phát bởi
   `POST /auth/login` cho cả staff (khi không dùng CF Access) và subscriber
   frontend.

### Token audiences (`aud`)

Custom JWT mang một claim `aud` được ghim tại thời điểm ký
(`services/auth/token-audience.ts`):

| `aud` | Ý nghĩa | Chạm được Studio? | Access TTL | Refresh TTL |
|-------|---------|-------------------|-----------|-------------|
| `studio` | bootstrap admin hoặc một role có `appAccess` | ✅ (vẫn phụ thuộc `appAccess`/TFA) | `12h` (`STUDIO_SESSION_TTL`) | `30d` (`STUDIO_REFRESH_TTL`) |
| `frontend` | subscriber / role không có appAccess | ❌ **bị `withStudioAccess` từ chối cứng** | `30d` (`FRONTEND_SESSION_TTL`) | `90d` (`FRONTEND_REFRESH_TTL`) |
| `email-verify` | token link đăng ký dùng một lần | n/a (không phải session token) | 24h (link) | — |
| `password-reset` | token link đặt lại mật khẩu dùng một lần | n/a (không phải session token) | 1h (link) | — |
| `mfa-challenge` | token step-up dùng một lần, giữa mật khẩu và TOTP (§4f) | n/a (không phải session token) | 5m | — |

**TTL theo từng realm** (`sessionTtlFor` / `refreshTtlFor`): hai realm không
còn dùng chung một vòng đời — session của staff ngắn (mục tiêu giá trị cao,
re-auth rẻ), session của subscriber dài (UX tốt hơn, rủi ro thấp). Access JWT
là credential làm việc; refresh token (§4d) âm thầm gia hạn nó cho tới chân
trời refresh. Các giá trị override chấp nhận một duration gọn (`12h`, `30d`)
hoặc một số giây; một giá trị sai định dạng sẽ rơi về mặc định để một lỗi gõ
không làm hỏng đăng nhập.

Bức tường audience là **defense-in-depth**: kể cả khi một role bị cấu hình
sai để cấp `appAccess`, một token `frontend` vẫn bị từ chối trước khi bundle
policy được tra cứu.

---

## 4. Luồng tự đăng ký (khách frontend)

```
Visitor (Next.js)            CMS                              Email
     │  POST /auth/register   │                                 │
     │ {email,password,name}  │  rate-limit per IP (cache)       │
     │───────────────────────▶│  create user status=invited     │
     │                        │  bind subscriber role (server)   │
     │                        │  sign email-verify JWT ──────────▶ verification link
     │   202 (generic)        │  audit: user_registered          │
     │◀───────────────────────│                                 │
     │                                                          │
     │  click link → frontend reads ?token=…                    │
     │  POST /auth/verify-email {token}                         │
     │───────────────────────▶│  verify JWT, status→active       │
     │   {status:'verified'}  │  audit: email_verified           │
     │◀───────────────────────│                                 │
     │  POST /auth/login {email,password}                       │
     │───────────────────────▶│  LoginGuard + anomaly checks     │
     │  {token (aud=frontend)} │  status must be 'active'         │
     │◀───────────────────────│                                 │
     │  GET /items/articles  (Authorization: Bearer <token>)    │
```

### Endpoints

| Endpoint | Auth | Ghi chú |
|----------|------|-------|
| `POST /api/v1/auth/register` | public | Tạo `subscriber`, `status=invited`. Rate-limit theo IP. Trả về `202` chung (không enumeration). |
| `POST /api/v1/auth/verify-email` | public | Body `{token}` (hoặc `?token=`). Lật `invited`→`active`. Idempotent (`already_verified`). |
| `POST /api/v1/auth/login` | public | Phát JWT `frontend`/`studio`. Bị gate bởi `status='active'`, LoginGuard, bộ dò bất thường. |
| `POST /api/v1/auth/resend-verification` | public | Body `{email}`. Rate-limit theo IP. `202` chung; chỉ gửi lại link kích hoạt cho một tài khoản dựa-trên-mật-khẩu chưa active (khôi phục khi mất email). |
| `POST /api/v1/auth/forgot-password` | public | Body `{email}`. Rate-limit theo IP. `202` chung (không enumeration); chỉ gửi link reset cho một tài khoản active, dựa-trên-mật-khẩu. |
| `POST /api/v1/auth/reset-password` | public | Body `{token,password}`. Tiêu thụ một token `password-reset` stateless (TTL 1h), đặt hash mật khẩu mới, và revoke tất cả refresh token. |
| `POST /api/v1/auth/refresh` | public | Xoay refresh token được trình ra (cookie hoặc body `{refreshToken}`) → access JWT mới + refresh token đã xoay. Việc dùng lại một token đã revoke sẽ revoke toàn bộ family. |
| `POST /api/v1/auth/logout` | public | Revoke family của refresh token được trình ra và xóa cookie. Idempotent. |
| `POST /api/v1/me/change-password` | bearer | Body `{currentPassword,newPassword}`. Xác minh mật khẩu hiện tại, đặt hash mới, revoke tất cả refresh token. |
| `GET /api/v1/me/sessions` | bearer | Các session đang hoạt động của caller (refresh token còn sống), đã redact. |
| `DELETE /api/v1/me/sessions/:id` | bearer | Revoke một trong các session của chính caller (`:id` = `sessionId`); có hiệu lực ngay. |
| `DELETE /api/v1/me/sessions` | bearer | Revoke TẤT CẢ session của caller (logout mọi nơi); `?scope=others` giữ lại session hiện tại. |
| `GET /api/v1/auth/me` | bearer | Principal hiện tại kèm `isFrontendUser`. |

### Guardrail được nướng sẵn vào

1. **Role do server quyết định** — body của request không thể chọn role.
2. **Xác minh email** — chưa active cho tới khi verify; JWT `email-verify`
   stateless (24h), không bảng token, dùng một lần qua chuyển trạng thái.
3. **Rate limit theo IP** — `DEFAULT_REGISTRATION_RATE_LIMIT` (5/giờ),
   best-effort, fail open khi cache gặp sự cố.
4. **Chống liệt kê** — `202` giống hệt nhau bất kể email có tồn tại hay không;
   chỉ hash mật khẩu trên đường dẫn email-mới.

### Cấu hình bắt buộc

| Env | Mục đích |
|-----|---------|
| `JWT_SECRET` | Ký Custom JWT **và** token email-verify/reset. Bắt buộc. |
| `STUDIO_SESSION_TTL`, `FRONTEND_SESSION_TTL` | TTL access-token theo từng realm, tùy chọn (mặc định `12h` / `30d`). |
| `STUDIO_REFRESH_TTL`, `FRONTEND_REFRESH_TTL` | TTL refresh-token / chân trời đăng nhập theo từng realm, tùy chọn (mặc định `30d` / `90d`). |
| `REFRESH_COOKIE_SAMESITE`, `REFRESH_COOKIE_DOMAIN`, `REFRESH_COOKIE_SECURE` | Thuộc tính refresh-cookie cross-domain, tùy chọn (xem §4d). |
| `LUMIBASE_SMTP_URL`, `LUMIBASE_MAIL_FROM` | Email xác minh gửi đi. Thiếu nó, user vẫn ở `invited` (không link nào được gửi). |
| `CORS_ALLOWED_ORIGINS` | Phải bao gồm origin Next.js của bạn. |
| site `siteUrl` | Dựng link `…/verify-email?token=` trong email. |

---

## 4b. Cấp cho subscriber quyền đọc nội dung

Một subscriber vừa đăng ký có thể đăng nhập nhưng **không thấy gì** — role
`subscriber` trống theo thiết kế. Cấp quyền đọc nội dung một cách tường minh
(chỉ admin, `requireSiteAdmin`):

```
# Subscribers can read PUBLISHED articles (default publishedOnly=true)
POST /api/v1/users/subscriber-access
  { "collection": "articles" }

# All rows, only some fields:
POST /api/v1/users/subscriber-access
  { "collection": "pages", "publishedOnly": false, "fields": ["title","body"] }

GET    /api/v1/users/subscriber-access            # list current grants
DELETE /api/v1/users/subscriber-access/articles   # revoke
```

Việc này gắn quyền `read` (Policy DSL) vào một policy `subscriber` dùng chung
được bind với role — `publishedOnly: true` biên dịch thành bộ lọc cấp hàng
`{ status: { _eq: 'published' } }`. Các cấp quyền có hiệu lực trong khoảng
~60s đối với các subscriber đã xác thực từ trước (TTL cache bundle của
PermissionService).

> Dùng cách này thay vì sửa tay policy trong Studio khi bạn chỉ muốn
> "subscriber có thể đọc X đã publish" — đó là primitive tối thiểu, có audit.

### Email templates

Các email verification, resend, và reset render một template DB của site khi
có một template tồn tại (và được bật), nếu không thì dùng một fallback inline
tích hợp sẵn — nhờ vậy các luồng hoạt động ngay từ đầu. Để tùy biến, thêm một
email template đã bật với key:

| Key | Được dùng bởi | Vars |
| --- | --- | --- |
| `email_verification` | register + resend-verification | `email`, `siteName`, `siteUrl`, `verifyUrl`, `token` |
| `password_reset` | forgot-password | `email`, `siteName`, `siteUrl`, `resetUrl`, `token` |

`verifyUrl`/`resetUrl` rỗng khi site không có `siteUrl`; nếu không thì link là
`${siteUrl}/verify-email?token=…` / `${siteUrl}/reset-password?token=…`.

## 4c. Quên / đặt lại mật khẩu (người dùng cuối)

Khôi phục mật khẩu tự phục vụ (khác với khôi phục bằng backup-code của admin
trong Setup Wizard):

```
POST /auth/forgot-password { email }      → generic 202; emails a 1h reset link
   (link → frontend /reset-password?token=…)
POST /auth/reset-password  { token, password }  → sets new password hash
```

Token reset là một JWT `password-reset` stateless (cùng khuôn với xác minh
email). Đánh đổi: không revoke được theo từng token và link giữ hiệu lực cho
tới hết TTL 1h; rotate `JWT_SECRET` để vô hiệu hóa tất cả các link còn treo.
Một lần reset thành công **revoke tất cả refresh token** của user, nên các
session hiện có không thể được âm thầm gia hạn nữa (bất kỳ access JWT nào còn
hợp lệ chỉ sống sót cho tới khi hết TTL ngắn của nó).

## 4d. Gia hạn session âm thầm (refresh tokens)

Access JWT (`12h`/`30d`) là một credential làm việc ngắn (hơn); một **refresh
token** xoay vòng, được server theo dõi sẽ gia hạn nó mà không cần nhập lại
credential, lên tới chân trời refresh của realm (mặc định `studio` 30d /
`frontend` 90d, env `STUDIO_REFRESH_TTL` / `FRONTEND_REFRESH_TTL`).

```
POST /auth/login    → { token, refreshToken, refreshTokenExpiresAt }  (+ httpOnly cookie)
POST /auth/refresh  → { token, refreshToken, refreshTokenExpiresAt }  (rotates; cookie or body)
POST /auth/logout   → revokes the family + clears the cookie
```

Mô hình bảo mật (`services/auth/refresh-token.ts`, bảng
`lumibase_refresh_tokens`):

- **Hash khi lưu trữ (at rest)** — chỉ `sha256(plaintext)` được lưu; plaintext
  được trả về một lần cho mỗi lần login/refresh.
- **Xoay vòng (rotation)** — mỗi lần refresh revoke hàng được trình ra và phát
  một kế nhiệm trong cùng `familyId` (dùng một lần).
- **Phát hiện dùng lại** — trình ra một token đã bị revoke (tín hiệu bị đánh
  cắp) sẽ revoke toàn bộ family, buộc phải đăng nhập lại. Một lần double-submit
  vô hại cũng kích hoạt điều này — cái giá chấp nhận được của rotation nghiêm
  ngặt.

**Transport — cả hai:** token được đặt như một cookie `httpOnly` (scope theo
path `/api/v1/auth`) **và** được trả về trong body. Cookie hợp với ứng dụng
trình duyệt; giá trị trong body hợp với SPA/SDK cross-origin nơi cookie có thể
bị bỏ.

Thuộc tính cookie có thể cấu hình qua env cho các thiết lập cross-domain
(`refreshCookieSettings`):

| Env | Mặc định | Ghi chú |
| --- | --- | --- |
| `REFRESH_COOKIE_SAMESITE` | `Lax` | Đặt `None` khi frontend nằm trên một **site khác** với API (cross-site). `None` buộc `Secure`. `Strict` cũng được chấp nhận. |
| `REFRESH_COOKIE_DOMAIN` | _(host-only)_ | ví dụ `.example.com` để chia sẻ cookie qua các subdomain (`app.` ↔ `api.`). |
| `REFRESH_COOKIE_SECURE` | `true` | Chỉ đặt `false` cho dev `http` cục bộ. Bị bỏ qua (buộc `true`) khi SameSite=`None`. |

Đối với một frontend trình duyệt cross-site, bạn cũng phải: phục vụ cả hai qua
HTTPS, đặt `CORS_ALLOWED_ORIGINS` thành đúng origin frontend (không `*`), và
để client gửi `credentials: 'include'`.

**CSRF:** vì cookie là ambient (tự động gửi dưới `SameSite=None`), `/refresh`
và `/logout` yêu cầu một header tùy chỉnh **`X-LumiBase-Refresh`** khi token
đến từ cookie. Một simple request cross-site không thể đặt một header tùy
chỉnh (và làm vậy từ JS sẽ kích hoạt một CORS preflight mà server gate), nên
điều này trung hòa CSRF cho đường cookie. Các caller dùng body-token được
miễn. Header này nằm trong allow-list của CORS; các client cross-site phải gửi
nó (bất kỳ giá trị non-empty nào).

## 4e. Tự phục vụ tài khoản (đã xác thực)

Đối với một user đã đăng nhập (`bearer`, dưới `/api/v1/me`):

- **Đổi mật khẩu** — `POST /me/change-password` xác minh mật khẩu hiện tại,
  đặt hash mới, và revoke tất cả refresh token để các session khác không thể
  âm thầm được gia hạn. Tài khoản SSO/passwordless nhận `NO_PASSWORD`.
- **Quản lý session** — giờ đây khi refresh token được theo dõi,
  `GET /me/sessions` liệt kê các session đang hoạt động của caller (không có
  vật liệu token), `DELETE /me/sessions/:id` revoke một cái, và
  `DELETE /me/sessions` revoke tất cả (logout mọi nơi). Các hàng đã
  hết-hạn/revoke được dọn bởi tiến trình prune hằng giờ (§4d).
- **Session & thiết bị (#730).** Một *session* là một rotation family của
  refresh token. Mỗi lần login và refresh đều ký family id vào access JWT
  dưới dạng `sid`, nên:
  - mỗi hàng của `GET /me/sessions` có `sessionId` ổn định (giữ nguyên qua
    rotation), `startedAt` (token cũ nhất còn lưu của session),
    `lastSeenAt` (lần refresh gần nhất), `lastIp`, `lastUserAgent` và
    `current: true` cho session đang gửi request;
  - `DELETE /me/sessions/:id` nhận `sessionId` (row `id` đang sống vẫn dùng
    được cho client cũ) và trả về `{ sessionId, revoked, current }`; revoke
    session hiện tại thì cookie refresh cũng bị xoá;
  - `DELETE /me/sessions?scope=others` đăng xuất mọi session trừ session
    hiện tại (`{ status: 'other_sessions_revoked', revoked }`). Token không
    có `sid` nhận `409 NO_CURRENT_SESSION` thay vì bị coi là "all";
  - **revoke có hiệu lực ngay trên cả hai runtime**: `withAuth` từ chối
    access JWT có `sid` không còn hàng refresh nào sống (một lookup có index
    mỗi request bearer, chạy trên system handle để token Studio thao tác ở
    site anh em vẫn resolve được). Access token ký trước khi có `sid` bỏ qua
    kiểm tra này cho tới khi hết hạn;
  - **xác nhận enroll TOTP** (`POST /me/tfa/confirm`) đăng xuất mọi session
    *khác* — chúng được xác thực chỉ bằng mật khẩu — và giữ lại thiết bị vừa
    enroll. Đổi/reset mật khẩu vẫn huỷ mọi session, kể cả session hiện tại
    (tăng `tokenVersion`);
  - audit event: `session_revoked` (`sessionId`, `current`) và
    `sessions_revoked` (`scope: all | others`, `revoked`); `mfa_enrolled`
    có thêm `revokedOtherSessions`.

  Studio hiển thị danh sách ở **Settings → Security → Active sessions**,
  với nút "Sign out" cho từng thiết bị và "Sign out other sessions".

## 4f. Xác thực hai yếu tố (TOTP)

Native, theo từng user, **opt-in**. Việc enroll nằm trong Studio ở
**Settings → Security**; không có bước wizard và không có công tắc ở mức
tenant (chính cờ policy `enforceTfa` sẵn có mới là thứ làm 2FA thành bắt
buộc cho một role). Chỉ realm `studio` bị thử thách — login của subscriber
(`frontend`) không bị ảnh hưởng.

**Login thành hai chặng.** `POST /auth/login` xác minh mật khẩu như trước,
rồi nếu user có credential TOTP đã verify, nó trả về
`{ status: 'mfa_required', challengeToken, expiresIn }` thay vì một session.
Client post token đó cùng một code tới `POST /auth/verify-totp`, và nhận lại
payload login thông thường với `amr: ["pwd", "totp"]`.

Challenge token là một JWT HS256 sống 5 phút trên audience `mfa-challenge`,
nên `withAuth` sẽ không bao giờ nhận nó như một session; `jti` của nó được
ghi vào cache provider khi dùng, nên một token bị chặn bắt cũng không replay
được. `verify-totp` là public path (caller chưa có session) nên nó nằm trong
các tập public của `withAuth`, `site-membership` và `studio-access` — handler
lấy `userId`/`siteId` từ challenge đã ký, không bao giờ từ input của client,
và kiểm lại `siteId` của challenge với tenant đã resolve. Số lần thử bị giới
hạn theo user (10) và theo IP (30) mỗi 15 phút.

**Secret nằm ở đâu.** Seed base32 chỉ được ghi dưới dạng envelope AEAD của
KeyProvider (`lumibase_user_totp_credentials.secret_ciphertext` +
`secret_key_id`), nên enroll ở production đòi `ENCRYPTION_KEY`. Seed thô được
trả về đúng một lần, bởi `POST /me/tfa/setup`, và sau đó không đọc lại được.
Tám recovery code hiện một lần và được lưu dưới dạng hash PBKDF2
(`lumibase_user_totp_recovery_codes`), dùng-một-lần, có ghi lại IP đã dùng.
Replay trong cùng cửa sổ verify bị `last_used_step` chặn. `users.tfa` chỉ giữ
trạng thái enrollment không bí mật.

**Thay đổi 2FA cần step-up.** Setup, tạo lại recovery code, và tháo — cả ba
đều đòi mật khẩu hiện tại; hai cái sau còn đòi thêm yếu tố thứ hai — một TOTP
code sống, hoặc, chỉ với thao tác tháo, một recovery code, để user có seed
không còn giải mã được vẫn tháo được yếu tố đã chết. Tháo
2FA sẽ bump `tokenVersion` và thu hồi refresh token, nên một session bị đánh
cắp không thể âm thầm hạ mức bảo vệ của tài khoản. Enroll và tháo đều ghi
audit event (`mfa_enrolled` / `mfa_disabled`); verify thất bại ghi
`mfa_verify_failed`. TOTP code, seed, recovery code và challenge token đều
nằm trong danh sách loại bỏ của audit logger, nên không cái nào chạm được
vào audit trail.

**Vòng đời khoá.** Seed được bọc bằng khoá đang active tại thời điểm enroll,
và dòng dữ liệu ghim version đó ở `secret_key_id`; lúc giải mã thì khoá được
lấy theo envelope. Hai hệ quả mà operator hay hiểu sai: migration envelope
(`POST /admin/encryption/envelope/migrate`) chỉ bọc lại field item và không
bao giờ chạm bảng này, nên **khoá cũ phải được giữ trong cấu hình chừng nào
còn seed tham chiếu tới nó**; và vì một khoá dùng chung toàn deployment bọc
mọi seed, **rotate sau khi lộ khoá không bảo vệ được các enrollment đã có** —
những user đó phải enroll lại. AAD (`totp-secret|<userId>`) chặn việc replay
ciphertext của user này dưới id của user khác; nó không phải một biên bảo
mật. Quy trình đầy đủ ở
[Vận hành khoá mã hoá](../operations/encryption-keys.md).

**Đa tenant.** Một credential TOTP thuộc về **định danh**, không thuộc về
site — các bảng chỉ khoá theo `user_id`, khớp với kho định danh duy nhất (§2)
và bảng `lumibase_admin_backup_codes` sẵn có. Enroll một lần là bảo vệ login
của user trên mọi site họ thuộc về, và đó là hành vi mong muốn; không có
enroll theo từng site và không có gì phải cô lập theo `site_id`. Các tác dụng
phụ có phạm vi tenant thì vẫn có: audit event được ghi với `siteId` của
request, và tháo 2FA thu hồi refresh token của site hiện tại. Các env knob là
ở mức deployment: `ENCRYPTION_KEY` (bắt buộc để enroll) và
`LUMIBASE_TOTP_ISSUER` (nhãn trong app authenticator, mặc định `LumiBase`).

**Passkey.** Passkey (WebAuthn) đứng cạnh TOTP: là yếu tố thứ hai sau mật khẩu
(`amr: ["pwd","webauthn"]`) hoặc đăng nhập staff không mật khẩu
(`amr: ["webauthn"]`), cả hai đều đặt `tfaVerified`. Khi người dùng có passkey,
`/auth/login` trả `methods` trong phản hồi `mfa_required`. Mã khôi phục dùng
chung với TOTP. Xem [Passkey](./passkeys.md).

## 5. Onboarding staff (KHÔNG dùng tự phục vụ)

Staff được tạo **invite-only**:

```
POST /api/v1/users/invite     (requireSiteAdmin)
  { "email": "editor@acme.com", "roleId": "<member|administrator role id>" }
```

Việc này tạo/liên kết user với một role Studio (`appAccess: true`) và gửi một
email mời best-effort. Cưỡng chế TFA trên các admin role qua một policy với
`enforceTfa: true` (`withStudioAccess` khi đó yêu cầu một session đã verify
TFA).

---

## 6. Ghi chú tích hợp frontend (Next.js)

- **Lưu token** như một cookie httpOnly, `Secure`, `SameSite` được đặt bởi
  route handler Next.js của bạn — không phải trong `localStorage` (rò rỉ do
  XSS).
- **Gửi tenant**: đính kèm `X-Lumi-Site: <siteId>` (hoặc dựa vào phân giải
  subdomain) trên mọi lời gọi CMS.
- **Không bao giờ gọi các Studio API** (`/collections`, `/roles`, `/users`,
  …) từ frontend công khai — chúng yêu cầu một token `studio` và `appAccess`;
  một token `frontend` bị từ chối theo thiết kế.
- **Dùng một API key cho các đọc server-to-server** ở build-time/ISR, không
  phải một user token; scope nó về một policy chỉ-đọc.
- **Vòng đời token** là 24h; hãy hiện thực một UX refresh/re-login.

---

## 7. Quản lý user và organization qua MCP

Stdio server trong `packages/mcp-server` đã có quản lý user/team của site, gồm `list_users`, `get_user`, `invite_user`, `update_user` và `remove_user`. ADR-013 thêm phạm vi organization riêng; cấp administrator ở site không cấp quyền organization.

### Cấu hình credential

| Credential | Tool được công bố | Định tuyến site |
|---|---|---|
| `lbk_` | Danh sách tool site hiện có | Bắt buộc `LUMIBASE_SITE_ID` |
| `lbo_` ghim site | Tool site cộng `get_organization`, `list_sites` | Site đã ghim |
| `lbo_` không ghim | Tám tool organization cộng tool site | Mỗi tool site cần `site`; lời gọi organization không gửi header site |

`LUMIBASE_READ_ONLY=true` ẩn tool ghi ở mọi cấu hình. Role organization cố định: owner/admin quản trị organization, billing/member không kế thừa quyền site. Organization key luôn là admin, không bao giờ là owner, và không thể thay đổi ai nắm quyền: thao tác ghi thành viên, organization key và settings organization yêu cầu phiên người dùng, nên key bị lộ không thể thêm người giữ nó làm admin, tạo key thay thế hay tự bật tool MCP của mình. Key yêu cầu các thay đổi này qua MCP organization để người dùng duyệt; `create_org_key` được duyệt hiển thị key mới một lần cho người duyệt và biên nhận được lưu không chứa key dạng rõ. Cùng một người phải sở hữu cả hai organization để duyệt chuyển site. Owner được đổi slug `default` của personal organization. Settings hiển thị Organization cho owner/admin ngay cả khi chỉ có một organization; chỉ switcher được ẩn trong trường hợp đó.

### Phê duyệt organization bắt buộc

Tool organization chịu gate `contentOs.mcp.allowOrganizationTools` (mặc định tắt), có thể bị ép tắt bằng `LUMIBASE_MCP_ORG_TOOLS=off`. Thao tác ghi luôn dùng harness organization và `ai_approvals`, bất kể chế độ quản trị site cũ. `confirm=true` không thể cấp quyền phê duyệt hay kích hoạt fallback sang REST.

User/key yêu cầu được lưu và kiểm tra lại trước khi thực thi. Một người dùng owner/admin quyết định qua API approval organization hoặc Studio. Thay đổi dành riêng cho owner vẫn cần owner, và organization key không được đọc hay quyết định biên nhận dành cho người dùng. Ghi domain và biên nhận commit nguyên tử nên retry không tạo site hay key trùng. Organization key mới chỉ hiện trong biên nhận của người duyệt. Audit run chứa `organizationId` và `runId`, kể cả request organization không có site.

### Quản lý site và ranh giới xác thực

Tool site cũ giữ các chế độ quản trị hiện có. `LUMIBASE_MCP_GOVERNED=on` từ chối thao tác ghi thiếu mapping quản trị canonical; chế độ tương thích có thể dùng REST. Không được coi các chế độ site đó là hợp đồng phê duyệt organization bắt buộc. Xem [Hợp đồng tool có quản trị](../mcp/governed-tool-contract.md).

Đăng ký công khai, đăng nhập mật khẩu, xác minh và reset vẫn là luồng xác thực HTTP thay vì tool MCP. Kích hoạt danh tính nhân sự và membership organization là thao tác riêng. Dùng luồng mời hiện có để kích hoạt tài khoản nhân sự mới. Xem [Cài đặt Organization](../features/organizations.md) về quy trình của người dùng và giới hạn phục hồi khi không còn site.

---

## 8. Tham chiếu nhanh — files

| Mối bận tâm | File |
|---------|------|
| Register / verify-email / resend-verification / login / forgot+reset password | `apps/cms/src/routes/auth.ts` |
| Endpoint truy cập nội dung của subscriber | `apps/cms/src/routes/users.ts` |
| Phương thức auth + parse audience | `apps/cms/src/middleware/auth.ts` |
| Truy cập Studio + bức tường frontend | `apps/cms/src/middleware/studio-access.ts` |
| Cấp phát role subscriber | `apps/cms/src/services/auth/frontend-role.ts` |
| Cấp quyền đọc nội dung cho subscriber | `apps/cms/src/services/auth/subscriber-access.ts` |
| Token audience + helper access/refresh TTL | `apps/cms/src/services/auth/token-audience.ts` |
| Refresh token xoay vòng (issue/rotate/revoke) | `apps/cms/src/services/auth/refresh-token.ts` (bảng `lumibase_refresh_tokens`) |
| Token email-verify / password-reset | `apps/cms/src/services/auth/{email-verification,password-reset}.ts` |
| Rate limit theo IP (register/resend/forgot) | `apps/cms/src/modules/auth/registration-guard.ts` |
| Chính sách định danh email (chuẩn hoá, tra cứu, đổi mode có kiểm soát, invite) | `apps/cms/src/modules/email-identity/` · `apps/cms/src/routes/admin-email-identity.ts` |
| Email verification / reset | `apps/cms/src/modules/email/{verify-email,password-reset}.ts` |
| Bản ghi quyết định | `docs/en/architecture/decisions/adr-011-user-management-realms.md` |

---

## 9. Ghi chú gia cố (hardening) & giới hạn đã biết

Các bản vá đã xác minh ship kèm feature này (xem CHANGELOG):

- **Password-reset dùng một lần (H1).** `users.password_changed_at` (migration
  `0006`) được đóng dấu ở mỗi lần reset/change; một token reset có `iat` sớm
  hơn nó sẽ bị từ chối (`isResetTokenStale`). Một link bị rò rỉ hay replay
  không thể đặt mật khẩu lần thứ hai, và phát một reset mới hơn sẽ vô hiệu hóa
  các link cũ.
- **Email duy nhất toàn cục (H3).** Unique index trên `lower(email)`
  (migration `0006`) là lớp DB dự phòng đằng sau check-then-insert trong
  `/register`; một race đăng ký bị thua sẽ hiện ra như cùng một `202` chung.
- **Xoay refresh atomic (M1).** Rotation giành hàng bằng một
  `UPDATE … WHERE revoked_at IS NULL` có điều kiện; một bên thua đồng thời
  được coi là dùng lại và family bị revoke.
- **Session verify ghim audience (M5).** `verifyCustomJwt` yêu cầu
  `aud ∈ {studio, frontend}`; một JWT `email-verify`/`password-reset` một-mục
  đích không bao giờ có thể bị replay như một session token. Các token được
  đúc trước khi audience-theo-realm tồn tại sẽ bị từ chối → người giữ phải
  re-authenticate.
- **`/refresh` kiểm tra lại realm (M4).** Membership được xác minh lại và
  audience được tính lại từ `appAccess` *hiện tại* của role ở mỗi lần gia hạn.

Giới hạn đã biết — **follow-up được theo dõi, chưa vá** (chấp nhận hoặc xử lý
trước khi dựa vào chúng trong một triển khai thù địch):

- **H2 — rate limit theo IP ngoài Cloudflare.** `extractClientIp` tin
  `CF-Connecting-IP` và không có bộ phân giải remote-address được nối trên
  runtime Node, nên trên một triển khai Docker trần, kẻ tấn công có thể xoay
  header (bypass bộ giới hạn) hoặc gộp tất cả caller vào một bucket `unknown`
  (DoS register/reset cho cả site). Đây là một giới hạn có sẵn từ trước, phạm
  vi toàn app, chia sẻ với login-guard. Giảm thiểu bằng cách đặt Cloudflare
  trước API (hoặc một proxy strip/đặt header) và cấu hình
  `LUMIBASE_TRUSTED_PROXIES`; một bản vá đầy đủ nối runtime `getConnInfo` tại
  các call site auth.
- **M2 — không có vòng đời session tuyệt đối.** Xoay refresh cấp một TTL mới ở
  mỗi bước, nên một chuỗi refresh ít nhất một lần trong mỗi cửa sổ refresh-TTL
  sẽ sống vô thời hạn. Chỉ một lần đổi mật khẩu (vốn revoke tất cả token) hoặc
  logout/session-revoke tường minh mới kết thúc nó. Thêm một mức chặn
  family-origin nếu cần một giới hạn tuyệt đối.
- **L2 — cookie refresh scope theo host xuyên các tenant.** Cookie
  `lumibase_refresh` dùng một tên cho mỗi host; trên một triển khai
  multi-tenant chia sẻ host, đăng nhập vào site B ghi đè cookie của site A
  (một lời gọi `/refresh` sau đó của cookie site-A sẽ 401 và xóa). Transport
  body-token không bị ảnh hưởng — các SPA cross-tenant nên ưu tiên nó.

Ghi chú vận hành — unique index `lower(email)` (`0006`) tạo thất bại nếu bảng
`users` đã chứa các email trùng lặp không phân biệt hoa/thường. Khử trùng lặp
trước:

```sql
SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
```
