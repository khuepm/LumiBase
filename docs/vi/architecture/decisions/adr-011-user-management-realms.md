---
version: 1
lastUpdated: 2026-07-08T20:23:24.860Z
sourceLang: en
translatedFrom: en
sourceHash: ad07e9950138a1c0
mtEngine: claude
syncStatus: machine-translated
---

# ADR-011: User Management Realms (kho định danh duy nhất, realm phân tách theo role, token audiences)

**Date:** 2026-06-18
**Status:** Accepted

## Context

LumiBase là một headless Content OS: backend CMS phục vụ giao diện quản trị
Studio **và** các frontend công khai cho người dùng cuối (ví dụ một site
Next.js nơi khách truy cập đăng ký, đăng nhập và đọc bài viết). Do đó có hai
nhóm đối tượng rất khác nhau cùng xác thực với chung một backend:

1. **Staff / operators** — editor, admin, đồng đội quản lý nội dung trong
   Studio. Đặc quyền cao, số lượng nhỏ, được onboard một cách có chủ đích.
2. **Frontend end-user (subscriber)** — khách tự đăng ký trên một site tiêu
   dùng. Đặc quyền thấp, số lượng có thể rất lớn, tự phục vụ.

Một câu hỏi thiết kế lặp đi lặp lại (và là ngòi nổ cho ADR này) là: *liệu
người dùng frontend tự đăng ký có nên nằm chung bảng `users` với admin không,
và điều đó có nguy hiểm không?*

Trước ADR này, mã nguồn tồn tại hai vấn đề tiềm ẩn:

- `POST /api/v1/auth/register` đọc `c.get('auth')` và yêu cầu một role
  `admin`, **nhưng** `withAuth` lại bỏ qua hoàn toàn đường dẫn đó — nên
  principal luôn là `undefined` và route ném lỗi. Việc tự đăng ký thực chất
  đã hỏng.
- Giá trị role mặc định `roleId: 'member'` không khớp với bất kỳ `roles.id`
  thực nào (role dùng `nanoid`/`system_key`), nên dù có tới được thì lệnh
  insert cũng vi phạm FK `user_sites.role_id`. Ngoài ra role hệ thống
  `member` mang `appAccess: true` — nó là một role *Studio*, không phải role
  người dùng cuối theo nguyên tắc đặc quyền tối thiểu.

Mấu chốt: **bảng dùng chung** không phải là thứ nguy hiểm; thứ nguy hiểm là
một **ranh giới phân quyền** yếu hoặc thiếu giữa các realm.

## Decision

### 1. Giữ MỘT kho định danh `users` toàn cục

Một con người là một định danh (`users.email` gần như duy nhất, `users.id`
toàn cục). Multi-tenancy và realm được biểu diễn thông qua
`user_sites.role_id`, không phải qua các bảng user riêng biệt. Cách này bảo
toàn tính chất "một con người, nhiều site/role" (một nhân viên cũng có thể là
subscriber ở nơi khác) và giữ cho bề mặt auth đồng nhất.

### 2. Phân tách realm theo ROLE, thực thi ở ba lớp

| Realm | Role | `appAccess` | Onboarding |
|-------|------|-------------|------------|
| Staff | `administrator`, `member` | `true` | Invite-only (`POST /users/invite`, admin-gated) |
| Frontend end-user | **`subscriber`** (mới) | **`false`** | Public self-service (`POST /auth/register`) |

Một role hệ thống **`subscriber`** đặc quyền tối thiểu chuyên biệt
(`system_key='subscriber'`, `adminAccess=false`, `appAccess=false`) là mặc
định cho việc tự đăng ký. Nó không cấp gì cho tới khi operator gắn
policy/permission nội dung vào nó. Nó được cấp phát một cách idempotent ở lần
đăng ký đầu tiên (`ensureSubscriberRole`, phản chiếu cơ chế `upsertMemberRole`
lười của Setup Wizard), nên không cần thay đổi setup-transaction hay backfill.

### 3. Token audiences (claim `aud`) như một bức tường cứng

`POST /auth/login` phát Custom JWT HS256 cho cả hai realm qua một endpoint và
một `JWT_SECRET`. Chúng ta ghim một claim `aud` tại thời điểm ký:

- `studio` — bootstrap admin hoặc bất kỳ role nào có `appAccess`.
- `frontend` — tất cả những đối tượng còn lại (subscriber / role không có
  `appAccess`).

`withStudioAccess` **từ chối thẳng các token có audience `frontend`**, trước
mọi bước đánh giá policy. Đây là defense-in-depth chồng lên bước kiểm tra
bundle `appAccess` hiện có: kể cả khi một cấu hình sai trong tương lai cấp cho
subscriber `appAccess`, token của họ vẫn không thể bị replay vào bề mặt quản
lý Studio vì audience của nó ghi là `frontend`.

Một audience thứ ba, `email-verify`, gắn nhãn cho token xác minh khi đăng ký
để một link xác minh không bao giờ có thể được dùng như một session token.

### 4. Guardrail cho việc tự đăng ký

Endpoint công khai `POST /auth/register` sau khi viết lại:

1. **Role do server quyết định** — luôn là `ensureSubscriberRole(...)`; body
   của request không bao giờ chọn được role.
2. **Chưa kích hoạt cho tới khi verify** — tài khoản được tạo với
   `status: 'invited'`; `/auth/login` vốn đã chặn dựa trên
   `status === 'active'`. Một JWT `email-verify` stateless được gửi qua email;
   `POST /auth/verify-email` chuyển user sang `active`. Tính dùng-một-lần được
   thực thi bởi chuyển trạng thái.
3. **Rate limit theo IP** — một bộ đếm best-effort trong runtime cache hãm lại
   việc đăng ký hàng loạt theo script (fail open khi cache gặp sự cố).
4. **Chống liệt kê (anti-enumeration)** — trả về một `202` chung giống hệt
   nhau bất kể email đã tồn tại hay chưa.

Việc xác minh email được thiết kế **stateless** một cách có chủ đích (một JWT
đã ký, không có bảng token) để giữ tính edge-native và tránh một migration;
đánh đổi là mất khả năng revoke theo từng token, chấp nhận được với một link
24h.

## Consequences

**Positive**

- Khách tự đăng ký không bao giờ có thể giành được quyền truy cập
  Studio/admin — được thực thi ở khâu quyết định role (phía server),
  `appAccess`, và token audience.
- Việc đăng ký cuối cùng cũng hoạt động (route cũ là dead code) và tuân theo
  best practice hiện hành (verify, rate limit, không enumeration).
- Một kho định danh duy nhất giữ mô hình đơn giản và hỗ trợ con người có vai
  trò kép.
- Không cần schema migration và không cần backfill (role subscriber lười +
  chỉ là dữ liệu; audience là claim JWT bổ sung; verify là stateless).

**Negative / trade-offs**

- Token xác minh email không thể revoke riêng lẻ trước khi hết hạn (giảm
  thiểu: TTL ngắn; rotate `JWT_SECRET` để vô hiệu hóa tất cả).
- Rate limit theo IP là best-effort (cache không atomic); một hạn ngạch cứng
  cần một luật edge WAF hoặc một backend đếm atomic.
- `member` so với `subscriber` là một quy ước operator phải tôn trọng: không
  bao giờ gắn policy Studio vào `subscriber`.

**Security notes (Reality Filter)**

- Bức tường audience và bước kiểm tra `appAccess` là các cơ chế
  *quan-sát-được-trong-mã* được xác minh bởi unit test
  (`studio-access.test.ts`, `token-audience.test.ts`); chúng giảm — chứ không
  chứng minh được là loại bỏ hoàn toàn — rủi ro leo thang đặc quyền.
  [Inference]

## MCP exposure (future) — feasibility

Xem `docs/en/security/user-management.md` § "Exposing user management over
MCP" để có đánh giá đầy đủ. Tóm tắt: bề mặt **management**
(`/users`, `/users/invite`, gán role) là một ứng viên hợp lý cho một *server*
công cụ MCP được gate bởi một API key gắn với một admin policy; bề mặt
**public auth** (`register`/`login`/`verify-email`) thì KHÔNG nên phơi bày dưới
dạng công cụ MCP (nó là luồng thông tin xác thực của người dùng cuối, không
phải một năng lực của agent). Bất kỳ công cụ MCP nào có thể tạo mới hoặc leo
thang user PHẢI đi qua đường HITL `ai_approvals` hiện có (Strict Rule #4).

## References

- `apps/cms/src/routes/auth.ts` — register / verify-email / login
- `apps/cms/src/middleware/auth.ts`, `middleware/studio-access.ts`
- `apps/cms/src/services/auth/{frontend-role,token-audience,email-verification}.ts`
- `apps/cms/src/modules/auth/registration-guard.ts`
- ADR-007 (Logto for auth), ADR-008 (Policy DSL)
