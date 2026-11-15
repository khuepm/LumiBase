---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T02:11:57.440Z
translatedFrom: en
sourceHash: ead870c8af02e0df
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:11:57.440Z
codeVerifiedHash: ead870c8af02e0df
codeVerifiedClaims: 22
---

# Chính sách mật khẩu

> **Đối tượng:** operator quyết định mật khẩu tài khoản phải mạnh đến đâu, và
> integrator xây trang đăng ký / đặt lại mật khẩu dựa trên API của LumiBase.
>
> **Tóm tắt:** Một chính sách cấu hình được (độ dài, nhóm ký tự, điểm độ mạnh
> kiểu zxcvbn, kiểm tra rò rỉ tùy chọn) được áp dụng trên mọi luồng đặt mật
> khẩu. Mật khẩu bị từ chối nhận lỗi `PASSWORD_POLICY` nêu tên từng quy tắc
> không đạt. Kiểm tra rò rỉ (Have I Been Pwned) **tắt theo mặc định**.

## Chính sách áp dụng ở đâu

Mọi request đặt mật khẩu mới đều đi qua cùng một service,
`apps/cms/src/services/auth/password-policy.ts`:

| Luồng | Endpoint |
|---|---|
| Tự đăng ký | `POST /api/v1/auth/register` |
| Đổi mật khẩu của chính mình | `POST /api/v1/me/change-password` |
| Đặt lại qua liên kết gửi e-mail (cũng là cách thành viên được mời đặt mật khẩu đầu tiên) | `POST /api/v1/auth/reset-password` |
| Setup wizard (admin khởi tạo) | `POST /api/v1/setup/complete` |
| Đặt lại sau khôi phục bằng mã dự phòng | `POST /api/v1/admin/security/reset-password` |

Đăng nhập không bao giờ kiểm tra lại chính sách: mật khẩu hiện có vẫn dùng
được sau khi chính sách bị siết, và quy tắc mới áp dụng ở lần đổi mật khẩu kế
tiếp.

## Các quy tắc

Quy tắc nằm trong `packages/contracts/src/schemas/password-policy.ts`, nên
checklist ở Studio và server chạy đúng cùng một đoạn code.

| Thiết lập | Mặc định | Mã quy tắc trong lỗi |
|---|---|---|
| `minLength` (8–128) | `12` | `min_length` |
| — (cố định 256) | — | `max_length` |
| `requireLowercase` | `true` | `lowercase` |
| `requireUppercase` | `true` | `uppercase` |
| `requireDigit` | `true` | `digit` |
| `requireSpecial` (một trong `!@#$%^&*()-_=+[]{};:,.?/`) | `true` | `special` |
| `minStrength` (0–4, `0` là tắt) | `2` | `min_strength` |
| `breachCheck` | `false` | `not_breached` |

### Điểm độ mạnh

`minStrength` dùng điểm kiểu zxcvbn từ 0 (rất yếu) đến 4 (rất mạnh), tính bởi
`packages/contracts/src/schemas/password-strength.ts`. Mật khẩu được tách thành
chuỗi mẫu rẻ nhất mà kẻ tấn công sẽ thử trước — mật khẩu phổ biến, chính
e-mail hoặc tên của tài khoản, dãy `abc` / `123`, ký tự lặp, đường phím như
`qwerty`, và năm — rồi số lần đoán ước tính được quy về các mức của zxcvbn
(`< 10^3`, `< 10^6`, `< 10^8`, `< 10^10`, trên đó).

Bộ ước lượng tự viết thay vì dùng gói `zxcvbn` để cùng một điểm số ra giống
nhau trên Cloudflare Workers, Node và trình duyệt mà không phải nhét ~400 KB từ
điển vào Worker. Từ điển dựng sẵn cố ý ngắn: nó bắt những trường hợp hiển
nhiên; kiểm tra rò rỉ mới là phép thử "đã từng bị lộ" thực sự.

Vì vậy `Password1234!` đạt mọi quy tắc nhóm ký tự nhưng trượt `min_strength`
với lý do "it contains a commonly used password".

### Kiểm tra rò rỉ (tùy chọn, tắt theo mặc định)

Khi `breachCheck: true`, mật khẩu mới đã đạt các quy tắc cục bộ sẽ được tra
trong range API của Have I Been Pwned theo kiểu k-anonymity:

- chỉ 5 ký tự hex đầu của SHA-1 được gửi tới `api.pwnedpasswords.com`; việc so
  khớp diễn ra cục bộ;
- request mang header `Add-Padding: true`, nên kích thước phản hồi không tiết
  lộ có bao nhiêu hậu tố trùng;
- mật khẩu có trong kho dữ liệu sẽ trượt với `not_breached`.

Mặc định tắt vì dù chỉ 5 ký tự tiền tố thì vẫn rời khỏi instance ở mỗi lần đổi
mật khẩu — đó là quyết định của operator. Nếu tra cứu quá thời gian (3 giây)
hoặc dịch vụ lỗi, phép kiểm tra **fail-open**: mật khẩu được chấp nhận, một cảnh
báo được ghi log và sự kiện audit `password_breach_check_unavailable` được ghi,
để sự cố của bên thứ ba không bao giờ chặn việc đổi mật khẩu.

## Định dạng lỗi

Mật khẩu bị từ chối trả về `400`. Với `Kx9mQz7wPa` theo chính sách mặc định:

```json
{
  "errors": [
    {
      "code": "PASSWORD_POLICY",
      "message": "Password does not meet the policy: min_length — Use at least 12 characters (currently 10). special — Add a special character, one of !@#$%^&*()-_=+[]{};:,.?/",
      "rules": [
        { "rule": "min_length", "ok": false, "min": 12, "actual": 10, "message": "Use at least 12 characters (currently 10)." },
        { "rule": "max_length", "ok": true, "max": 256, "actual": 10, "message": "Use at most 256 characters." },
        { "rule": "lowercase", "ok": true, "message": "Add a lowercase letter (a–z)." },
        { "rule": "uppercase", "ok": true, "message": "Add an uppercase letter (A–Z)." },
        { "rule": "digit", "ok": true, "message": "Add a digit (0–9)." },
        { "rule": "special", "ok": false, "chars": "!@#$%^&*()-_=+[]{};:,.?/", "message": "Add a special character, one of !@#$%^&*()-_=+[]{};:,.?/" },
        { "rule": "min_strength", "ok": true, "min": 2, "actual": 4, "weaknesses": [], "message": "Strength is very strong." }
      ]
    }
  ]
}
```

`rules` liệt kê mọi quy tắc đã đánh giá kèm `ok: true | false`; `message` nêu
tên từng quy tắc trượt. Hãy dựng UI từ `rules[].rule`, đừng dựa vào câu chữ
của message.

## Đọc và thay đổi chính sách

| Endpoint | Ai | Trả về |
|---|---|---|
| `GET /api/v1/auth/password-policy` | bất kỳ ai (không cần phiên) | bộ quy tắc công khai kèm `maxLength` và `specialChars` |
| `GET /api/v1/admin/password-policy` | admin của site | chính sách đã lưu |
| `PUT /api/v1/admin/password-policy` | chỉ admin khởi tạo (bootstrap) | chính sách đã lưu (mọi thay đổi được ghi audit là `password_policy_changed`) |

Endpoint công khai tồn tại để trang đặt lại mật khẩu, đăng ký và nhận lời mời
hiển thị checklist trực tiếp trước khi người dùng có phiên. Nó chỉ lộ những gì
người dùng cần để chọn mật khẩu hợp lệ.

Chính sách có phạm vi **toàn instance**. Nó được lưu ở dòng `password_policy`
của `lumibase_settings` dưới site `__default__`, vì mật khẩu thuộc bảng `users`
toàn cục: chính sách theo từng site sẽ để site yếu nhất đặt ra mật khẩu mà mọi
site khác phải chấp nhận. Dòng `password_policy` ghi vào settings của bất kỳ
site nào khác đều bị bỏ qua. Thiếu dòng hoặc dòng sai định dạng nghĩa là dùng
chính sách mặc định.

```bash
curl -X PUT "$CMS/api/v1/admin/password-policy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"minLength": 14, "minStrength": 3, "breachCheck": true}'
```

Trường bị bỏ qua nhận giá trị mặc định; trường lạ bị từ chối.

## Studio

Mọi form mật khẩu trong Studio hiển thị thanh đo độ mạnh và checklist quy tắc
trực tiếp, cùng một bộ đánh giá (`apps/studio/src/components/password-policy-checklist.tsx`):
Settings → Security → **Change password**, và màn đặt lại sau khôi phục bằng mã
dự phòng. Bước tài khoản của setup wizard giữ thanh đo zxcvbn (điểm ≥ 3) và
đồng thời yêu cầu quy tắc độ mạnh dùng chung, nên không bao giờ chấp nhận mật
khẩu mà server sẽ từ chối ở bước cuối. Khi bật kiểm tra rò rỉ, checklist ghi
rõ điều đó và hiển thị kết quả của server sau khi gửi.
