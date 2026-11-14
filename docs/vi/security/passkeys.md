---
sourceLang: en
version: 2
lastUpdated: 2026-11-14T02:22:56.785Z
translatedFrom: en
sourceHash: ef5e85d1d5f896d9
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:22:56.785Z
codeVerifiedHash: ef5e85d1d5f896d9
codeVerifiedClaims: 48
---

# Passkey (WebAuthn)

> **Đối tượng:** người vận hành bật passkey, và người tích hợp gọi API xác thực.
>
> **Tóm tắt:** Người dùng Studio đăng ký passkey tại **Settings → Security →
> Passkeys**, sau đó có thể đăng nhập **không cần mật khẩu** hoặc dùng passkey làm
> **yếu tố thứ hai** sau mật khẩu. Cả hai cách đều cho phiên đã xác minh TFA, nên
> policy có `enforceTfa` được thỏa mãn. Subscriber (realm `frontend`) không được
> cung cấp passkey.

## 1. Quan hệ với mật khẩu + TOTP

LumiBase đã có TOTP gốc (xem
[Quản lý người dùng §4f](./user-management.md)).
Passkey đứng cạnh TOTP; một người dùng có thể có cả hai.

| Cách đăng nhập | Endpoint | `amr` của phiên | `tfaVerified` |
|---|---|---|---|
| Chỉ mật khẩu | `POST /api/v1/auth/login` | — | không |
| Mật khẩu + TOTP | `/auth/login` → `POST /api/v1/auth/verify-totp` | `["pwd","totp"]` | có |
| Mật khẩu + passkey | `/auth/login` → `POST /api/v1/auth/passkey/options` → `POST /api/v1/auth/passkey/verify` (kèm `challengeToken`) | `["pwd","webauthn"]` | có |
| Chỉ passkey (không mật khẩu) | `POST /api/v1/auth/passkey/options` → `POST /api/v1/auth/passkey/verify` (không có `challengeToken`) | `["webauthn"]` | có |

Khi người dùng Studio có bất kỳ yếu tố thứ hai nào gửi đúng mật khẩu,
`/auth/login` trả về `{ status: "mfa_required", challengeToken, expiresIn, methods }`.
`methods` liệt kê cách có thể hoàn tất thử thách: `totp`, `webauthn`, hoặc cả
hai. Mọi đường đều tạo phiên qua cùng một hàm
(`completePasswordLoginSession` trong `apps/cms/src/services/auth/login-session.ts`),
nên access token mang `sid`, phiên hiện trong **Active sessions** và có thể thu
hồi như mọi phiên khác.

`withStudioAccess` (`apps/cms/src/middleware/studio-access.ts`) coi một phiên là
đã xác minh TFA khi `tfaVerified` là `true` hoặc `amr` chứa `webauthn`; trạng thái
đăng ký được đọc từ `users.tfa`, vốn được tính lại từ cả bảng TOTP lẫn bảng
passkey sau mỗi thay đổi, nên tắt TOTP không bao giờ làm người dùng passkey mất
trạng thái đã đăng ký.

Người dùng chịu `enforceTfa` nhưng chưa có yếu tố thứ hai nào vẫn gọi được các
endpoint đăng ký (`GET /api/v1/me/tfa`, `POST /api/v1/me/tfa/setup`,
`POST /api/v1/me/tfa/confirm`, `GET /api/v1/me/passkeys`,
`POST /api/v1/me/passkeys/registration-options`, `POST /api/v1/me/passkeys`)
và không gì khác, nên policy là một yêu cầu chứ không phải một sự khóa ngoài.
Khi đã có một yếu tố, mọi request Studio lại cần phiên đã xác minh TFA: người
dùng đăng nhập lại một lần bằng yếu tố mới.

## 2. Các nghi thức (ceremony)

Mỗi nghi thức gồm hai lời gọi. Lời gọi đầu trả về `{ ceremonyId, options }`;
trình duyệt chạy `navigator.credentials.create/get` với `options` (Studio dùng
`@simplewebauthn/browser`); lời gọi thứ hai gửi kết quả về cùng `ceremonyId`.

**Đăng ký** (đã xác thực, bearer token):

```
POST /api/v1/me/passkeys/registration-options   { "password": "…" }
POST /api/v1/me/passkeys                        { "ceremonyId": "…", "response": {…}, "name": "Work laptop" }
```

Giống thiết lập TOTP, đăng ký yêu cầu nhập lại mật khẩu hiện tại trước. Options
yêu cầu credential có thể khám phá (`residentKey: preferred`) để passkey cũng
dùng được cho đăng nhập không mật khẩu, với `attestation: none`. User handle là
id người dùng LumiBase. Đăng ký yếu tố thứ hai **đầu tiên** của người dùng sẽ
đăng xuất mọi phiên khác (cùng quy tắc với đăng ký TOTP, #730).

**Xác thực** (công khai, chưa có phiên):

```
POST /api/v1/auth/passkey/options   { "challengeToken": "…" }            ← yếu tố thứ hai
POST /api/v1/auth/passkey/options   { }                                  ← không mật khẩu
POST /api/v1/auth/passkey/verify    { "ceremonyId": "…", "response": {…}, "challengeToken": "…" }
```

Khi là yếu tố thứ hai, options chỉ liệt kê credential của chính người dùng và
`userVerification` là `preferred`. Options không mật khẩu không có danh sách cho
phép (trình duyệt đưa ra bất kỳ passkey nào nó giữ cho tên miền) và bắt buộc xác
minh người dùng (PIN hoặc sinh trắc học), vì passkey thay thế mật khẩu. Sau đó
máy chủ tìm credential theo id, kiểm tra user handle đúng là chủ sở hữu, và áp
cùng quy tắc tenant và realm như `/auth/login`: là thành viên của site (hoặc
bootstrap admin, hoặc owner/admin của tổ chức) trong realm `studio`. Nếu không,
trả về `403 PASSKEY_STUDIO_ONLY` hoặc `TENANT_ACCESS_DENIED`. Tài khoản đang bị
khóa (`users.locked_until` ở tương lai) trả về `423`.

Cả hai endpoint xác thực là đường công khai, được liệt kê cạnh
`/auth/verify-totp` trong các tập công khai của `withAuth`, `site-membership` và
`studio-access`.

**Tự quản lý:**

| Phương thức + đường dẫn | Body | Ghi chú |
|---|---|---|
| `GET /api/v1/me/passkeys` | — | `{ passkeys, recoveryCodesRemaining, totpEnabled, available }` |
| `PATCH /api/v1/me/passkeys/:id` | `{ name }` | Đổi tên. Chỉ passkey của chính người gọi. |
| `DELETE /api/v1/me/passkeys/:id` | `{ password }` | Xóa yếu tố thứ hai **cuối cùng** sẽ tăng `tokenVersion` và thu hồi mọi refresh token, như khi tắt TOTP. |
| `POST /api/v1/me/passkeys/recovery-codes` | `{ password }` | Mã khôi phục mới; phiên phải được mở bằng passkey. |

## 3. Thuộc tính bảo mật

- **Thử thách dùng một lần, thời hạn ngắn.** Mỗi lời gọi options lưu
  `{ challenge, rpId, origins, … }` vào runtime cache trong 5 phút dưới một
  `ceremonyId` ngẫu nhiên. Bước verify giành quyền bằng bộ đếm nguyên tử rồi xóa
  nó, nên một nghi thức chỉ dùng được một lần; nếu cache không đếm được, verify
  thất bại theo hướng đóng. Khi là yếu tố thứ hai, nghi thức gắn với người dùng,
  site và `jti` của challenge token, và `jti` bị tiêu khi dùng, đúng như
  `/auth/verify-totp`.
- **Bộ đếm đi lùi.** Bộ đếm chữ ký đã lưu phải tăng nghiêm ngặt khi một trong
  hai phía khác 0 (authenticator không giữ bộ đếm luôn báo 0 và được chấp nhận).
  Đi lùi bị từ chối với `401 INVALID_PASSKEY` và ghi audit
  `passkey_counter_regression` kèm giá trị đã lưu và giá trị nhận được: đó là
  dấu hiệu authenticator bị nhân bản.
- **Giới hạn tần suất.** Options: 60 mỗi IP mỗi 15 phút. Verify: 30 mỗi IP và
  10 mỗi người dùng mỗi 15 phút (bộ đếm tách khỏi TOTP).
- **Sự kiện audit.** `passkey_registered`, `passkey_removed`,
  `passkey_counter_regression`, `passkey_login_failed` (không mật khẩu), và
  `mfa_verify_failed` với `method: "webauthn"` (yếu tố thứ hai). Không ghi
  challenge, assertion hay dữ liệu khóa.
- **Không lưu gì bí mật.** `lumibase_user_passkeys` chứa credential id, khóa công
  khai COSE, bộ đếm, transports, AAGUID, trạng thái sao lưu, tên và RP ID.

## 4. Khôi phục

Mã khôi phục dùng chung với TOTP (`lumibase_user_totp_recovery_codes`). Người
dùng đăng ký passkey khi chưa có TOTP sẽ nhận tám mã, chỉ hiển thị một lần. Mã
được dùng ở bước yếu tố thứ hai qua `POST /api/v1/auth/verify-totp` với
`recoveryCode`, hoạt động cả với tài khoản chỉ có passkey. Tắt TOTP vẫn giữ các
mã khi còn passkey; xóa passkey cuối cùng khi không có TOTP sẽ xóa chúng. Mất mọi
passkey và mọi mã khôi phục nghĩa là quản trị viên phải đặt lại tài khoản.

## 5. Cấu hình: RP ID và origin

Trình duyệt gắn passkey với một **RP ID** (một tên miền) và mỗi phản hồi ghi
**origin** của trang đã chạy nghi thức. Cả hai là của **Studio**, không phải của
API.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `WEBAUTHN_ORIGINS` | không đặt | Các origin Studio được phép chạy nghi thức, phân tách bằng dấu phẩy. |
| `WEBAUTHN_RP_ID` | host của origin Studio | Tên miền mà passkey gắn vào. Đặt tên miền cha (`example.com`) để dùng chung passkey giữa `studio.example.com` và `admin.example.com`. |
| `WEBAUTHN_RP_NAME` | `LumiBase` | Tên trình duyệt hiển thị trong hộp thoại. |

Khi không đặt gì, máy chủ chỉ dùng `Origin` của request nếu nó đã được tin cậy:
cùng origin với API, bằng `LUMIBASE_PUBLIC_URL`, hoặc được quy tắc CORS có
credential chấp nhận (`CORS_ALLOWED_ORIGINS`, hoặc origin loopback ngoài
production). Sau một proxy viết lại URL request, hãy đặt `WEBAUTHN_ORIGINS` rõ
ràng. Origin phải là `https:` (hoặc `http:` trên localhost) và thuộc RP ID. Khi
không có origin nào hợp lệ, các endpoint trả `503 WEBAUTHN_NOT_CONFIGURED`, và
Studio giải thích điều này thay vì đề nghị thêm passkey. Logic phân giải nằm ở
`apps/cms/src/modules/mfa/webauthn-config.ts`.

> **Đổi `WEBAUTHN_RP_ID` làm mồ côi mọi passkey đã đăng ký.** Mỗi dòng ghi RP ID
> mà nó được tạo và chỉ được đưa ra cho RP ID đó. Người dùng vẫn đăng nhập được
> bằng mật khẩu (+ TOTP hoặc mã khôi phục) và đăng ký lại.

## 6. Ứng dụng desktop và mobile

Shell Tauri (`apps/shell`) tải Studio từ `tauri://localhost` trong WKWebView,
WebView2 hoặc WebKitGTK. Ở đó WebAuthn hoặc không có, hoặc gắn với một origin mà
không RP ID nào khớp, nên Studio ẩn mọi điều khiển passkey trong shell (hợp đồng
C5 trong `apps/shell/README.md`). Mật khẩu, TOTP và mã khôi phục vẫn hoạt động;
người dùng chỉ có passkey đăng nhập bằng mã khôi phục trong ứng dụng, hoặc dùng
trình duyệt. Passkey đăng ký trong trình duyệt vẫn dùng được trong trình duyệt đó.

## 7. Bản đồ triển khai

- Service: `apps/cms/src/modules/mfa/passkey-service.ts` (dùng `@simplewebauthn/server`, chỉ Web Crypto, chạy trên Workers và Node).
- Route: `apps/cms/src/routes/passkeys.ts`.
- Trạng thái yếu tố dùng chung: `apps/cms/src/modules/mfa/tfa-state.ts`.
- Bảng: `packages/database/src/schema/security.ts` (`userPasskeys`), migration `packages/database/drizzle/0030_user_passkeys.sql`. Gắn với danh tính giống các bảng TOTP (khóa theo `user_id`, không có `site_id`): passkey thuộc về một tên miền, không thuộc về một site LumiBase.
- Studio: `apps/studio/src/modules/settings/passkeys-section.tsx`, `apps/studio/src/modules/auth/admin-login-page.tsx`, `apps/studio/src/lib/passkeys.ts`.

## 8. Giới hạn đã biết

- Access token được làm mới không mang theo `tfaVerified` / `amr` (TOTP cũng
  vậy), nên dưới `enforceTfa` người dùng đăng nhập lại khi access token hết hạn.
- Người dùng không có mật khẩu (ví dụ tạo qua nhà cung cấp danh tính bên ngoài)
  không qua được bước xác nhận mật khẩu, nên không đăng ký được passkey.
- Không yêu cầu attestation, nên không áp danh sách cho phép AAGUID theo mẫu
  authenticator.
