---
version: 2
lastUpdated: 2026-08-02T19:09:21.814Z
sourceLang: en
translatedFrom: en
sourceHash: dcfa4f547e6476fb
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:09:30.532Z
codeVerifiedHash: dcfa4f547e6476fb
codeVerifiedClaims: 20
---

# Route guards — the `/api/v1` security chain

Mọi request API đã xác thực đi qua một chuỗi middleware cố định
được gắn trong `apps/cms/src/index.ts`:

```
withTenant → withDb → withAuth → withSiteMembership → requireSetupComplete
  → withStudioAccess → withControlPlaneAccessGuard → withFileUploadPolicy → withRls
```

Mỗi lớp trả lời một câu hỏi, theo thứ tự:

| Lớp | Câu hỏi | Thất bại |
| --- | --- | --- |
| `withTenant` | Request này dành cho site nào? (`X-Lumi-Site`) | 400 |
| `withAuth` | Ai đang gọi? (CF Access / JWT tùy chỉnh / API key / dev token) | 401 `UNAUTHENTICATED` |
| `withSiteMembership` | Principal này có được phép trên **site đó** không? (thành viên `user_sites`; API key đã được khớp site bởi `withAuth`) | 403 `TENANT_FORBIDDEN` |
| `withStudioAccess` | Principal này có được dùng bề mặt Studio không? (`appAccess`, TFA) | 403 `APP_ACCESS_DENIED` / `TFA_REQUIRED` |
| `withControlPlaneAccessGuard` | Đây có phải đường dẫn quản trị hệ thống không? Nếu vậy đòi hỏi một principal admin ngay cả khi route quên kiểm tra của chính nó. | 403 `CONTROL_PLANE_FORBIDDEN` |
| `withRls` | Row-level security của Postgres như tuyến phòng thủ cuối. | — |

## Quy tắc khi thêm hoặc thay đổi route

1. **Bề mặt `/api/v1` mới → phân loại nó trước.** Content plane (phân quyền
   theo từng item), Studio management plane (`STUDIO_ACCESS_PATH_PREFIXES` trong
   `middleware/studio-access.ts`), hoặc control plane (`CONTROL_PLANE_PATHS` trong
   `middleware/control-plane-access-guard.ts`). Các tiền tố control-plane PHẢI được
   thêm vào danh sách guard — chỉ `adminOnly` theo từng route là không đủ,
   vì một refactor sau này có thể bỏ nó (đó chính xác là cách hồi quy extensions
   đã xảy ra).
2. **Không bao giờ thêm một đường dẫn vào danh sách bypass/public mà không có test.** Các danh sách bypass
   nằm trong `middleware/auth.ts` (xác thực), và các
   tập `PUBLIC_AUTH_PATHS` trong `middleware/site-membership.ts` và
   `middleware/studio-access.ts`. Một đường dẫn bỏ qua `withAuth` sẽ tới
   handler của nó mà **không có principal nào cả** — handler không được đọc
   `c.get('auth')` mà không xử lý `undefined`.
3. **Guard theo từng route kết hợp với, không bao giờ thay thế, chuỗi.** `adminOnly`,
   `requireSiteAdmin`, `requireSchemaPermission`, các kiểm tra phê duyệt HITL v.v.
   chạy *bên trong* các route; chuỗi ở trên là biện pháp dự phòng.
4. **Các bề mặt điều phối động (extensions, agent harness, flows) là
   control-plane.** Bất cứ thứ gì nạp và thực thi mã đã lưu hoặc thay đổi
   trạng thái agent đòi hỏi một principal admin trước khi handler chạy.

## Các test tripwire

`apps/cms/src/__tests__/security-guards.wiring.test.ts` khẳng định, ở mức nguồn,
rằng chuỗi vẫn được gắn đúng thứ tự, rằng `/api/v1/auth/register`
không nằm trên bất kỳ danh sách bypass nào, rằng điều phối extension động giữ `adminOnly`,
và rằng danh sách đường dẫn control-plane bao phủ các tiền tố admin đã biết. Nếu một
trong các khẳng định này làm build của bạn thất bại, bạn hoặc đã tái tạo một lỗ hổng đã được sửa
hoặc đã tái cấu trúc một guard — trong trường hợp sau, hãy cập nhật
khẳng định cùng với các test hành vi cho hình dạng mới.

Các test hành vi đi kèm:

- `middleware/__tests__/site-membership.test.ts` — từ chối xuyên tenant,
  các ngoại lệ dev/CF-Access.
- `middleware/__tests__/control-plane-access-guard.test.ts` — biện pháp dự phòng admin +
  sự kiện audit.
- `routes/extensions.test.ts` — cổng admin trên quản lý và điều phối động.
- `routes/__tests__/auth-register.test.ts` — register fail closed khi không có
  principal; ràng buộc id role member đã seed (không bao giờ là một literal role key).

## Lịch sử sự cố (tại sao các quy tắc này tồn tại)

| Bản sửa | Lỗ hổng |
| --- | --- |
| PR #184 (đã port) | Không có kiểm tra thành viên giữa `withAuth` và các handler: bất kỳ principal đã xác thực nào cũng có thể chọn một `X-Lumi-Site` tùy ý và thao tác trên một tenant khác. |
| PR #152 (đã port) | Refactor bỏ `adminOnly` khỏi `extensionsRouter.all('/:name/*')` — người dùng không phải admin có thể thực thi các bundle endpoint với host binding. |
| PR #153/#154 | `/api/v1/agent` thiếu khỏi `CONTROL_PLANE_PATHS` — các token đặc quyền thấp có thể đọc/thay đổi trạng thái Agent Harness. |
| PR #150 | MCP server nối `collection`/`id` chưa validate vào các đường dẫn API — path traversal đến các endpoint `/api/v1/*` lân cận với token operator. |
| PR #130 (lỗi ban đầu, nay đã thay thế) | `/auth/register` ban đầu bị crash (handler đọc principal trên đường dẫn bỏ qua `withAuth`) và gán người dùng với role id `'member'`. PR #190 tạm thời khóa thành admin-only; PR #130 thay thế bằng thiết kế **dịch vụ tự phục vụ công khai** như ý định — an toàn vì role được giải quyết ở phía server thành `subscriber` không có đặc quyền và tài khoản bắt đầu ở trạng thái `invited` cho đến khi xác thực email. Register công khai trở lại, nhưng mạng lưới an toàn hiện là role phía server + xác thực, được khẳng định bởi các tripwire ở trên. |
