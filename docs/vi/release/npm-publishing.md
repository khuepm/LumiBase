---
version: 1
lastUpdated: 2026-08-01T23:45:00.000Z
sourceLang: vi
contentHash: track0-public-funnel
codeVerified: 2026-08-01T23:45:00.000Z
codeVerifiedHash: track0-public-funnel
codeVerifiedClaims: 1
---

# Publish npm packages

LumiBase giữ contract/source của package trong monorepo; job publish npm chỉ đẩy những package **không** có `private: true`. Cờ `private` trong `package.json` của chính package đó *là* allowlist.

## Allowlist package public

Không có file allowlist riêng. Job `publish-npm-packages` trong
`.github/workflows/release.yml` quét `packages/*/package.json` và chỉ publish những
package **không** có `private: true`:

- `packages/create-lumibase` (`create-lumibase`)
- `packages/sdk` (`@lumibase/sdk`)
- `packages/extension-sdk` (`@lumibase/extension-sdk`)
- `packages/mcp-server` (`@lumibase/mcp-server`)
- `packages/contracts` (`@lumibase/contracts`)

Muốn thêm package public: bỏ `private: true` khỏi `package.json` của package đó, thêm
`publishConfig.access: public` + script `build` ra `dist/`, và bảo đảm nó không phụ
thuộc vào dependency nội bộ dùng `workspace:*` chưa public.

Mỗi package public nên có `README.md`, `homepage`, `bugs`, và `keywords` — trang npm
là phễu discovery; manifest trống làm giảm lượt cài.

## Version fixed từ root

Các package public dùng version fixed theo `package.json` ở root. Trước khi publish, workflow chạy `pnpm version:check` và script publish cũng kiểm tra tag release `vX.Y.Z` phải khớp với root version `X.Y.Z`.

## Trigger release

Publish npm chạy khi push tag SemVer dạng `v*.*.*`. Ví dụ:

```sh
git tag v0.4.3
git push origin v0.4.3
```

Workflow dùng npm trusted publishing/OIDC qua quyền `id-token: write` và `actions/setup-node` với registry npm. Job cũng hỗ trợ `NPM_TOKEN` khi biến `PUBLISH_NPM_PACKAGES` bật. Không cấu hình npm token dài hạn trừ khi npm registry không hỗ trợ trusted publishing cho package đó.

## Provenance

Lệnh publish bật `--provenance` để npm ghi provenance statement khi registry hỗ trợ. Nếu registry không hỗ trợ provenance/OIDC, release phải được xử lý như lỗi cấu hình registry thay vì chuyển sang token dài hạn mặc định.

## Release notes

Sau khi publish thành công, workflow tạo hoặc cập nhật GitHub Release tương ứng với tag và chèn section `npm packages published`. Section này phải ghi rõ package/version đã publish, ví dụ:

```md
## npm packages published
- create-lumibase@0.24.1 (packages/create-lumibase)
- @lumibase/sdk@0.24.1 (packages/sdk)
- @lumibase/extension-sdk@0.24.1 (packages/extension-sdk)
- @lumibase/mcp-server@0.24.1 (packages/mcp-server)
- @lumibase/contracts@0.24.1 (packages/contracts)
```
