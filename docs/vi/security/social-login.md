---
sourceLang: en
version: 2
lastUpdated: 2026-11-14T02:18:44.695Z
translatedFrom: en
sourceHash: c65724322363fe2a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:18:44.695Z
codeVerifiedHash: c65724322363fe2a
codeVerifiedClaims: 44
---

# Đăng nhập mạng xã hội cho thành viên (Google, Apple, GitHub)

> **Đối tượng:** người vận hành muốn thành viên công khai của site (realm
> `frontend` / subscriber) đăng nhập bằng Google, Apple hoặc GitHub, và lập
> trình viên frontend tích hợp luồng này vào website hoặc ứng dụng.
>
> **Tóm tắt:** cấu hình provider theo từng site trong **Settings → Social
> login**, đăng ký callback URL hiển thị ở đó với provider, khai báo các
> redirect URI của frontend, rồi chạy luồng PKCE: `start` → provider →
> callback của CMS → redirect URI của bạn kèm `code` dùng một lần →
> `exchange` để lấy phiên. Đăng nhập mạng xã hội luôn cấp phiên
> **subscriber** (`aud: frontend`), không bao giờ cấp quyền vào Studio.

Module: `apps/cms/src/modules/social-auth/routes.ts` · bảng
`lumibase_user_identities` và `lumibase_social_auth_providers` (migration
`packages/database/drizzle/0031_social_login_identities.sql`).

---

## 1. Cách hoạt động

```
frontend                     LumiBase CMS                        provider
   │ POST /auth/social/google/start                                  │
   │   { redirectUri, codeChallenge, state } ──►  state + nonce +     │
   │                                              server PKCE saved   │
   │ ◄── { authorizationUrl }                                         │
   │ browser ─────────────────────────────────────────────────────────►│
   │                                 ◄── GET/POST callback?code&state ─│
   │                                     token exchange (PKCE, secret) │
   │                                     ID token verified (JWKS) or   │
   │                                     GitHub /user + /user/emails   │
   │ ◄── 303 redirectUri?code=<one-time>&state=<yours>                 │
   │ POST /auth/social/exchange { code, codeVerifier } ──►             │
   │ ◄── { token, refreshToken, user }  (aud: frontend, sid set)       │
```

- **Hai cặp PKCE.** CMS giữ verifier riêng cho lời gọi token tới provider;
  frontend của bạn giữ một verifier thứ hai và phải xuất trình nó để đổi
  code dùng một lần. Một code bị lấy từ URL, hoặc một luồng do kẻ tấn công
  khởi tạo rồi đẩy sang trình duyệt của người khác, đều không thể đổi được.
- **State và nonce** là ngẫu nhiên, lưu phía server, dùng một lần và hết hạn
  sau 10 phút; code kết quả dùng một lần hết hạn sau 2 phút.
- **Không có token trong URL.** Lần redirect về site của bạn chỉ mang `code`
  dùng một lần, `state` của bạn và `intent` (hoặc `error`).
- **Google / Apple:** ID token được kiểm bằng `jose` với JWKS của provider —
  chữ ký, `iss`, `aud` (client id của bạn), thời hạn — và `nonce` phải khớp
  với giá trị đã gửi.
- **GitHub** không có ID token: CMS đọc `/user` (id số ổn định) và
  `/user/emails`; chỉ địa chỉ **primary** được tính, và chỉ coi là đã xác minh
  khi GitHub trả `verified: true`.
- **Apple** trả về bằng `response_mode=form_post` (một form HTML POST tới
  callback), và client secret của Apple là một JWT ES256 ngắn hạn mà CMS ký
  cho mỗi lần đổi code bằng khoá `.p8` của bạn. Apple chỉ gửi **tên người
  dùng ở lần uỷ quyền đầu tiên**; CMS lưu tên ngay lúc đó, và người dùng Apple
  quay lại vẫn giữ tên ấy. Provider không bao giờ ghi đè tên mà thành viên đã
  có.
- Phiên được tạo bằng cùng đường mã với đăng nhập mật khẩu, nên có `sid`
  (hiện trong **Active sessions**), refresh token và refresh cookie, cùng
  `amr: ["fed"]`.

## 2. Tài khoản và liên kết

Danh tính nằm trong `lumibase_user_identities` — mỗi cặp `(issuer, subject)`
một dòng, ví dụ tài khoản Google `1234`, trỏ tới đúng một tài khoản
LumiBase. Khi `exchange`:

| Tình huống | Kết quả |
|---|---|
| Danh tính provider đã được liên kết | Đăng nhập vào tài khoản đó (phải ở trạng thái `active`). |
| Danh tính mới, **chưa** có tài khoản với email này | Tạo tài khoản `active` với vai trò `subscriber` của site, liên kết danh tính. Cần email đã được provider xác minh. |
| Danh tính mới, đã có tài khoản với email này, provider đã xác minh email, tài khoản đã tự xác minh địa chỉ, và tài khoản chỉ là thành viên | Tự động liên kết, rồi đăng nhập. |
| Như trên, nhưng provider chưa xác minh email | `403 SOCIAL_EMAIL_UNVERIFIED` |
| Như trên, nhưng tài khoản chưa xác minh địa chỉ (`invited`) | `409 LINK_REQUIRES_VERIFIED_ACCOUNT` |
| Như trên, nhưng tài khoản có quyền vào Studio ở bất kỳ site nào (hoặc là bootstrap admin) | `409 LINK_REQUIRES_SIGN_IN` — đăng nhập bình thường, rồi liên kết từ tài khoản. |
| Provider không chia sẻ email | `422 SOCIAL_EMAIL_MISSING` |

Việc so khớp email theo chế độ email-identity của instance
(`apps/cms/src/modules/email-identity/service.ts`): ở chế độ `root` một alias
khớp với hộp thư gốc của nó, ở chế độ `exact` chỉ đúng địa chỉ đó mới khớp.

**Đăng nhập rồi liên kết.** Thành viên đã đăng nhập liên kết provider bằng
`POST /me/identities/{provider}/link` và `POST /me/identities/complete` (cùng
luồng PKCE, `intent=link`). Email của provider không cần khớp — thành viên đã
chứng minh quyền kiểm soát cả hai. Danh tính đã liên kết với người khác bị từ
chối với `409 IDENTITY_ALREADY_LINKED`.

**Huỷ liên kết.** `DELETE /me/identities/{id}` gỡ một provider đã liên kết,
nhưng không bao giờ gỡ cách đăng nhập cuối cùng: khi không có mật khẩu và
không còn danh tính nào khác, API trả `409 LAST_LOGIN_METHOD`. Danh tính đến
từ issuer JWT bên ngoài (backfill từ `users.external_id`) được liệt kê là
`external` và không thể huỷ liên kết ở đây (`409 IDENTITY_MANAGED_EXTERNALLY`).

## 3. Thiết lập provider

Trong Studio mở **Settings → Social login**. Mỗi thẻ provider hiển thị
**callback URL** cần đăng ký với provider, có dạng
`{LUMIBASE_PUBLIC_URL}/api/v1/auth/social/callback/{siteId}/{provider}` (khi
chưa đặt `LUMIBASE_PUBLIC_URL` thì dùng origin của request — hãy đặt biến
này khi chạy sau proxy để URL ổn định). Secret được mã hoá bằng
`ENCRYPTION_KEY` của deployment (cùng kho KeyProvider với seed TOTP) và chỉ
ghi được: trang chỉ cho biết đã lưu hay chưa, không bao giờ hiện giá trị. Lưu
secret khi chưa có `ENCRYPTION_KEY` bị từ chối với
`503 ENCRYPTION_NOT_CONFIGURED`.

### Google

1. Google Cloud Console → **APIs & Services → OAuth consent screen**: thiết
   lập màn hình đồng ý (scope `openid`, `email`, `profile`).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Thêm callback URL từ Studio vào **Authorized redirect URIs**.
4. Dán **Client ID** và **Client secret** vào thẻ Google.

### Apple

1. Apple Developer → **Identifiers → App IDs**: bật *Sign in with Apple* cho
   App ID chính.
2. **Identifiers → Services IDs**: tạo một Services ID (đây là **client
   id**), bật *Sign in with Apple*, thêm domain và callback URL từ Studio làm
   **Return URL**.
3. **Keys**: tạo khoá có *Sign in with Apple*, tải file `.p8` (chỉ tải được
   một lần) và ghi lại **Key ID**.
4. Trong thẻ Apple nhập Services ID, **Team ID**, Key ID, và dán toàn bộ nội
   dung file `.p8` (`-----BEGIN PRIVATE KEY-----…`).

Apple không công bố hỗ trợ PKCE cho đăng nhập web, nên CMS không gửi
challenge tới Apple; code được ràng buộc bằng JWT client-secret, `state` và
`nonce` trong ID token. Địa chỉ private relay
(`…@privaterelay.appleid.com`) là địa chỉ đã xác minh và được dùng làm email
tài khoản.

### GitHub

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Authorization callback URL**: callback URL từ Studio.
3. Tạo client secret; dán **Client ID** và secret vào thẻ GitHub.

### Redirect URI (mọi provider)

Liệt kê mọi URI mà frontend sẽ yêu cầu quay về, mỗi dòng một URI. So khớp là
**chính xác** (scheme, host, port, path, query) — không theo tiền tố, không
wildcard. Bắt buộc `https://`, trừ `http://localhost` khi phát triển; scheme
tuỳ biến như `myapp://oauth` được phép cho ứng dụng native. Một `redirectUri`
không có trong danh sách bị từ chối với `400 REDIRECT_URI_NOT_ALLOWED` trước
khi liên hệ provider, nên callback không bao giờ bị lợi dụng làm open
redirect. Không thể bật provider khi chưa có ít nhất một mục và secret của nó
(`400 PROVIDER_INCOMPLETE`).

## 4. Tích hợp frontend

```ts
const site = 'site_abc';
const api = 'https://cms.example.com/api/v1';

// 1. PKCE pair, kept in sessionStorage across the redirect.
const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
sessionStorage.setItem('lb_pkce', verifier);

// 2. Start.
const start = await fetch(`${api}/auth/social/google/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Lumi-Site': site },
  body: JSON.stringify({ redirectUri: 'https://www.example.com/auth/callback', codeChallenge: challenge, state: 'my-csrf' }),
}).then((r) => r.json());
location.href = start.data.authorizationUrl;

// 3. On https://www.example.com/auth/callback?code=…&state=my-csrf
const params = new URLSearchParams(location.search);
if (params.get('error')) showError(params.get('error'));
const session = await fetch(`${api}/auth/social/exchange`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-Lumi-Site': site },
  body: JSON.stringify({ code: params.get('code'), codeVerifier: sessionStorage.getItem('lb_pkce') }),
}).then((r) => r.json());
// session.data → { token, refreshToken, refreshTokenExpiresAt, user }
```

Kiểm tra `state` trả về đúng bằng giá trị đã gửi. `GET
/auth/social/providers` liệt kê các provider đang bật, để hiển thị nút đăng
nhập.

## 5. Tham chiếu API

| Method & path | Xác thực | Mục đích |
|---|---|---|
| `GET /api/v1/auth/social/providers` | công khai | Các provider đang bật (`[{ provider }]`). |
| `POST /api/v1/auth/social/{provider}/start` | công khai, giới hạn tần suất | `{ redirectUri, codeChallenge, codeChallengeMethod?: "S256", state? }` → `{ authorizationUrl, expiresIn }`. |
| `GET` / `POST /api/v1/auth/social/callback/{siteId}/{provider}` | provider | Callback (`POST` = `form_post` của Apple). Redirect `303` về `redirectUri`. |
| `POST /api/v1/auth/social/exchange` | công khai, giới hạn tần suất | `{ code, codeVerifier }` → phiên (cùng dạng với `/auth/login`). |
| `GET /api/v1/me/identities` | phiên | `{ identities: [{ id, provider, issuer, emailAtLink, createdAt, unlinkable }], hasPassword }`. |
| `POST /api/v1/me/identities/{provider}/link` | phiên | Body giống `start`; `intent=link`. |
| `POST /api/v1/me/identities/complete` | phiên | `{ code, codeVerifier }` → `{ status: "linked" \| "already_linked", identity }`. |
| `DELETE /api/v1/me/identities/{id}` | phiên | Huỷ liên kết (không phải cách đăng nhập cuối cùng). |
| `GET /api/v1/admin/social-providers` | site admin | Cấu hình provider (secret chỉ báo qua `hasClientSecret` / `hasApplePrivateKey`) + `callbackUri`. |
| `PUT /api/v1/admin/social-providers/{provider}` | site admin | `{ enabled?, clientId, clientSecret?, appleTeamId?, appleKeyId?, applePrivateKey?, allowedRedirectUris }`. |
| `DELETE /api/v1/admin/social-providers/{provider}` | site admin | Xoá cấu hình. |

Lỗi trên redirect trả về dạng `?error=<CODE>`: `SOCIAL_CANCELLED`,
`SOCIAL_PROVIDER_ERROR`, `SOCIAL_CODE_REJECTED`, `SOCIAL_ID_TOKEN_INVALID`,
`SOCIAL_PROVIDER_NOT_CONFIGURED`. Lỗi của `exchange` / `complete` dùng body
chuẩn `{ errors: [{ code, message }] }`: `SOCIAL_CODE_INVALID`,
`SOCIAL_PKCE_MISMATCH`, cùng các mã liên kết ở §2.

## 6. Đa tenant

- **Cô lập theo site:** cấu hình provider (`lumibase_social_auth_providers`,
  RLS `site_isolation`), allow-list redirect, các secret đã mã hoá (ràng buộc
  site + provider qua AAD, nên dòng bị chép sang site khác sẽ không giải mã
  được), state của luồng và code dùng một lần (khoá cache chứa site id và bản
  ghi được kiểm với site của request), bộ đếm rate limit, và membership/vai
  trò mà một lần đăng nhập tạo ra.
- **Dùng chung, có chủ đích:** `lumibase_user_identities`, giống
  `lumibase_users`, là identity-global — một tài khoản Google là cùng một người
  trên mọi site. Đăng nhập ở site B bằng danh tính đã dùng ở site A sẽ thêm
  membership `subscriber` ở B; không bao giờ mang vai trò của A sang.
- **Kiểm chứng bằng:** test route hai site (state hoặc code của site A bị từ
  chối ở site B) và test AAD trong
  `apps/cms/src/modules/social-auth/__tests__/config-service.test.ts`.

## 7. Sự kiện audit

`social_login`, `social_account_created`, `social_identity_linked`
(`automatic: true|false`), `social_identity_unlinked`, `social_login_failed`
(kèm mã `reason`), `social_provider_configured` (chỉ **tên** các trường thay
đổi) và `social_provider_deleted`. Không token, code hay secret nào được ghi
vào audit log.
