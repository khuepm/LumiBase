# Task/Plan: Các guard bảo mật runtime cho LumiBase

## Mục tiêu

Chuẩn bị nền bảo mật runtime rõ ràng trước khi AI Harness được phép tạo hoặc áp dụng thay đổi vào hệ thống. Mỗi guard có trách nhiệm riêng, tên riêng và điểm gắn riêng trong pipeline để đội phát triển dễ hiểu, dễ review và dễ bắt buộc Harness sử dụng về sau.

## Phạm vi task

1. **Control-plane access guard**
   - Chặn principal không phải admin tại các bề mặt quản trị hệ thống như roles, policies, permissions, users, teams, settings, API keys, admin và CDC.
   - Bảo vệ các bảng/collection hệ thống tương đương `lumibase_users`, `lumibase_roles`, `lumibase_permissions` khỏi thao tác leo thang đặc quyền.

2. **Security headers middleware**
   - Gắn CSP mặc định vào mọi response.
   - Bật `nosniff`, `DENY` frame, `no-referrer`, `Permissions-Policy`, COOP và CORP để giảm XSS/CSS injection, clickjacking và lộ dữ liệu qua browser surface.

3. **File upload policy**
   - Cấm public role tạo metadata upload.
   - Giới hạn kích thước upload bằng `FILE_UPLOAD_MAX_BYTES`, mặc định 10 MiB.
   - Cho phép MIME theo `FILE_UPLOAD_ALLOWED_MIME_TYPES`, mặc định chỉ gồm ảnh phổ biến, PDF, CSV và text.
   - Kiểm tra signed upload PUT trước khi ghi vào storage.

4. **Outbound URL guard**
   - Cung cấp utility kiểm tra outbound URL trước khi bất kỳ tính năng import/fetch URL nào gọi `fetch`.
   - Chặn protocol không phải HTTP(S), URL có embedded credentials, localhost, RFC1918, link-local, loopback và cloud metadata IP.

## Kế hoạch triển khai

- [x] Tách các thành phần thành module riêng: `security-headers`, `control-plane-access-guard`, `file-upload-policy`, và `outbound-url-guard`.
- [x] Gắn `security-headers` vào global middleware chain.
- [x] Gắn `control-plane-access-guard` và `file-upload-policy` vào authenticated tenant-scoped API chain.
- [x] Thêm biến môi trường cấu hình upload policy trong `Bindings`.
- [x] Thêm unit tests riêng cho từng guard để tên test phản ánh đúng trách nhiệm.
- [x] Bổ sung audit event cụ thể cho các lần guard từ chối thao tác: `control_plane_access_denied` và `file_upload_policy_denied`.
- [ ] Ở phase Harness tiếp theo: bắt buộc mọi tool/fetch/import do AI gọi phải đi qua `validateOutboundUrl` hoặc `guardedFetch`.
- [ ] Ở phase hardening tiếp theo: ánh xạ permission granular nếu cần cho non-admin operator.

## Tiêu chí hoàn tất

- Non-admin principal nhận `CONTROL_PLANE_FORBIDDEN` khi gọi system control-plane routes.
- Public role không thể tạo file metadata upload.
- Upload quá kích thước hoặc MIME ngoài allowlist bị từ chối trước khi ghi storage.
- Mọi response có CSP và các security headers nền tảng.
- Outbound URL guard có test cho localhost, private IP, link-local metadata IP và protocol nguy hiểm.
- Control-plane guard và file upload policy ghi audit event riêng khi request có DB context.

## Guard: RBAC context cho ItemService (chống fail-open)

### Vấn đề

`ItemService` chỉ enforce row/field RBAC khi được khởi tạo kèm `permissionCtx`.
Nếu vắng, `this.permissions = null` và **mọi** kiểm tra quyền short-circuit sang
"cho phép" (fail-open). Thiết kế này cố ý — worker hệ thống chạy hợp lệ mà không
có user principal — nhưng khiến một call site theo request nếu **quên**
`permissionCtx` sẽ âm thầm bỏ qua phân quyền, trông y hệt system context cố ý.

Lỗi này từng ship: skill AI `updateItem` chạy `ItemService.patch()` trên service
thiếu `permissionCtx` → LLM sửa item bỏ qua RBAC (PR #151). Rà soát lại phát hiện
endpoint MCP (`routes/mcp.ts`) dính đúng lỗi này dù comment của nó cam kết
"MCP client không thể làm nhiều hơn token qua Agent API".

### Cơ chế chặn hồi quy (đã triển khai)

Mọi khởi tạo `ItemService` đi qua hai helper tường minh trong
`apps/cms/src/services/item-service-factory.ts`:

- **`itemServiceForRequest(c)`** — dùng cho MỌI service tạo khi xử lý HTTP request
  (routes, GraphQL resolver, MCP). Luôn gắn `permissionCtx` từ Hono context;
  `permissionCtx` áp cuối cùng nên `overrides` không thể vô tình gỡ enforcement.
- **`itemServiceForSystem(deps, reason)`** — dùng cho flow hệ thống/nền. Bắt buộc
  truyền `SystemContextReason` (`'scheduler'` | `'background-worker'` |
  `'compliance-erasure'`) để tác giả phải **nêu lý do** tại sao fail-open an toàn.

Test hồi quy `apps/cms/src/__tests__/item-service-rbac-context.test.ts` quét source
và **fail CI** nếu có `new ItemService(...)` trực tiếp ngoài factory (trừ allowlist
đã review). Người sửa sau không thể tái tạo lỗ hổng fail-open mà reviewer không thấy.

### Bảng phân loại call site (audit)

| Call site | Chế độ | Lý do |
|-----------|--------|-------|
| `routes/items.ts` | request | REST CRUD — enforce RBAC theo bearer token |
| `routes/ai.ts` (`/chat`, `/approvals/:id/decide`) | request | skill AI enforce cùng RBAC như `/items` (PR #151) |
| `routes/mcp.ts` | request | **đã vá** — trước đây thiếu `permissionCtx` (fail-open) |
| `routes/admin-sar.ts` | request | SAR export — admin-gated + enforce RBAC |
| `graphql/context.ts` | request | GraphQL kế thừa nguyên governance của REST |
| `services/scheduler-worker.ts` | system `scheduler` | cron retention sweep, không có user principal |
| `services/veto-commit-worker.ts` | system `background-worker` | commit sau khi veto window đã chốt quyết định human |
| `services/agent-run-worker.ts` | system `background-worker` | governed agent run — HITL/autonomy gate ở harness, không phải RBAC user |
| `services/erasure-service.ts` | system `compliance-erasure` | erasure/SAR gated admin + dual-control ở tầng service |

### Checklist khi thêm ItemService mới

- [ ] Call site nằm trong đường xử lý HTTP request (có `Context<AppEnv>`)? → dùng `itemServiceForRequest(c)`. TUYỆT ĐỐI không tự viết `permissionCtx` inline.
- [ ] Call site là worker/cron/compliance chạy quyền hệ thống? → dùng `itemServiceForSystem(deps, reason)` và chọn `reason` đúng ngữ nghĩa.
- [ ] Nếu buộc phải `new ItemService(...)` trực tiếp (hiếm) → thêm vào `ALLOWED_DIRECT_CONSTRUCTION` trong test guard kèm lý do, để reviewer thấy.
- [ ] Đã cập nhật bảng phân loại phía trên khi thêm call site request/system mới.

### Tiêu chí hoàn tất (guard này)

- Không file production nào (ngoài factory + allowlist) gọi `new ItemService(...)` trực tiếp — bảo đảm bằng test source-scan.
- Endpoint AI và MCP enforce row/field RBAC đúng như `/items` (skill LLM không leo quyền vượt token).
- Mọi system context khai báo `reason` tường minh, greppable, có mặt trong bảng audit.
