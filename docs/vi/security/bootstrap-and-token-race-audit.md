---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:06:51.976Z
translatedFrom: en
sourceHash: 138d00f57a313844
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:06:51.976Z
codeVerifiedHash: 138d00f57a313844
codeVerifiedClaims: 52
---

# Kiểm toán bootstrap & token dùng một lần — rate limit và an toàn race

> Issue #732 (epic #674, S03). Bằng chứng từ đối thủ: Strapi #26494 (critical) —
> `register-admin` không có rate limit và có race có thể tạo ra hai admin.
> Trang này ghi lại LumiBase làm gì trên từng endpoint công khai khởi tạo tài
> khoản, các lỗ hổng mà đợt kiểm toán tìm thấy, và các test giữ chúng đóng.

## Phạm vi

Các endpoint không cần xác thực mà tạo tài khoản, nâng quyền tài khoản, hoặc
tiêu thụ một liên kết dùng một lần:

- đăng ký admin đầu tiên — `POST /api/v1/setup/complete` của setup wizard;
- tự đăng ký — `POST /api/v1/auth/register`;
- xác minh email — `POST /api/v1/auth/verify-email` và `POST /api/v1/auth/resend-verification`;
- đặt lại mật khẩu — `POST /api/v1/auth/forgot-password` và `POST /api/v1/auth/reset-password`;
- chấp nhận lời mời — lời mời nhân sự (`POST /api/v1/users/invite`, skill AI `inviteUser`, `invite_org_member` của tổ chức);
- khôi phục khẩn cấp — `POST /api/v1/admin/security/recover` (backup code) và `POST /api/v1/admin/security/reset-password` (recovery token).

## Kết quả

| Endpoint | Rate limit | An toàn race | Bằng chứng |
|---|---|---|---|
| `POST /setup/complete` | Có, 10 req/phút/IP, trước khi parse body (đã có) | Có: `SELECT … FOR UPDATE` trên singleton `system_state`, state machine, partial unique index `users_is_bootstrap_unique`. **Đã sửa:** request thua race giờ nhận `409` thay vì `404` | `setup-complete-race.db.integration.test.ts`, `setup-race-lost.test.ts`, `complete-rate-brake.test.ts` |
| `POST /auth/register` | Có, 5/giờ/IP. **Đã sửa:** bộ đếm là `get` rồi `set` không nguyên tử nên một loạt request song song lọt qua; giờ dùng limiter nguyên tử của runtime | Có: unique index trên email; tài khoản và membership commit trong một transaction; xung đột rơi về `202` chung (đã có) | `auth-flow-rate.test.ts`, `security-guards.wiring.test.ts` |
| `POST /auth/verify-email` | **Đã thêm:** 20 mỗi 15 phút mỗi IP, trước mọi xử lý token | **Đã sửa:** chuyển `invited → active` là một `UPDATE` có điều kiện; đúng một request đồng thời trả `verified` | `auth-single-use-race.db.integration.test.ts`, `single-use-consume.test.ts`, `auth-token-brake.test.ts` |
| `POST /auth/resend-verification` | Có, 5/giờ/IP (giờ nguyên tử) | n/a — chỉ tạo liên kết stateless, không ghi gì ngoài audit | `auth-flow-rate.test.ts` |
| `POST /auth/forgot-password` | Có, 5/giờ/IP (giờ nguyên tử) | n/a — chỉ tạo liên kết stateless, không ghi gì ngoài audit | `auth-flow-rate.test.ts` |
| `POST /auth/reset-password` | **Đã thêm:** 20 mỗi 15 phút mỗi IP, trước khi parse body hay hash | **Đã sửa:** compare-and-swap trên `users.token_version`; đúng một request đồng thời đặt được mật khẩu, số còn lại nhận `400 INVALID_TOKEN` | `auth-single-use-race.db.integration.test.ts`, `single-use-consume.test.ts`, `auth-token-brake.test.ts` |
| Mời nhân sự (`/users/invite`, `inviteUser`) | Chỉ admin; limiter API toàn cục áp dụng | Có: tra cứu theo danh tính email, insert và membership trong một transaction, thử lại một lần khi xung đột unique (đã có) | `users-invite-validation.test.ts`, `email-identity.db.integration.test.ts` |
| `invite_org_member` của tổ chức | Chỉ owner/admin; dòng tổ chức bị khoá cho mỗi mutation | **Đã sửa:** hai lời mời đồng thời cho cùng một địa chỉ mới (vào hai tổ chức khác nhau) gây `23505` không được xử lý; insert giờ là `ON CONFLICT DO NOTHING` và bên thua đọc lại dòng của bên thắng | `orgs.db.integration.test.ts` |
| `POST /admin/security/recover`, `/admin/security/reset-password` | Có, limiter khôi phục theo IP trên limiter nguyên tử của runtime (đã có) | Có: backup code được tiêu bằng `UPDATE … WHERE used_at IS NULL RETURNING`; kho recovery token xoá khi consume, không có `await` giữa lúc đọc và lúc xoá (đã có) | `recovery-flow.integration.test.ts` |

Không có endpoint "chấp nhận lời mời" mang token: thành viên được mời là một tài
khoản `status: 'invited'` gắn với site, và email mời yêu cầu họ đăng nhập. Vì vậy
không có token mời nào để phát lại.

## Cách đăng ký admin đầu tiên giữ đúng một bên thắng

`SetupService.complete` (`apps/cms/src/modules/setup/service.ts`) chạy toàn bộ
bootstrap trong một transaction:

1. `statement_timeout` được đặt cho transaction, nên request không thể chờ khoá
   mãi mãi. Hết thời gian chờ được ánh xạ thành `409 SETUP_IN_PROGRESS`.
2. Singleton `system_state` bị khoá bằng `SELECT … FOR UPDATE`. Các request đồng
   thời xếp hàng tại đây.
3. Khi bên thắng commit, `state` là `initialized`. Mỗi request đang xếp hàng so
   thời điểm đến (`receivedAt`, lấy khi handler bắt đầu, trước khi chờ rate
   limiter, connection pool hay khoá) với `initialized_at`:
   - đến **trước** khi setup xong → thua race → `409 SETUP_ALREADY_COMPLETED`;
   - đến **sau** → `404 NOT_FOUND`, giống mọi route không tồn tại khác, nên một
     instance đã khởi tạo không để lộ endpoint.
4. Lớp chặn cuối: partial unique index `users_is_bootstrap_unique` từ chối dòng
   `is_bootstrap = true` thứ hai bất kể state machine nói gì. Lỗi `23505` đó (kể cả
   khi lỗi driver được bọc trong `cause`) được ánh xạ thành cùng mã `409`.

Không cần migration: partial unique index đã có từ schema ban đầu.

## Cách liên kết dùng một lần giữ đúng một bên thắng

Liên kết xác minh và đặt lại mật khẩu là JWT HS256 stateless, nên không có dòng
token nào để xoá. "Dùng một lần" là trạng thái tài khoản mà liên kết thay đổi, và
các helper trong `apps/cms/src/services/auth/single-use-consume.ts` kiểm tra lại
trạng thái đó ngay trong câu `UPDATE`:

- **Xác minh:** `UPDATE users SET status = 'active' WHERE id = $1 AND status = 'invited' RETURNING id`.
  Một request nhận được dòng. Các request còn lại đọc lại tài khoản và trả
  `already_verified`, và chỉ bên thắng ghi sự kiện audit `email_verified`.
- **Đặt lại:** handler đọc `token_version` khi kiểm tra liên kết, rồi ghi
  `… SET password_hash = $2, token_version = token_version + 1 … WHERE id = $1 AND token_version = $expected AND status <> 'suspended' RETURNING id`.
  Bên thắng tăng version, nên mọi request đồng thời cập nhật không dòng nào và
  nhận `400 INVALID_TOKEN`. Phát lại sau đó vẫn bị chặn bởi phép so
  `password_changed_at` với `iat` (`isResetTokenStale`).

## Hành vi rate limit

`checkAuthFlowRate` (`apps/cms/src/modules/auth/registration-guard.ts`) dùng
`RateLimiterProvider` của runtime (Redis `INCR`, bộ đếm Cloudflare, hoặc limiter
in-memory), đếm trong một bước nguyên tử: trong một loạt request song song từ một
IP, đúng `maxPerWindow` request được đi qua. Khi runtime không có limiter, nó quay
về bộ đếm cache cũ. Chính sách không đổi: request không có IP client thì không thể
lập khoá và được cho qua, và khi limiter gặp sự cố thì fail open, để brake không
kéo sập luồng đăng ký hay khôi phục.

| Scope | Hạn mức |
|---|---|
| `reg-rate`, `resend-rate`, `forgot-rate` | 5 mỗi giờ mỗi IP mỗi site |
| `verify-rate`, `reset-rate` | 20 mỗi 15 phút mỗi IP mỗi site |
| setup `/complete` | 10 mỗi phút mỗi IP |

Request bị chặn nhận `429` với `{ errors: [{ code: 'RATE_LIMITED' }] }` và header
`retry-after` (verify và reset), trước mọi lần đọc database.

## Test

| Test | Chứng minh |
|---|---|
| `apps/cms/src/modules/setup/__tests__/setup-complete-race.db.integration.test.ts` | 8 request `POST /setup/complete` song song (tài khoản khác nhau và giống nhau) → một `201`, bảy `409`, đúng một dòng `is_bootstrap`; request đến muộn vẫn nhận `404` |
| `apps/cms/src/modules/setup/__tests__/setup-race-lost.test.ts` | Phân loại theo thời điểm đến, nhánh khoá, ánh xạ `23505` (trần và bị bọc), ánh xạ HTTP `409` |
| `apps/cms/src/routes/__tests__/auth-single-use-race.db.integration.test.ts` | 6 lần xác minh song song → một `verified`; 6 lần đặt lại song song → một `200`, hash lưu là của bên thắng, `token_version` tăng đúng một lần |
| `apps/cms/src/services/auth/__tests__/single-use-consume.test.ts` | Điều kiện chặn nằm ngay trong `UPDATE`; phân loại bên thua |
| `apps/cms/src/modules/auth/__tests__/auth-flow-rate.test.ts` | Loạt 20 request song song chỉ cho qua đúng 5; khoá theo scope, site và IP; fail-open |
| `apps/cms/src/routes/__tests__/auth-token-brake.test.ts` | `429` trên verify và reset trước mọi truy cập database, kể cả dưới loạt request song song |

Các suite `*.db.integration.test.ts` bỏ qua khi không có `DATABASE_URL` và chạy
trong job "DB integration suites" của CI với Postgres.

## Giới hạn đã biết

- Với limiter in-memory (không có Redis hay bộ đếm Cloudflare), hạn mức tính theo
  process hoặc isolate, không toàn cục. Đặt một rule WAF ở edge trước các route
  auth công khai nếu cần hạn mức toàn cục chính xác.
- Phân loại theo thời điểm đến so đồng hồ của request với đồng hồ của replica đã
  hoàn tất setup. Lệch đồng hồ giữa các replica chỉ dịch ranh giới `409`/`404` đúng
  bằng độ lệch đó. Nó không bao giờ cho phép admin thứ hai.
