# Triển khai Cloudflare

Lumibase dùng hai target Cloudflare chính: CMS API chạy trên Workers và site tài liệu chạy trên Cloudflare Pages.

## Điều kiện trước khi deploy

- Node.js 20 trở lên.
- Cài dependencies bằng `pnpm install`.
- Wrangler đã đăng nhập với quyền ghi Workers, Pages, KV, R2, Hyperdrive và Durable Objects.
- Đã chuẩn bị secret production cho PostgreSQL, Cloudflare Access và JWT.

Kiểm tra đăng nhập:

```bash
pnpm exec wrangler whoami
```

## CMS Worker

CMS Worker nằm ở `apps/cms` và dùng cấu hình `apps/cms/wrangler.toml`.

Tạo binding hạ tầng trước khi deploy:

```bash
pnpm exec wrangler hyperdrive create lumibase-hyperdrive \
  --connection-string="postgres://user:pass@host:5432/lumibase"

pnpm exec wrangler kv namespace create CONFIG_CACHE
pnpm exec wrangler r2 bucket create lumibase-media
```

Cập nhật ID trả về vào `wrangler.toml`. Giữ default local/dev trong top-level `[vars]`, còn giá trị không nhạy cảm cho staging/production nằm trong `[env.staging.vars]` và `[env.production.vars]`. Không hardcode production secret trong `wrangler.toml`; hãy lưu bằng Cloudflare secrets:

```bash
cd apps/cms
pnpm exec wrangler secret put JWT_SECRET --env production
pnpm exec wrangler secret put CF_ACCESS_CERTS_URL --env production
pnpm exec wrangler secret put CF_ACCESS_AUDIENCE --env production
```

Chạy guard release trước khi deploy. Script kiểm tra production không bật dev auth, không dùng JWT secret mặc định và các required secret đã tồn tại qua CI environment variables hoặc Cloudflare secrets:

```bash
pnpm release:check
```

Build dry-run và deploy:

```bash
pnpm --filter @lumibase/cms build
pnpm --filter @lumibase/cms deploy:production
```

## Site tài liệu

Docs viewer build ra `apps/docs/dist` và deploy lên Pages project `lumibase-docs`:

```bash
pnpm --filter @lumibase/docs build
pnpm docs:deploy
```

## Lưu ý production

- Không deploy production với `LUMIBASE_DEV_AUTH="true"` hoặc `JWT_SECRET` mặc định; `pnpm release:check` sẽ chặn trước bước `wrangler deploy`.
- Durable Object migration phải nằm ở top-level `[[migrations]]` trong `wrangler.toml`.
- Nếu code phụ thuộc schema mới, chạy database migration trước khi mở traffic production.
