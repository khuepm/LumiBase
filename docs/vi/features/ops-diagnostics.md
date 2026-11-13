---
sourceLang: en
version: 1
lastUpdated: 2026-11-13T15:46:34.785Z
translatedFrom: en
sourceHash: d69e70aa06baefd9
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-13T19:16:05.746Z
codeVerifiedHash: d69e70aa06baefd9
codeVerifiedClaims: 26
---

# Chẩn đoán vận hành (ops diagnostics)

Một mặt phẳng vận hành chỉ-đọc để trả lời câu hỏi "vì sao production đang lỗi?" chỉ với một secret tĩnh: không cần trình duyệt đã đăng nhập, không cần Cloudflare API token, không cần thông tin đăng nhập cơ sở dữ liệu. Nó được thiết kế cho agent (Claude Code, mọi MCP client) cũng như cho người dùng `curl`.

Nó bao quát những lỗi mà bình thường phải cần `wrangler tail` hoặc một phiên `psql`:

- một lỗi 500 chỉ ghi `{ "code": "INTERNAL", "requestId": "…" }`;
- code được deploy trước migration của nó (`column … does not exist`);
- `rls-policies.sql` đã được áp dụng trong khi `LUMIBASE_DB_RLS` và các role cơ sở dữ liệu không khớp nhau (request không thấy dòng nào, nên trang trả về 404);
- một dịch vụ bị suy giảm phía sau `/health`.

Thiết kế: `.kiro/specs/ops-diagnostics/design.md`.

## Bật tính năng

Đặt `LUMIBASE_OPS_TOKEN` thành một secret ngẫu nhiên dài ít nhất 32 ký tự:

```bash
openssl rand -base64 36 | wrangler secret put LUMIBASE_OPS_TOKEN --env production
```

Trên Docker, đặt nó trong biến môi trường của CMS. Nếu token chưa được đặt hoặc ngắn hơn 32 ký tự, mọi route ops trả về đúng 404 giống một route không tồn tại, ở mọi môi trường, nên không thể dò ra mặt phẳng này.

Token này tách riêng khỏi `METRICS_TOKEN` vì nó truy cập sâu hơn (thông báo lỗi, tên bảng và cột, probe theo từng site). Nó không phải một người dùng, không gắn với site nào và không gọi được các route tenant dưới `/api/v1/*`.

Sau đó áp dụng migration `0029_ops_errors` và áp dụng lại `packages/database/migrations/rls-policies.sql` (`pnpm db:migrate` không áp dụng file đó).

## Các route

Tất cả đều là `GET`, nhận `Authorization: Bearer $LUMIBASE_OPS_TOKEN`, trả về `Cache-Control: no-store`, và được cài đặt trong `apps/cms/src/modules/ops/routes.ts`.

| Route | Trả lời |
|---|---|
| `/api/v1/ops/diagnostics` | Bản phát hành (`LUMIBASE_VERSION` + `LUMIBASE_GIT_SHA`); migration đang chờ (journal được đóng gói so với `drizzle.__drizzle_migrations`); độ lệch schema (các bảng và cột mà code đã deploy truy vấn nhưng cơ sở dữ liệu không có); chế độ RLS, role app và role system và việc chúng có bỏ qua RLS hay không, và các policy đã được cài hay chưa; tình trạng dịch vụ; và `findings`. |
| `/api/v1/ops/errors` | Các lỗi 5xx đã được ghi lại, mới nhất trước. Bộ lọc: `since` (thời gian ISO), `status` (500–599), `path` (tiền tố), `siteId`, `requestId`, `limit` (≤ 200). |
| `/api/v1/ops/errors/:requestId` | Lỗi đã ghi lại cho `requestId` mà client thấy trong body của lỗi 500 hoặc header `x-request-id`. |
| `/api/v1/ops/sites/:siteId/probe` | Chạy đúng câu lệnh mà `GET /api/v1/site` chạy, trên kết nối mà một request sẽ dùng: dòng có tồn tại không (role system), kết nối của request có thấy nó không, có thấy dưới phạm vi RLS của site không, câu lệnh có lỗi không (đã làm sạch, kèm SQLSTATE), và số thành viên. |

Mỗi finding có `code`, `severity` (`error`, `warn` hoặc `info`), `message`, và thường có `fix`, để agent hành động được mà không cần phân tích văn xuôi. Các code gồm `MIGRATIONS_PENDING`, `SCHEMA_DRIFT`, `RLS_POLICIES_WITHOUT_FLAG`, `ENFORCE_WITHOUT_SYSTEM_CONNECTION`, `SYSTEM_ROLE_CANNOT_BYPASS`, `APP_ROLE_BYPASSES_RLS_UNDER_ENFORCE`, `OPS_ERRORS_TABLE_MISSING`, `SERVICE_UNHEALTHY`, và từ probe là `SITE_NOT_FOUND`, `SITE_QUERY_FAILS` và `SITE_ROW_HIDDEN_BY_RLS`. Các quy tắc RLS giống hệt những gì `apps/cms/src/config/db-rls-startup.ts` kiểm tra khi một tiến trình Docker khởi động. Workers không có bước khởi động tiến trình, nên trên Workers route này là nơi duy nhất kiểm tra chúng.

```bash
curl -s -H "Authorization: Bearer $LUMIBASE_OPS_TOKEN" \
  https://api.example.com/api/v1/ops/diagnostics | jq '.data.findings'
```

## Ghi lại lỗi

Mọi response có status từ 500 trở lên được ghi vào `lumibase_ops_errors`: lỗi bị ném ra từ `app.onError`, và lỗi được trả về trực tiếp như `503 RLS_MISCONFIGURED` từ request logger. Mỗi dòng được định danh bằng `requestId` và chứa method, path (không bao giờ có query string), status, site, principal (`user:<id>` hoặc `apikey:<id>`, không bao giờ là token), bản phát hành, mã lỗi của response, và chuỗi lỗi đã được làm sạch.

Bộ làm sạch (`apps/cms/src/modules/ops/sanitize.ts`) đi theo `cause`, nên SQLSTATE của Postgres mà Drizzle bọc lại vẫn được giữ. Nó giữ nội dung câu lệnh SQL nhưng bỏ tham số truy vấn, bỏ `detail` và `where` của Postgres (chúng lặp lại giá trị dòng), và che bearer token, JWT, API key và mật khẩu trong connection string.

Việc ghi là best-effort: chạy tách rời trên kết nối system, không bao giờ làm request thất bại, và bị giới hạn 60 lần mỗi isolate mỗi phút. Các dòng cũ hơn 14 ngày được chính bộ ghi dọn đi. Bảng có RLS được bật và ép buộc mà không có policy nào, nên role app không đọc được gì và chỉ role system (BYPASSRLS) đọc được.

## MCP

`@lumibase/mcp-server` đăng ký bốn tool chỉ-đọc khi môi trường của nó có `LUMIBASE_OPS_TOKEN`: `ops_diagnostics`, `ops_list_errors`, `ops_get_error` và `ops_probe_site`. Chúng gửi ops token, không bao giờ gửi API key của site, và không gửi header site. Khi có `LUMIBASE_URL` và `LUMIBASE_OPS_TOKEN` nhưng không có `LUMIBASE_TOKEN`, server khởi động ở chế độ chỉ-ops với đúng bốn tool này, hữu ích khi chính xác thực tenant là thứ đang hỏng.

```json
{
  "mcpServers": {
    "lumibase-ops": {
      "command": "npx",
      "args": ["-y", "@lumibase/mcp-server"],
      "env": {
        "LUMIBASE_URL": "https://api.example.com",
        "LUMIBASE_OPS_TOKEN": "<ops token>"
      }
    }
  }
}
```

## Lưu ý bảo mật

- Response không chứa dữ liệu dòng: probe chỉ trả về boolean và số đếm, lỗi được làm sạch, và phần chẩn đoán chỉ báo tên schema và tên role.
- Mỗi lệnh gọi ops ghi một dòng có cấu trúc `ops_access` kèm `requestId`.
- Xoay vòng token như mọi secret khác. Nó chỉ cấp quyền đọc metadata vận hành và không có đường ghi nào.
