---
title: Mặc định an toàn và lumibase doctor --security
sourceLang: en
version: 1
lastUpdated: 2026-11-14T02:04:01.435Z
translatedFrom: en
sourceHash: 23ef15e31d018d14
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:04:01.435Z
codeVerifiedHash: 23ef15e31d018d14
codeVerifiedClaims: 34
---

# Mặc định an toàn và `lumibase doctor --security`

> Dự án mới không có secret dùng chung và không có admin mặc định. `lumibase doctor --security` đối chiếu cấu hình của dự án với checklist production.

## `create-lumibase` sinh ra những gì

Không template nào chứa secret. File mẫu được commit liệt kê mọi secret với giá trị **rỗng**. Sau đó scaffolder ghi một file cục bộ (đã gitignore) chứa giá trị CSPRNG mới, với quyền `0600`. Các hàm sinh secret nằm ở `packages/create-lumibase/src/secrets.ts`.

| Template | File mẫu (commit) | File cục bộ (sinh ra) | Khoá được sinh |
| --- | --- | --- | --- |
| `nextjs` | `.env.example` | `.env` | `JWT_SECRET`, `ENCRYPTION_KEY`, `LUMIBASE_ADMIN_PASSWORD` |
| `default` | `.env.example` | `.env` | `JWT_SECRET`, `ENCRYPTION_KEY` |
| `cloudflare` | `.dev.vars.example` | `.dev.vars` | `JWT_SECRET`, `ENCRYPTION_KEY` |

- `JWT_SECRET` gồm 48 byte ngẫu nhiên dạng base64url (64 ký tự).
- `ENCRYPTION_KEY` là base64 của 32 byte ngẫu nhiên, đúng định dạng CMS kiểm tra trong `apps/cms/src/config/production.ts`.
- `LUMIBASE_ADMIN_PASSWORD` là chuỗi ngẫu nhiên, đạt chính sách 12+ ký tự gồm đủ bốn loại ký tự. Starter không có admin mặc định: `cms:bootstrap` báo lỗi nếu thiếu mật khẩu.
- `.env` / `.dev.vars` đã tồn tại thì không bao giờ bị ghi đè, vì sinh lại `ENCRYPTION_KEY` sẽ khiến dữ liệu đã mã hoá không giải mã được nữa. Giá trị sinh ra không bao giờ được in ra màn hình.

Các template trước đây kèm sẵn `JWT_SECRET=change-me-in-production`, `dev_secret_key` và một mật khẩu admin cố định. Mọi dự án sinh từ đó dùng chung một khoá ký. Ai biết khoá đó đều ký được token mà CMS chấp nhận.

### Các mặc định khác theo template

| Template | Mặc định |
| --- | --- |
| `nextjs` | `docker-compose.yml` đọc `JWT_SECRET` và `ENCRYPTION_KEY` dưới dạng `${VAR:?…}`, nên compose từ chối khởi động khi thiếu thay vì dùng một giá trị ai cũng biết. CORS là một origin chính xác (`LUMIBASE_PUBLIC_ORIGIN`). `LUMIBASE_API_RATE_LIMIT` và `LUMIBASE_DB_RLS` được đặt tường minh, kèm hướng dẫn. Mọi cổng đều bind vào `127.0.0.1`. Cookie refresh giữ mặc định của CMS (HttpOnly, Secure, SameSite=Lax). |
| `default` | Hono `secureHeaders` với CSP chặt, allowlist CORS theo origin chính xác và từ chối `*`, giới hạn tần suất theo IP (`LUMIBASE_API_RATE_LIMIT`), và bước kiểm tra lúc khởi động báo lỗi khi `JWT_SECRET` ngắn hơn 32 ký tự. Postgres và Redis bind vào `127.0.0.1`. |
| `cloudflare` | Không có secret trong `[vars]` của `wrangler.toml`: dùng `.dev.vars` khi chạy cục bộ và `wrangler secret put` trên production. Template cũng kèm header CSP, allowlist CORS theo origin chính xác và bước kiểm tra `JWT_SECRET` theo kiểu fail-closed. |

## `lumibase doctor --security`

```bash
npx lumibase doctor --security               # rules for the current environment
npx lumibase doctor --security --production  # force the production checklist
npx lumibase doctor --security --json        # machine-readable report
npx lumibase doctor --security --env-file deploy/prod.env
```

Lệnh này đọc đúng cấu hình mà CMS sẽ chạy cùng. Nó không thực thi gì và không gọi tới server nào. Các nguồn, độ ưu tiên từ thấp đến cao:

1. file dotenv: `.env`, `.env.local`, `.dev.vars`, hoặc các file chỉ định qua `--env-file` (phân tách bằng dấu phẩy)
2. biến môi trường của tiến trình, chỉ lấy các tên liên quan tới LumiBase
3. `[vars]` trong `wrangler.toml`, đồng thời chọn runtime Cloudflare
4. các mục `environment:` trong `docker-compose.yml` / `compose.yaml`. `${VAR}`, `${VAR:-default}` và `${VAR:?error}` được resolve theo nguồn 1 và 2, giống cách Compose làm.

Quy tắc production được áp dụng khi `NODE_ENV` hoặc `LUMIBASE_ENV` là `production`, hoặc khi truyền `--production`. Lệnh thoát với mã `1` nếu có bất kỳ phát hiện critical nào, ngược lại là `0`. Báo cáo không bao giờ chứa giá trị secret, chỉ có tên khoá và nguồn. Phần cài đặt nằm ở `packages/cli/src/security/checks.ts`.

### Quy tắc

| Rule id | Mức độ (dev / production) | Kiểm tra gì |
| --- | --- | --- |
| `jwt-secret-missing` | critical / critical | chưa đặt `JWT_SECRET` |
| `jwt-secret-weak` | critical / critical | `JWT_SECRET` là giá trị mặc định đã công khai (`dev_secret_key`, `change-me-in-production`, …) |
| `jwt-secret-short` | warning / critical | `JWT_SECRET` ngắn hơn 32 ký tự |
| `encryption-key-missing` | warning / critical | không có `ENCRYPTION_KEY` (hoặc `ENCRYPTION_KEY_<id>`) |
| `encryption-key-weak` / `encryption-key-format` | critical / critical | giá trị mặc định đã biết, hoặc không phải base64 của khoá AES 16/24/32 byte |
| `dev-auth-enabled` | warning / critical | `LUMIBASE_DEV_AUTH=true` (chấp nhận token `dev:` giả mạo) |
| `dev-credential` | warning / critical | `S3_ACCESS_KEY`, `S3_SECRET_KEY` hoặc `MEILISEARCH_API_KEY` là giá trị mặc định cho dev |
| `cors-wildcard` | critical / critical | có `*` trong `CORS_ALLOWED_ORIGINS` (response có kèm credential) |
| `cors-unset` | info / critical | không có `CORS_ALLOWED_ORIGINS` |
| `cors-insecure-origin` | — / warning | origin `http://` hoặc loopback trên production |
| `cookie-insecure` | info / critical | `REFRESH_COOKIE_SECURE=false` |
| `cookie-samesite-none` / `cookie-samesite-invalid` | info / warning; warning | `REFRESH_COOKIE_SAMESITE` là `None`, hoặc một giá trị không hợp lệ |
| `setup-token-off` | info / warning | `LUMIBASE_REQUIRE_SETUP_TOKEN` chưa bật (chỉ Node/Docker) |
| `rls-invalid` | critical / critical | `LUMIBASE_DB_RLS` không phải `off` hay `enforce` (CMS fail-closed) |
| `rls-no-system-url` | critical / critical | `enforce` mà không có `DATABASE_SYSTEM_URL` (lỗi khi khởi động) |
| `rls-off` | info / warning | chưa enforce RLS (chỉ Node/Docker) |
| `rate-limit-invalid` / `rate-limit-disabled` | warning / warning | `LUMIBASE_API_RATE_LIMIT` không phải số nguyên, hoặc bằng `0` |
| `rate-limit-fail-open` | — / info | `LUMIBASE_RATE_LIMIT_FAIL_CLOSED` không phải `true` |
| `redis-unset` | info / critical | không có `REDIS_URL` (Node/Docker; bắt buộc trên production) |
| `database-url-missing` / `database-tls` | — / critical | thiếu `DATABASE_URL`, hoặc không có `sslmode=require\|verify-ca\|verify-full` (trừ khi `DATABASE_SSL_MODE=disable`) |
| `admin-password-default` | critical / critical | `LUMIBASE_ADMIN_PASSWORD` / `ADMIN_PASSWORD` là mật khẩu mặc định đã công khai |
| `admin-password-weak` | warning / warning | mật khẩu admin không đạt chính sách 12+ ký tự, đủ bốn loại ký tự |
| `secret-in-public-env` | critical / critical | biến `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` trông giống credential |
| `secret-committed` | warning / critical | secret được ghi thẳng trong `[vars]` của `wrangler.toml` hoặc trong file compose |

Mỗi quy tắc phản ánh đúng cách CMS xử lý biến tương ứng. Phát hiện critical là những trường hợp `validateProductionConfig` hoặc `assertDbRlsStartup` từ chối khởi động, và những cấu hình trao credential cho kẻ tấn công. Đầu file `checks.ts` liệt kê các file nguồn, để có thể kiểm lại quy tắc khi CMS thay đổi.

### Tiêu chí nghiệm thu

Bản scaffold mới của mọi template đều qua `doctor --security` với không phát hiện critical nào. `packages/cli/src/security/scaffold-acceptance.test.ts` dùng scaffolder thật để tạo từng template vào một thư mục tạm, rồi chạy lệnh thật trên đó. Với `--production`, cùng bản scaffold đó vẫn liệt kê những điểm mà stack cục bộ không đáp ứng được, như TLS cho database, origin `http://localhost` và cổng setup-token. Không phát hiện nào liên quan đến secret.

## Tài liệu liên quan

- [CLI](../cli/index.md)
- [Cơ chế chống lạm dụng](./anti-abuse.md)
- [Checklist triển khai](../DEPLOYMENT-CHECKLIST.md)
