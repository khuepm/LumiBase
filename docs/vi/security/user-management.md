---
version: 1
lastUpdated: 2026-07-08T20:23:24.787Z
sourceLang: en
translatedFrom: en
sourceHash: c274dd38cd5da85d
mtEngine: claude
syncStatus: machine-translated
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
api_keys → api_key_roles/policies  ← integration principals, scoped per site
```

- Luật domain: mọi bảng domain có `site_id` và mọi query lọc theo nó (Strict
  Rule #2). RLS (`withRls`) là lớp phòng thủ chiều sâu dự phòng.
- **`subscriber`** là role frontend đặc quyền tối thiểu. Nó không cấp gì cho
  tới khi bạn gắn quyền đọc nội dung vào nó (ví dụ `articles::read WHERE
  status = 'published'`). Nó được tạo idempotent ở lần đăng ký đầu tiên
  (`ensureSubscriberRole`), nên các instance hiện có không cần backfill.

> ⚠️ **Không bao giờ gắn policy Studio/admin vào `subscriber`.** Toàn bộ mục
> đích của role đó là làm mặt sàn an toàn cho các đăng ký tự phục vụ.

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
| `DELETE /api/v1/me/sessions/:id` | bearer | Revoke một trong các session của chính caller. |
| `DELETE /api/v1/me/sessions` | bearer | Revoke TẤT CẢ session của caller (logout mọi nơi). |
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

## 7. Phơi bày user management qua MCP (tính khả thi tương lai)

> Bề mặt này có thể được phơi bày sau qua **MCP** (Model Context Protocol)
> không? Đánh giá bên dưới. [Inference] — một đánh giá thiết kế, không phải
> một năng lực đã ship.

**Nền tảng (Grounding):** LumiBase đã ship sẵn một MCP server —
`packages/mcp-server` (`name: 'lumibase'`, stdio transport). Nó phơi bày các
công cụ **items / collections / fields** hôm nay và xác thực đúng theo cách
đánh giá này khuyến nghị: một `LumiBaseClient` mang
`Authorization: Bearer <api key>` + `X-Lumi-Site: <siteId>`
(`packages/mcp-server/src/client.ts`). Vậy "phơi bày user management qua MCP"
một cách cụ thể nghĩa là **thêm một `tools/users.ts` bên cạnh các module công
cụ hiện có**, tái sử dụng cùng client dùng API key — không phải xây hạ tầng
mới.

**MCP ở đây sẽ là gì:** một *server* MCP phơi bày các thao tác user/role dưới
dạng công cụ mà một AI agent (hoặc một MCP client bên ngoài) có thể gọi.

### Cách chia được khuyến nghị

| Bề mặt | Phơi-bày-được qua MCP? | Lý do |
|---------|----------------|-----------|
| **Read** — liệt kê user, đọc role/policy, truy vấn audit | ✅ Rủi ro thấp | Chỉ-đọc, đã được admin-gate; ánh xạ gọn gàng sang công cụ MCP. |
| **Management** — mời user, gán/thu hồi role, suspend, rotate API key | ⚠️ Với gating mạnh | Tác động lớn. Chỉ phơi bày phía sau một API key gắn với một admin policy tường minh, scope theo từng site, và định tuyến các lời gọi thay đổi đặc quyền qua đường HITL `ai_approvals`. |
| **Public auth** — `register`, `login`, `verify-email` | ❌ Không phơi bày | Đây là các *luồng thông tin xác thực của người dùng cuối*, không phải năng lực của agent. Một agent không bao giờ nên tự đăng ký tài khoản hay xử lý mật khẩu user. |

### Vì sao nó khớp gọn với LumiBase

- **Capability + HITL đã tồn tại.** Strict Rule #4 yêu cầu các skill có
  capability nhóm `schema:write` hoặc `delete*` phải đi qua `ai_approvals`
  trước. Các công cụ đột biến user (gán admin role, xóa user) đúng là nhóm
  nguy hiểm đó — tái dùng gate ấy; đừng phát minh một side channel.
- **Scope theo từng site là native.** Mọi bảng được scope theo `site_id` và
  API key được bind với một site, nên một công cụ MCP kế thừa sự cô lập
  tenant.
- **Audit là native.** `audit_log` đã ghi `user_registered`, `email_verified`,
  `api_key_*`, các thay đổi role — các hành động khởi từ MCP nhận cùng
  provenance miễn phí (đặt `actorEmail`/metadata thành agent).
- **Earned autonomy (L0–L4).** Các công cụ user-management qua MCP ánh xạ lên
  thang tự chủ Content OS: bắt đầu ở L1 (đề xuất → con người duyệt), thăng lên
  veto-window/autopilot chỉ cho các thao tác rủi ro thấp (ví dụ read, gửi lại
  invite), không bao giờ cho việc leo thang role.

### Ràng buộc cứng nếu/khi hiện thực

1. **Không bao giờ tạo mới hay leo thang một principal mà không có HITL.** Bất
   kỳ công cụ nào có thể cấp `appAccess`/`adminAccess`, tạo một admin, hay phát
   một API key PHẢI tạo một hàng `ai_approvals` trước.
2. **Toàn vẹn audience.** Các công cụ MCP xác thực với tư cách một principal
   dùng API key (hoặc `studio`), không bao giờ bằng cách giả mạo một user JWT;
   bức tường audience `frontend` giữ nguyên vẹn.
3. **Không xử lý mật khẩu.** Các công cụ MCP không được nhận, lưu, hay chuyển
   tiếp mật khẩu người dùng cuối; verify/login vẫn chỉ-HTTP.
4. **Rate + scope.** Bind API key của MCP server với một policy hẹp (ví dụ
   `users::read` + `users::update` chỉ trên `status`/`roleId`) thay vì bypass
   admin.

**Kết luận:** bề mặt *management* là một ứng viên MCP tương lai tốt vì các
primitive an toàn (capability gating, HITL, scope theo từng site, audit, các
mức tự chủ) đã có sẵn — và phương tiện chuyển giao (`packages/mcp-server` +
client dùng API key của nó) cũng đã tồn tại, nên công việc là một module
`tools/users.ts` mới cộng với một key scope-admin, không phải hạ tầng mới. Bề
mặt *public auth* nên vẫn là HTTP thông thường và không bao giờ trở thành một
công cụ của agent.

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
- **Xoay refresh atomic (M1).** Rotation giành hàng bằng một `UPDATE …
  WHERE revoked_at IS NULL` có điều kiện; một bên thua đồng thời được coi là
  dùng lại và family bị revoke.
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
