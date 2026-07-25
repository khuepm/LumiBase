# Publish npm packages

LumiBase giữ toàn bộ package trong source control ở trạng thái `private: true` cho đến khi dự án sẵn sàng public. Quy trình publish npm chỉ mở package trong bản copy tạm thời của workflow release; manifest trong repository vẫn private để tránh publish nhầm trong giai đoạn chưa public.

## Allowlist package public

Không có file allowlist riêng. Job `publish-npm-packages` trong
`.github/workflows/release.yml` quét `packages/*/package.json` và chỉ publish những
package **không** có `private: true`. Nói cách khác, cờ `private` trong `package.json`
của chính package đó *là* allowlist:

- `packages/sdk` (`@lumibase/sdk`)
- `packages/extension-sdk` (`@lumibase/extension-sdk`)

Muốn thêm package public: bỏ `private: true` khỏi `package.json` của package đó, và
bảo đảm nó không phụ thuộc vào dependency nội bộ dùng `workspace:*` chưa public.

## Version fixed từ root

Các package public dùng version fixed theo `package.json` ở root. Trước khi publish, workflow chạy `pnpm version:check` và script publish cũng kiểm tra tag release `vX.Y.Z` phải khớp với root version `X.Y.Z`.

## Trigger release

Publish npm chạy khi push tag SemVer dạng `v*.*.*`. Ví dụ:

```sh
git tag v0.4.3
git push origin v0.4.3
```

Workflow dùng npm trusted publishing/OIDC qua quyền `id-token: write` và `actions/setup-node` với registry npm. Không cấu hình npm token dài hạn trừ khi npm registry không hỗ trợ trusted publishing cho package đó.

## Provenance

Lệnh publish bật `--provenance` để npm ghi provenance statement khi registry hỗ trợ. Nếu registry không hỗ trợ provenance/OIDC, release phải được xử lý như lỗi cấu hình registry thay vì chuyển sang token dài hạn mặc định.

## Release notes

Sau khi publish thành công, workflow tạo hoặc cập nhật GitHub Release tương ứng với tag và chèn section `npm packages published`. Section này phải ghi rõ package/version đã publish, ví dụ:

```md
## npm packages published
- @lumibase/sdk@0.4.3 (packages/sdk)
- @lumibase/extension-sdk@0.4.3 (packages/extension-sdk)
```
