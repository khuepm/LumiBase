---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:40.851Z
translatedFrom: en
sourceHash: d879ebbc6005e4ba
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T01:59:40.851Z
codeVerifiedHash: d879ebbc6005e4ba
codeVerifiedClaims: 2
---

# Security advisory

LumiBase công bố mọi lỗ hổng đã xác nhận trong một phiên bản đã phát hành dưới
dạng **GitHub Security Advisory (GHSA)** ngay trong repository của mình. Trang này
cho biết tìm chúng ở đâu, cách theo dõi, và nên poll những nguồn máy đọc được
nào. Báo cáo trở thành advisory ra sao được mô tả trong
[chính sách công bố lỗ hổng](./vulnerability-disclosure.md).

## Advisory được công bố ở đâu

| Nguồn | Nội dung |
|-------|----------|
| <https://github.com/khuepm/lumibase/security/advisories> | Danh sách gốc: mọi advisory LumiBase đã công bố, với phiên bản bị ảnh hưởng và đã vá, vector CVSS, CWE, CVE ID và ghi công. |
| `CHANGELOG.md`, mục `### Security` dưới mỗi bản release | Mỗi bản sửa một dòng, có liên kết tới advisory. Cũng liệt kê các thay đổi tăng cường bảo mật không cần advisory. |
| Release notes trên GitHub của tag đã sửa | Cùng các dòng đó, gắn vào bản release do `.github/workflows/release.yml` build. |
| [GitHub Advisory Database](https://github.com/advisories) | Advisory cho các package npm (`lumibase`, `create-lumibase`, `@lumibase/sdk`, `@lumibase/contracts`, `@lumibase/mcp-server`, `@lumibase/extension-sdk`), sau khi GitHub review. Đây là nguồn mà cảnh báo Dependabot và `npm audit` đọc. |
| [cve.org](https://www.cve.org/) và NVD | Bản ghi CVE, cho các advisory đã được cấp CVE ID. |

CMS server, Docker image của nó (`ghcr.io/khuepm/lumibase-cms`), Studio và shell
desktop/mobile không phải package npm, nên advisory của chúng xuất hiện trong
danh sách của repository và trên cve.org nhưng không tạo cảnh báo Dependabot.
Người vận hành các thành phần này nên theo dõi repository như mô tả dưới đây.

## Theo dõi

- **Watch repository:** trên GitHub, **Watch** → **Custom** → chọn
  **Security alerts**, hoặc **Releases** để nhận mọi bản release. Bản sửa bảo mật
  luôn ra trong một bản release.
- **Dependabot:** dự án phụ thuộc các package npm tự động nhận cảnh báo và pull
  request cập nhật khi advisory đã vào GitHub Advisory Database.
- **Polling:** dùng các endpoint API dưới đây từ hệ thống giám sát của bạn.

## Feed máy đọc được

Repository này không có file feed riêng; GitHub API chính là feed, nên nó không
bao giờ lệch với các advisory đã công bố.

Mọi advisory đã công bố của repository, mới nhất trước (advisory đã công bố
không cần xác thực):

```bash
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/khuepm/lumibase/security-advisories?state=published&sort=published&direction=desc"
```

Mỗi phần tử có `ghsa_id`, `cve_id`, `summary`, `severity`, `cvss`, `cwes`,
`vulnerabilities` (package, khoảng phiên bản bị ảnh hưởng và đã vá),
`published_at` và `html_url`.

Advisory đã review cho một package npm, từ GitHub Advisory Database toàn cục:

```bash
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/advisories?ecosystem=npm&affects=@lumibase/sdk"
```

Cùng các advisory npm đó được đồng bộ sang [OSV](https://osv.dev/), nên các
scanner dựa trên OSV cũng nhận được:

```bash
curl -s -d '{"package":{"ecosystem":"npm","name":"@lumibase/sdk"}}' \
  "https://api.osv.dev/v1/query"
```

## Advisory đã công bố

| Advisory | CVE | Mức độ | Bị ảnh hưởng | Đã vá | Công bố |
|----------|-----|--------|--------------|-------|---------|
| _Chưa có._ | — | — | — | — | — |

Maintainer thêm một dòng vào đây trong cùng pull request công bố advisory (xem
[runbook §9](./advisory-runbook.md#9-sau-khi-công-bố)). Nếu hai nơi lệch nhau,
danh sách trên GitHub ở trên là chuẩn.

## Đọc một advisory

Mỗi advisory theo [mẫu advisory](./advisory-template.md): tóm tắt, phiên bản bị
ảnh hưởng và đã vá, mức độ kèm vector CVSS, tác động, bản sửa, cách giảm thiểu cho
người vận hành chưa nâng cấp ngay được, và ghi công. Hãy nâng cấp lên phiên bản đã
vá ghi cho major của bạn; bảng
[phiên bản được hỗ trợ](./vulnerability-disclosure.md#2-phiên-bản-được-hỗ-trợ)
cho biết major nào còn được sửa lỗi.
