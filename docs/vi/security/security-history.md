---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:09:40.218Z
translatedFrom: en
sourceHash: 8650a495d7a9cd06
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:09:40.218Z
codeVerifiedHash: 8650a495d7a9cd06
codeVerifiedClaims: 14
---

# Lịch sử bảo mật và email đăng nhập từ thiết bị mới

> **Đối tượng:** nhân sự dùng Studio, lập trình viên frontend làm trang tài
> khoản cho thành viên, và người vận hành cấu hình email.
>
> **Tóm tắt:** mọi người dùng đã đăng nhập đều xem được các sự kiện bảo mật
> của chính mình — đăng nhập, lần thử thất bại, thiết bị mới, đổi mật khẩu và
> xác thực hai lớp, phiên bị đăng xuất — qua `GET /api/v1/me/security-history`,
> và xuất ra CSV hoặc JSON. Một lần đăng nhập từ thiết bị mà tài khoản chưa
> từng dùng sẽ gửi email cho chủ tài khoản.

## 1. Lịch sử gồm những gì

Lịch sử được đọc từ nhật ký kiểm toán bảo mật (`lumibase_audit_log`). Chỉ các
sự kiện kiểm toán dưới đây được trả về, mỗi sự kiện mang một `kind` dễ hiểu.
Các sự kiện kiểm toán khác, như setup, đổi chính sách hay xuất dữ liệu, không
bao giờ được hiển thị.

| `kind` | Sự kiện kiểm toán | Ghi khi |
| --- | --- | --- |
| `sign_in` | `login_success` | Đăng nhập bằng mật khẩu hoặc TOTP thành công. `details.method` là `password` hoặc `totp`. |
| `sign_in_failed` | `login_failed` | Có người nhập sai mật khẩu của tài khoản. `details.reason` cho biết nguyên nhân. |
| `mfa_challenge_failed` | `mfa_verify_failed` | Nhập sai mã xác thực hai lớp. |
| `new_device` | `new_device_login` | Đăng nhập từ thiết bị tài khoản chưa từng dùng (xem §3). `details.notified` cho biết email đã được gửi hay chưa. |
| `suspicious_sign_in` | `anomaly_triggered` | Bộ phát hiện bất thường gắn cờ một lần đăng nhập. |
| `account_locked` | `user_locked` | Tài khoản bị khoá do thử sai quá nhiều lần. |
| `account_unlocked` | `user_unlocked` | Quản trị viên mở khoá tài khoản. |
| `password_changed` | `password_changed` | Mật khẩu được đổi từ trang hồ sơ. |
| `password_reset_requested` | `password_reset_requested` | Có yêu cầu gửi liên kết đặt lại mật khẩu. |
| `password_reset` | `password_reset_completed` | Mật khẩu được đặt lại qua liên kết. |
| `mfa_enabled` | `mfa_enrolled` | Bật xác thực hai lớp. |
| `mfa_disabled` | `mfa_disabled` | Tắt xác thực hai lớp. |
| `session_revoked` | `session_revoked` | Một phiên bị đăng xuất. |
| `sessions_revoked` | `sessions_revoked` | Các phiên khác, hoặc tất cả các phiên, bị đăng xuất. |
| `session_token_reuse` | `refresh_token_reuse_detected` | Một refresh token bị dùng lại, nên phiên đó bị kết thúc. |

Các loại sự kiện được định nghĩa một lần trong `packages/contracts/src/security-history.ts`
và được ánh xạ trong `apps/cms/src/modules/security-history/events.ts`.

### Che bớt dữ liệu

- **Chỉ sự kiện của bạn.** Chủ thể của mỗi dòng kiểm toán được xác định theo
  thứ tự `metadata.targetUserId`, rồi `metadata.userId`, rồi email đích, rồi
  email người thực hiện. Thao tác của quản trị viên lên tài khoản người khác
  không bao giờ xuất hiện trong lịch sử của chính quản trị viên. Các dòng cũ
  hơn tài khoản bị loại, nên những lần thử sai nhắm vào một địa chỉ trước khi
  nó được đăng ký vẫn được ẩn.
- **IP gần đúng.** `ipApprox` chỉ giữ phần mạng: `203.0.113.x` với IPv4, 48 bit
  đầu (`2001:db8:85a3::/48`) với IPv6.
- **Bỏ thông tin của người khác.** Khi quản trị viên là người thực hiện (ví dụ
  `account_unlocked`), mục đó không có IP, User-Agent hay quốc gia.
- **Không có bí mật.** `details` là danh sách cho phép theo từng loại sự kiện, chỉ
  gồm giá trị nhỏ. Session id, token id, request id, email và điểm bất thường
  không bao giờ được trả về.

## 2. API

Cả hai endpoint đều cần người dùng đã đăng nhập. Chúng dùng được cho nhân sự
(token `studio`) và thành viên (token `frontend`). API key hoặc người gọi ẩn
danh nhận `401`.

### `GET /api/v1/me/security-history`

| Tham số | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `limit` | `25` | Kích thước trang, `1`–`100`. |
| `cursor` | — | `meta.nextCursor` của trang trước. |
| `scope` | `site` | `site` hoặc `account`, xem bên dưới. |

```json
{
  "data": [
    {
      "id": "0193…",
      "kind": "new_device",
      "occurredAt": "2026-11-14T10:00:00.000Z",
      "siteId": "site_abc",
      "ipApprox": "203.0.113.x",
      "userAgent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) …",
      "countryCode": "VN",
      "details": { "deviceLabel": "Chrome on Android", "notified": true }
    }
  ],
  "meta": { "nextCursor": "MjAyNi0xMS0xNFQxMDowMDowMC4wMDBafDAxOTM…", "limit": 25, "scope": "site" }
}
```

Các mục xếp từ mới đến cũ. `nextCursor` là `null` ở trang cuối. `cursor`,
`limit` hoặc `scope` sai định dạng trả về `400 VALIDATION_ERROR`.

### `GET /api/v1/me/security-history/export`

`?format=json` (mặc định) hoặc `?format=csv`, kèm `scope`. Phản hồi là một tệp
tải về (`Content-Disposition: attachment`) chứa mọi sự kiện trong phạm vi, từ
mới đến cũ, tối đa 5.000 dòng; `X-Export-Truncated: true` báo đã chạm giới hạn.
JSON có dạng `{ data, meta: { exportedAt, count, truncated, scope } }`.
CSV có các cột `occurredAt,kind,siteId,ipApprox,countryCode,userAgent,details`;
ô bắt đầu bằng `=`, `+`, `-` hoặc `@` được thêm `'` ở đầu để bảng tính không
chạy chúng như công thức. Mỗi người dùng được xuất tối đa 10 lần mỗi 15 phút
(`429 RATE_LIMITED`).

### Người dùng có nhiều site

Mỗi request chạy dưới một site (`X-Lumi-Site`), và mỗi dòng kiểm toán được lưu
kèm site mà nó được ghi nhận.

- `scope=site` (mặc định) trả về các sự kiện ghi dưới site hiện tại.
- `scope=account` trả thêm sự kiện từ mọi site mà người dùng là thành viên
  trực tiếp (`lumibase_user_sites`). Dùng nó để thấy các thay đổi cấp tài
  khoản được thực hiện qua site khác: mật khẩu, cài đặt xác thực hai lớp và
  trạng thái khoá thuộc về tài khoản, không thuộc về một site. Dòng của site
  mà người dùng không thuộc về không bao giờ được đọc. Mỗi mục mang `siteId`
  của nó.

Lịch sử được giữ bằng đúng thời gian nhật ký kiểm toán giữ:
`LUMIBASE_AUDIT_RETENTION_DAYS`, mặc định 90 ngày.

## 3. Email đăng nhập từ thiết bị mới

Sau một lần đăng nhập thành công, bằng mật khẩu hoặc mật khẩu kèm TOTP, máy
chủ kiểm tra thiết bị có mới với tài khoản hay không. Nếu mới, nó gửi email
tới chính địa chỉ của tài khoản.

**Thế nào là một thiết bị.** Dấu vân tay thiết bị của bộ phát hiện bất
thường: SHA-256 của User-Agent đã bỏ số phiên bản, cộng header
`Accept-Language` (`apps/cms/src/modules/anomaly/device.ts`). Thiết bị đã biết
là 20 dấu vân tay gần nhất lưu trong
`lumibase_login_baselines.device_fingerprints`. Không dùng thêm bảng nào. Cập
nhật trình duyệt không tạo ra thiết bị mới. Địa chỉ IP không nằm trong khoá,
vì IP nhà riêng và di động đổi thường xuyên; IP được ghi trong email thay vào
đó. Thiết bị vẫn được ghi nhận ngay cả khi phần kiểm tra thiết bị của bộ phát
hiện bất thường bị tắt trong chính sách khoá.

**Khi nào email được gửi.** Tất cả điều kiện sau phải đúng:

- tài khoản đã từng đăng nhập thành công trước đó;
- tài khoản đã có ít nhất một thiết bị được ghi nhận, nên lần đăng nhập đầu
  tiên sau khi nâng cấp chỉ ghi nhận thiết bị mà không gửi email;
- dấu vân tay không nằm trong danh sách thiết bị đã biết;
- request có User-Agent.

**Nội dung.** Thời điểm, tên thiết bị (ví dụ "Chrome on Android"), IP gần
đúng và quốc gia, và nơi đăng xuất phiên đó: với nhân sự là **Settings →
Security → Active sessions** trong Studio, có liên kết khi đặt
`LUMIBASE_SECURITY_SETTINGS_URL`; với thành viên là URL của site. Email không
bao giờ chứa token, session id hay IP đầy đủ. Site có thể thay nội dung dựng
sẵn bằng một mẫu email có key `new_device_login`. Biến của mẫu là `email`,
`siteName`, `siteUrl`, `signedInAt`, `signedInAtText`, `ipApprox`, `country`,
`device` và `securityUrl`.

**Gửi đi.** Email được gửi sau khi phản hồi, nên đăng nhập không bao giờ phải
chờ máy chủ mail. Trên Cloudflare Workers việc gửi chạy trong `waitUntil`; trên
Docker nó chạy tách rời trong cùng tiến trình. Thường email rời đi trong vài
giây sau khi đăng nhập. Cần cấu hình email (SMTP hoặc MailChannels); nếu
không, sự kiện vẫn được ghi với `notified: false`.

**Giới hạn và quyền riêng tư.** Tối đa 3 email thiết bị mới cho mỗi người dùng
mỗi giờ. Các thiết bị mới tiếp theo trong giờ đó vẫn được ghi vào lịch sử
(`notified: false`). Email chỉ gửi tới chủ tài khoản, sau khi mật khẩu (và mã)
đã được chấp nhận. Phản hồi đăng nhập, mã trạng thái và thời gian phản hồi
giống nhau dù có gửi email hay không, nên tính năng này không tiết lộ một tài
khoản có tồn tại hay không.

| Biến | Mặc định | Mục đích |
| --- | --- | --- |
| `LUMIBASE_SECURITY_SETTINGS_URL` | chưa đặt | URL tuyệt đối của trang bảo mật trong Studio, ví dụ `https://cms.example.com/settings/security#active-sessions`. Được liên kết trong email gửi nhân sự. |

## 4. Studio

**Settings → Security → Security history** liệt kê các sự kiện kèm tên thiết
bị, IP gần đúng và quốc gia. Sự kiện đáng xem lại (lần thử thất bại, thiết bị
mới, đăng nhập bị gắn cờ, khoá tài khoản, dùng lại token) được đánh dấu
**Review**. Bộ chọn chuyển giữa **This site** và **All my sites**, còn
**Export CSV** / **Export JSON** tải tệp qua endpoint xuất.

## 5. Liên quan

- [Quản lý người dùng](./user-management.md) — phiên (§4e), realm và vai trò.
- [Chống lạm dụng](./anti-abuse.md) — khoá tài khoản và phát hiện bất thường.
