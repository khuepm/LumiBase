# Publish npm packages

LumiBase publish các package công khai trong cùng pipeline release (`.github/workflows/release.yml`, job `publish-npm-packages`). Không còn workflow `publish-npm.yml` hay script `scripts/publish-npm.mjs` riêng — toàn bộ việc publish đã được hợp nhất về một nơi để tránh double-publish.

## Package nào được publish

Job `publish-npm-packages` build và publish **mọi package trong `packages/*` có `private !== true`**. Hiện tại gồm:

- `packages/sdk` (`@lumibase/sdk`)
- `packages/extension-sdk` (`@lumibase/extension-sdk`)
- `packages/mcp-server` (`@lumibase/mcp-server`, có `bin` `lumibase-mcp`)
- `packages/create-lumibase` (`create-lumibase`)

### Thêm một package public mới

1. Bỏ `"private": true` khỏi `package.json` của package.
2. Đặt `"publishConfig": { "access": "public" }` (và map `main`/`module`/`types`/`exports` sang `dist/` nếu nguồn trỏ vào `./src`).
3. Thêm field `repository` trỏ đúng repo build — **bắt buộc cho provenance**:
   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/khuepm/lumibase.git",
     "directory": "packages/<ten-package>"
   }
   ```
4. Bảo đảm package **không** phụ thuộc dependency nội bộ dùng `workspace:*` chưa publish.

## Điều kiện chạy

Job chỉ chạy khi cả hai điều kiện sau thỏa mãn:

- Repository variable `PUBLISH_NPM_PACKAGES` = `true`.
- Secret `NPM_TOKEN` được cấu hình (nếu thiếu, job chạy nhưng bỏ qua bước publish và in notice).

## Version fixed từ root

Mọi package dùng version cố định theo `package.json` ở root. Trước khi release, job `verify` chạy `pnpm version:check` để chắc chắn mọi manifest đã đồng bộ, và validate tag `vX.Y.Z` khớp root version `X.Y.Z`.

## Trigger release

Publish chạy khi push tag SemVer dạng `v*.*.*`:

```sh
git tag -a v0.10.0 -m "LumiBase v0.10.0"
git push origin v0.10.0
```

Tag này kích hoạt toàn bộ pipeline: `verify` → tạo GitHub Release → deploy Cloudflare Worker `production` → `publish-npm-packages` → build & push Docker image.

## Provenance

Lệnh publish chạy `pnpm publish --access public --no-git-checks --provenance` từ thư mục của từng package. Job có quyền `id-token: write`, nên npm có thể sinh provenance statement gắn package với commit/workflow nguồn. Provenance yêu cầu field `repository.url` trong manifest khớp repo đang build (`github.com/khuepm/lumibase`); nếu lệch, npm sẽ báo lỗi.

> Lưu ý: `pnpm --dir <path> publish` bị lỗi trên pnpm 9.x — job chạy `pnpm publish` từ `cwd` của package thay vì truyền `--dir`.

## Release notes

GitHub Release được tạo bởi job `github-release` từ section `## [X.Y.Z]` trong `CHANGELOG.md`. Hãy ghi rõ package/version sẽ publish trong changelog của bản phát hành, ví dụ:

```md
- @lumibase/sdk@0.10.0, @lumibase/extension-sdk@0.10.0, @lumibase/mcp-server@0.10.0, create-lumibase@0.10.0 — published to the public npm registry.
```
