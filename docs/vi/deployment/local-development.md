# Phát triển Local

Cài dependencies từ root repo:

```bash
pnpm install
```

## CMS Worker

```bash
pnpm --filter @lumibase/cms dev
```

API local mặc định chạy ở port `8787`. Chỉ dùng `LUMIBASE_DEV_AUTH="true"` khi phát triển local.

## Site tài liệu

```bash
pnpm --filter @lumibase/docs dev
pnpm --filter @lumibase/docs build
```

## Kiểm tra trước deploy

```bash
pnpm --filter @lumibase/docs build
pnpm --filter @lumibase/cms build
pnpm --filter @lumibase/cms test
```
