---
sourceLang: en
version: 2
lastUpdated: 2026-11-26T21:45:23.936Z
translatedFrom: en
sourceHash: fd45573286a198c3
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-26T21:45:23.936Z
codeVerifiedHash: fd45573286a198c3
codeVerifiedClaims: 4
---

# Preset bảo mật khi setup

> **Đối tượng:** operator chạy Setup Wizard trên một instance mới.
>
> **Tóm tắt:** Wizard có ba preset bảo mật đăng nhập: **Standard** (mặc
> định), **Strict** và **Lenient**. Preset điền sẵn các trường khoá tài
> khoản, phát hiện bất thường và thông báo, đồng thời chọn chế độ email
> identity của instance. Chọn preset, rồi chuyển sang **Advanced setup** nếu
> cần chỉnh riêng từng trường trước khi tạo tài khoản admin đầu tiên.

## Preset được định nghĩa ở đâu

Các giá trị bên dưới lấy từ `apps/studio/src/modules/setup/schemas/policy.ts`
(`STANDARD_PRESET`, `STRICT_PRESET`, `LENIENT_PRESET`, gom trong
`POLICY_PRESETS`). Chế độ email identity mà mỗi preset chọn lấy từ
`PRESET_EMAIL_IDENTITY_MODE` trong `apps/studio/src/modules/setup/setup-drafts.ts`.

## So sánh

| Trường | Standard | Strict | Lenient |
|---|---|---|---|
| Số lần sai trước khi khoá user (`userMaxFailedAttempts`) | 5 | 3 | 10 |
| Thời gian khoá user (`userLockoutDurationSeconds`) | 900 s (15 phút) | 3600 s (60 phút) | 300 s (5 phút) |
| Số lần sai trước khi khoá IP (`ipMaxFailedAttempts`) | 20 | 10 | 50 |
| Thời gian khoá IP (`ipLockoutDurationSeconds`) | 3600 s (60 phút) | 14400 s (4 giờ) | 900 s (15 phút) |
| Cửa sổ trượt để đếm lần sai (`lockoutWindowSeconds`) | 900 s (15 phút) | 1800 s (30 phút) | 300 s (5 phút) |
| Bất thường theo vị trí (`geoAnomalyEnabled`) | bật | bật | bật |
| Bất thường theo giờ (`timeAnomalyEnabled`) | tắt | bật | tắt |
| Bất thường theo thiết bị mới (`deviceAnomalyEnabled`) | bật | bật | tắt |
| Ngưỡng điểm bất thường (`anomalyScoreThreshold`) | 0.7 | 0.5 | 0.85 |
| Hành động khi có bất thường (`anomalyAction`) | `notify_only` | `lock` | `notify_only` |
| Kênh thông báo (`notifyChannels`) | `email` | `email` | `email` |
| Chế độ email identity | `exact` | `root` | `exact` |

## Chọn preset nào

- **Standard**: mặc định được khuyến nghị cho project production mới.
- **Strict**: khoá chặt hơn và bật mọi kiểm tra bất thường. Lần đăng nhập
  đáng ngờ sẽ khoá tài khoản thay vì chỉ thông báo. Dùng cho instance chứa
  dữ liệu nhạy cảm hoặc có ít nhân sự đã biết rõ.
- **Lenient**: khoá nhẹ tay hơn, dành cho instance phát triển nội bộ.
  Không dùng cho bản deploy công khai.

## Chế độ email identity

Chế độ email identity quyết định cách các alias địa chỉ ánh xạ vào tài khoản,
và áp dụng cho đăng ký, lời mời và SCIM:

- `exact`: mỗi địa chỉ khác nhau là một tài khoản riêng, nên
  `test+a@gmail.com` và `test+b@gmail.com` đăng ký riêng được.
- `root` (**One account per mailbox**): các alias `+tag` (và với Gmail là dấu
  chấm và `googlemail.com`) quy về một tài khoản trên toàn instance.

**Strict** chọn `root`, để một hộp thư không tạo được nhiều tài khoản. Các
preset còn lại chọn `exact`. Chọn preset sẽ đặt chế độ này, nhưng radio vẫn
chỉnh được: chọn chế độ còn lại sau đó nếu cần.

## Tuỳ chỉnh preset

Bước review của quick setup hiện mọi giá trị mà preset sẽ áp dụng. Để đổi
riêng một trường (webhook thông báo tuỳ chỉnh, ngưỡng bất thường, cửa sổ khoá
chính xác), dùng nút **Switch to advanced setup** ở bước đó. Bước Security
nâng cao bắt đầu từ preset bạn đã chọn, và chọn thẻ preset ở đó sẽ áp dụng
cùng các giá trị, kể cả chế độ email identity.

## Tài liệu liên quan

- [Cơ chế chống lạm dụng](./anti-abuse.md): cách khoá tài khoản và phát hiện
  bất thường hoạt động lúc chạy.
- [Quản lý người dùng & auth realms](./user-management.md): tài khoản, lời mời
  và chế độ email identity chi tiết.
