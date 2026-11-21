---
version: 2
lastUpdated: 2026-11-19T20:13:26.504Z
sourceLang: en
translatedFrom: en
sourceHash: 5cf4663bdf7f640c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T20:13:26.504Z
codeVerifiedHash: 5cf4663bdf7f640c
codeVerifiedClaims: 4
---

# Cloudflare Deployment

Hướng dẫn này bao gồm việc triển khai Cloudflare được monorepo sử dụng: CMS API chạy như một Worker và ứng dụng tài liệu được triển khai như một static site trên Cloudflare Pages.

## Prerequisites

- Node.js 22 trở lên.
- `pnpm` khớp với trường `packageManager` ở gốc.
- Wrangler đã xác thực với tài khoản có quyền ghi Workers, Pages, KV, R2, Hyperdrive và Durable Objects.
- Giá trị production cho PostgreSQL, Cloudflare Access và các secret JWT của CMS.

Kiểm tra đăng nhập:

```bash
pnpm exec wrangler whoami
```

## CMS Worker

Worker nằm ở `apps/cms` và sử dụng `apps/cms/wrangler.toml`.

Tạo hoặc gắn các binding production trước khi triển khai:

```bash
pnpm exec wrangler hyperdrive create lumibase-hyperdrive \
  --connection-string="postgres://user:pass@host:5432/lumibase"

pnpm exec wrangler kv namespace create CONFIG_CACHE
pnpm exec wrangler r2 bucket create lumibase-media
```

Cập nhật `apps/cms/wrangler.toml` với các ID được trả về. Giữ các giá trị mặc định local trong khối `[vars]` cấp cao nhất, và giữ các giá trị không nhạy cảm cùng binding cho staging/production trong các profile có tên `[env.staging]` và `[env.production]`. Không đặt các giá trị secret production trong `wrangler.toml`; hãy lưu trữ chúng dưới dạng Cloudflare secrets:

```bash
cd apps/cms
pnpm exec wrangler secret put JWT_SECRET --env production
pnpm exec wrangler secret put CF_ACCESS_CERTS_URL --env production
pnpm exec wrangler secret put CF_ACCESS_AUDIENCE --env production
```

Chạy release guard trước khi triển khai. Nó xác nhận rằng production không sử dụng dev auth, secret JWT phát triển không xuất hiện, và các secret bắt buộc tồn tại trong biến môi trường CI hoặc Cloudflare secrets:

```bash
pnpm release:check
```

Build và triển khai:

```bash
pnpm --filter @lumibase/cms build:production
pnpm --filter @lumibase/cms deploy:production
```

Sau khi triển khai, hãy xác minh:

```bash
curl -fsS https://<worker-host>/health
```

**Setup token cho lần chạy đầu.** Ở production, setup wizard đòi một token
dùng một lần (#992), để không ai tìm thấy Worker trước bạn chiếm được tài khoản
admin. Workers không có bước khởi động để sinh và in token, nên hãy tự đặt token
trước khi mở wizard, nhập nó ở màn hình đầu tiên của wizard, và xoá nó sau khi
setup xong:

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put LUMIBASE_SETUP_TOKEN --env production
# sau khi setup:
pnpm exec wrangler secret delete LUMIBASE_SETUP_TOKEN --env production
```

Thiếu nó thì `POST /api/v1/setup/complete` trả `503 SETUP_TOKEN_NOT_ISSUED`.
`LUMIBASE_REQUIRE_SETUP_TOKEN=false` tắt cổng này có chủ đích.

## Documentation Site

Docs viewer đọc markdown từ thư mục `docs/` ở gốc và build ra `apps/docs/dist`.

```bash
pnpm --filter @lumibase/docs build
pnpm docs:deploy
```

Script deploy ở gốc chạy:

```bash
wrangler pages deploy apps/docs/dist --project-name lumibase-docs
```

## Production Notes

- Không triển khai production với `LUMIBASE_DEV_AUTH="true"` hoặc `JWT_SECRET` phát triển; `pnpm release:check` sẽ chặn các giá trị này trước `wrangler deploy`.
- Giữ các migration của Durable Object trong các mục `[[migrations]]` cấp cao nhất trong `wrangler.toml`.
- Chạy các migration của database trước khi công khai bản build API mới nếu mã phụ thuộc vào các thay đổi schema.
- Giữ việc triển khai docs và Worker riêng biệt để các thay đổi chỉ liên quan đến tài liệu không buộc phải triển khai lại API.
