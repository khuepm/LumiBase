# Requirements Document — Setup-Complete Per-IP Rate Brake

## Introduction

Endpoint bootstrap admin đầu tiên là `POST /api/v1/setup/complete` (`apps/cms/src/modules/setup/routes.ts:280`), mount **ngoài** stack xác thực vì nó phải trả lời khi chưa có user nào. Việc tạo admin đã có race guard **mạnh** ở tầng service: `SELECT ... FOR UPDATE` trên singleton `system_state`, state-machine (`initialized`→404, `initializing`→409), unique index `system_state_admin_path_unique`, và ánh xạ lỗi 23505 (`service.ts:430-478, 524-528`). Race condition trên first-admin creation **không phải** lỗ hổng.

Lỗ hổng còn lại là hẹp: khác với `GET /setup/state` (đã rate-limit 60 req/min/IP qua `checkStateRateLimit`, `routes.ts:94-104`), `POST /setup/complete` **không có** rate-limit per-IP riêng. Nó dựa hoàn toàn vào DB lock + tính one-shot. Điều đó để ngỏ:
- **Brute-force `setupToken`** khi `LUMIBASE_REQUIRE_SETUP_TOKEN=true`: attacker chưa bị chặn tốc độ có thể thử token liên tục trước khi setup hoàn tất.
- **Password/validation probing & resource abuse**: mỗi `/complete` parse body + chạy password hashing (Argon/bcrypt) — tốn CPU; spam không giới hạn là vector DoS trên cửa sổ trước-khi-initialized.

Đây là analog của Strapi #26494 (rate limiting on admin registration, critical/urgent). Spec bổ sung một **per-IP rate brake** cho `/setup/complete`, tái dùng đúng khuôn `checkStateRateLimit` đã có trong cùng file — effort thấp, không hạ tầng mới.

Phạm vi có chủ đích hẹp: **chỉ** thêm brake per-IP cho `/complete`. Không đụng race guard (đã đủ), không đổi state-machine, không đổi hình dạng response ngoài nhánh 429.

## Glossary

- **Setup_Complete**: Endpoint `POST /api/v1/setup/complete` — tạo bootstrap admin.
- **Rate_Brake**: Sliding-window in-memory per-IP limiter (khuôn `checkStateRateLimit` sẵn có tại `routes.ts:94-104`).
- **Client_IP**: IP suy ra từ `extractClientIp(c.req.raw)` (đã dùng cho `/state` và context `/complete`).
- **Complete_Window / Complete_Max**: Cửa sổ và trần request cho `/complete` (chặt hơn `/state` vì đây là mutation đắt, one-shot).

## Requirements

### Requirement 1: Per-IP rate brake trên /setup/complete

**User Story:** Là người vận hành, tôi muốn `POST /setup/complete` bị giới hạn tốc độ theo IP, để attacker không thể brute-force `setupToken` hay spam mutation đắt trong cửa sổ trước-khi-initialized.

#### Acceptance Criteria

1. WHEN một Client_IP gửi tới `POST /setup/complete` vượt `Complete_Max` request trong `Complete_Window`, THE Setup_Complete SHALL trả `429` với envelope `{ errors: [{ code: 'RATE_LIMITED' }] }` và header `retry-after` (giây), **trước khi** parse body hoặc gọi service (không chạy password hashing).
2. THE Rate_Brake SHALL keyed theo Client_IP từ `extractClientIp(c.req.raw)`, dùng khuôn sliding-window in-memory cùng kiểu `checkStateRateLimit` (không thêm hạ tầng: không KV, không Redis, không DO).
3. WHEN request nằm trong hạn mức, THE Setup_Complete SHALL tiếp tục luồng hiện tại không đổi (parse → validate → `svc.complete`), giữ nguyên response 201/4xx/5xx hiện có.
4. THE Rate_Brake của `/complete` SHALL độc lập với bucket của `/state` (bucket/counter riêng), để lưu lượng `/state` không tiêu hao hạn mức `/complete` và ngược lại.
5. THE `Complete_Max` mặc định SHALL chặt hơn `/state` (đề xuất `10 req / 60_000 ms / IP`), phản ánh việc `/complete` là mutation đắt, one-shot — nhưng vẫn đủ nới để một người dùng thật thử-sai vài lần (sai password policy, thiếu token) không bị khoá.

### Requirement 2: Fail-safe & không hồi quy

**User Story:** Là maintainer, tôi muốn brake không phá được luồng setup hợp lệ và không rò trạng thái, để một fresh instance vẫn setup được bình thường.

#### Acceptance Criteria

1. THE Rate_Brake SHALL không thay đổi hành vi race-condition/one-shot hiện có: sau khi setup thành công, `/complete` vẫn 404 indistinguishably qua state-machine (429 chỉ áp cho lưu lượng vượt hạn mức khi còn uninitialized).
2. THE 429 response SHALL không rò thông tin phiên bản, hostname, hay tenant id (nhất quán Req 1.6 của admin-setup-wizard).
3. WHERE `extractClientIp` trả về giá trị rỗng/không xác định, THE Rate_Brake SHALL vẫn keyed một cách xác định (ví dụ khoá `'unknown'`) chứ không ném lỗi hay fail-open im lặng.
4. THE existing `__resetSetupRateLimitForTests()` SHALL cũng reset bucket của `/complete` (hoặc bổ sung một reset song song), để test cô lập giữa các lần chạy.

### Requirement 3: Kiểm thử

**User Story:** Là maintainer, tôi muốn test khẳng định brake chặn đúng ngưỡng và không chặn nhầm luồng hợp lệ.

#### Acceptance Criteria

1. THE spec SHALL có test: gửi `Complete_Max + 1` request `/complete` từ cùng IP → request cuối nhận 429 với `retry-after`; và service **không** được gọi ở request bị chặn (khẳng định không có password hashing/DB write).
2. THE test SHALL khẳng định IP khác không bị ảnh hưởng bởi hạn mức của IP đầu (cô lập theo IP).
3. THE test SHALL khẳng định một luồng `/complete` hợp lệ trong hạn mức vẫn trả 201 (dùng `setupServiceOverride` như các test setup hiện có).
4. THE test SHALL khẳng định bucket `/complete` và `/state` độc lập (spam `/state` không làm 429 `/complete`).

## Out of scope

- Race-condition/one-shot guard cho first-admin (đã có `FOR UPDATE` + unique index — không đụng).
- Rate-limit phân tán/chính xác qua KV/Redis/DO (in-memory per-isolate là đủ cho cửa sổ setup ngắn; nhất quán với `/state` hiện tại). Ghi rõ giới hạn: nhiều isolate/instance ⇒ hạn mức là per-isolate, không toàn cục — chấp nhận vì đây là defence-in-depth cho một cửa sổ one-shot.
- `POST /auth/register` (self-service) — đã có `checkRegistrationRate()` riêng (`auth.ts:496`), ngoài phạm vi.
