---
version: 2
lastUpdated: 2026-08-30T09:36:17.873Z
sourceLang: en
translatedFrom: en
sourceHash: 5c222ffed069414f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-30T09:36:17.873Z
codeVerifiedHash: 5c222ffed069414f
codeVerifiedClaims: 16
---

# Vận hành khoá mã hoá

`ENCRYPTION_KEY` được dùng ở đâu, "rotate" bao gồm và KHÔNG bao gồm những gì, và phải làm gì khi mất hoặc lộ khoá.

Điều này quan trọng vì cùng một biến đang bảo vệ hai thứ có **vòng đời khác nhau**: các field item được mã hoá — migration bọc lại được, và seed 2FA TOTP — migration không bọc lại. Coi hai thứ như nhau chính là cách operator khoá luôn user ra khỏi tài khoản của họ.

## Bộ khoá

| Biến | Ý nghĩa |
|------|---------|
| `ENCRYPTION_KEY` | Khoá đơn kiểu cũ. Được hiểu là version `v0` |
| `ENCRYPTION_KEY_<id>` | Khoá có version, ví dụ `ENCRYPTION_KEY_v1` |
| `ENCRYPTION_ACTIVE_KEY_ID` | Version nào dùng để mã hoá dữ liệu mới. Mặc định là khoá duy nhất đang cấu hình, nếu không thì `v0` |
| `ENCRYPTION_KEY[_<id>]_FILE` | Đọc khoá từ file thay vì biến (Docker secrets). Biến trực tiếp thắng |

Mỗi khoá là base64 của 32 byte ngẫu nhiên:

```bash
openssl rand -base64 32
```

Mọi ciphertext được lưu dưới dạng **envelope có version**, `<keyId>:<base64(iv‖ciphertext‖tag)>`, nên bản thân dòng dữ liệu ghi lại khoá nào đã bọc nó. Toàn bộ dùng AES-256-GCM.

## Rotate bao gồm những gì

Thêm `ENCRYPTION_KEY_v1` và đặt `ENCRYPTION_ACTIVE_KEY_ID=v1` sẽ đổi khoá dùng cho các lần ghi **mới**. Dòng dữ liệu cũ vẫn giữ `keyId` cũ cho tới khi có thứ gì bọc lại chúng.

| Dữ liệu | Có được `POST /api/v1/admin/encryption/envelope/migrate` bọc lại? |
|---------|---|
| Field item đã mã hoá (`items.dek_wrapped`) | **Có** |
| Seed TOTP (`lumibase_user_totp_credentials.secret_ciphertext`) | **Không** |

Worker migration chỉ đi qua `items` — xem phần import ở đầu `apps/cms/src/services/envelope-migration-worker.ts`. Không có gì bọc lại seed TOTP.

> **Tuyệt đối không xoá khoá mà seed TOTP còn tham chiếu tới.**
> `decryptTotpSecret` lấy khoá theo `keyId` trong envelope, nên bỏ
> `ENCRYPTION_KEY` sau khi rotate sang `v1` sẽ làm vỡ mọi enrollment đã tạo
> dưới `v0`.

Kiểm tra khoá nào còn được dùng trước khi cho một khoá về hưu:

```sql
SELECT secret_key_id, count(*)
FROM lumibase_user_totp_credentials
GROUP BY secret_key_id;
```

Mọi key id xuất hiện ở đây phải được giữ trong cấu hình, vô thời hạn.

## Kịch bản lỗi: thiếu khoá đang được tham chiếu

Nếu khoá mà một enrollment cần không có trong cấu hình, các endpoint 2FA fail closed — không có chỗ nào đọc hay ghi seed ở dạng thô — và trả `409` kèm `TFA_KEY_UNAVAILABLE`, có nêu tên key id để biết cần phục hồi khoá nào:

```
POST /api/v1/auth/verify-totp        -> 409  TFA_KEY_UNAVAILABLE
POST /api/v1/me/tfa/recovery-codes   -> 409  TFA_KEY_UNAVAILABLE
```

Recovery code vẫn hoạt động, vì chúng là hash PBKDF2 chứ không bọc bằng KEK:

```
POST /api/v1/auth/verify-totp  { recoveryCode }  -> 200
```

Nên user bị ảnh hưởng đăng nhập bằng một recovery code rồi **tự tháo được yếu tố đã chết** — `DELETE /me/tfa` chấp nhận recovery code thay cho TOTP code đúng cho tình huống này, và enroll lại sau đó sẽ bọc một seed mới bằng khoá hiện hành:

```
DELETE /api/v1/me/tfa  { password, recoveryCode }  -> 200
POST   /api/v1/me/tfa/setup                        -> 200
```

Tạo lại recovery code thì **cố ý không** cho đi đường này: bơm thêm code cho một enrollment vĩnh viễn không sinh được TOTP code hợp lệ chỉ kéo dài thời gian sự cố.

Nếu khoá không thể khôi phục và bạn không muốn đợi từng user tự phát hiện, operator có thể xoá hàng loạt các enrollment bị ảnh hưởng. Hiện **chưa có endpoint admin** cho việc này:

```sql
-- Theo từng user. Xoá credential và recovery code của nó (FK cascade),
-- rồi xoá phần trạng thái enrollment không bí mật mà Studio UI đọc.
DELETE FROM lumibase_user_totp_credentials WHERE user_id = $1;
UPDATE lumibase_users SET tfa = '{}'::jsonb WHERE id = $1;
```

Nhớ thông báo cho user bị ảnh hưởng: yếu tố thứ hai của họ đã mất cho tới khi enroll lại, nên trong thời gian đó tài khoản chỉ còn mật khẩu bảo vệ.

## Kịch bản lỗi: khoá bị lộ

**Rotate không phải là biện pháp khắc phục.** Không có bước dẫn khoá theo từng user — một KEK bọc mọi seed, và AAD (`totp-secret|<userId>`) chỉ ràng envelope vào đúng chủ của nó để ciphertext không thể replay dưới user id khác. Đó không phải một biên bảo mật. Ai giữ khoá bị lộ đều giải được mọi seed đã enroll dưới khoá đó và sinh code hợp lệ vô thời hạn, im lặng, không để lại gì trong audit trail.

Đây là bản chất của TOTP: server buộc phải giữ shared secret ở dạng khôi phục được để verify code. So sánh với recovery code trong cùng feature — chúng là hash một chiều nên ngay cả operator cũng không khôi phục được.

Cách xử lý:

1. Rotate: thêm `ENCRYPTION_KEY_<id>` mới, trỏ `ENCRYPTION_ACTIVE_KEY_ID` vào nó. Từ thời điểm này, enrollment mới và lần ghi item mới được bảo vệ.
2. Bọc lại field item: `POST /api/v1/admin/encryption/envelope/migrate`, rồi poll cho tới `done`.
3. **Buộc enroll lại TOTP** cho toàn bộ user đã enroll dưới khoá bị lộ — bước 2 không chạm tới họ, bước 1 cũng không bảo vệ họ. Dùng SQL ở trên cho từng user, và giữ khoá cũ trong cấu hình cho tới khi mọi dòng đã rời khỏi nó.
4. Coi các session là đáng nghi: tháo 2FA sẽ bump `tokenVersion` và thu hồi refresh token của user đó — ở đây đúng là tác dụng ta muốn.

Muốn thoát hẳn khỏi tính chất này thì phải đổi cơ chế chứ không phải đổi cách lưu — WebAuthn/passkey chỉ giữ public key ở phía server, nên một KEK bị lộ chẳng mở được gì.

## Trước lần enroll đầu tiên

`ENCRYPTION_KEY` phải được cấu hình **trước** khi có ai enroll 2FA hoặc ghi một field mã hoá. Nếu thiếu, `POST /api/v1/me/tfa/setup` trả `503` kèm `ENCRYPTION_NOT_CONFIGURED`; không có gì bị ghi nửa vời, nên chỉ cần đặt khoá vào là enroll chạy ngay.

Đặt nó như một secret thật, không bao giờ nằm trong config được commit:

```bash
# Cloudflare
wrangler secret put ENCRYPTION_KEY --env production

# Docker
ENCRYPTION_KEY_FILE=/run/secrets/encryption_key
```

## Xem thêm

- [Quản lý user → §4f Xác thực hai yếu tố](../security/user-management.md#4f-two-factor-authentication-totp)
- [Biến môi trường → Encryption](../deployment/environment-variables.md#encryption)
- [Vận hành nâng cấp](./upgrades.md)
