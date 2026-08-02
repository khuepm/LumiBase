---
version: 1
lastUpdated: 2026-07-28T10:20:14.923Z
sourceLang: en
translatedFrom: en
sourceHash: 574553a580a51075
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:20:14.923Z
codeVerifiedHash: 574553a580a51075
codeVerifiedClaims: 4
---

# Thiết lập deploy Cloudflare Pages qua CI

Các workflow `pages-deploy.yml` (cùng `deploy-cms.yml`, `release.yml`) deploy lên
Cloudflare ở mỗi tag `vX.Y.Z`. Chúng **bỏ qua bước deploy trong im lặng** khi
thiếu secret cần thiết:

```
##[notice] Skipping Cloudflare Pages deployment because
CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not configured.
```

Job vẫn báo **success** (các bước deploy được bọc bởi `if: can_deploy == true`),
nên một dấu check xanh **không** chứng minh là đã deploy. Đây chính là nguyên
nhân bản release v0.4.7 trông như đã deploy trong khi production vẫn giữ build cũ.

## Các GitHub repository secret cần có

| Secret | Giá trị |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `792c8e28da56d9568474df5fcf00cfc7` |
| `CLOUDFLARE_API_TOKEN` | Một API token có scope (tạo ở dưới) |

## 1. Tạo Cloudflare API token

Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**.

Các permission cần thiết (bao gồm cả Pages + deploy CMS Worker):

| Type | Resource | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |
| Account | Workers Scripts | Edit |
| Account | Workers KV Storage | Edit |
| User | Memberships | Read |

Account Resources: chọn account sở hữu `lumibase.dev` / `docs.lumibase.dev`
(account id `792c8e28…`).

Copy token vừa sinh ra (chỉ hiện một lần).

## 2. Thêm secret vào GitHub

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --body "792c8e28da56d9568474df5fcf00cfc7"
gh secret set CLOUDFLARE_API_TOKEN  # dán token khi được hỏi
```

Hoặc qua GitHub UI: **Settings → Secrets and variables → Actions → New repository secret**.

## 3. Chạy lại một lần deploy

Hoặc push một tag mới, hoặc chạy lại workflow có sẵn với tag đó:

```bash
gh workflow run pages-deploy.yml -f tag=v0.4.7
```

## 4. Verify production (không phải preview URL)

Workflow hiện đang verify URL deployment `*.pages.dev`, URL này luôn phản hồi kể
cả với preview deployment. Hãy luôn xác nhận trên **custom domain**:

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  "https://docs.lumibase.dev/en/docs/data-model/?cb=$(date +%s)"   # mong đợi 200 ~200000
curl -s -o /dev/null -w "%{http_code}\n" "https://lumibase.dev/llms.txt?cb=$(date +%s)"  # mong đợi 200
```

## Phương án thủ công (không dùng CI)

Với `wrangler` cục bộ đã đăng nhập vào account sở hữu:

```bash
# docs (output SSG ở dist/)
pnpm docs:build
cd apps/docs && npx wrangler pages deploy dist --project-name lumibase-docs --branch main

# landing (static export ở out/)
pnpm landing:build
npx wrangler pages deploy apps/landing/out --project-name lumibase-landing --branch main
```

`--branch main` là bắt buộc — `main` là production branch của cả hai project. Bỏ
nó đi sẽ tạo ra một preview deployment không cập nhật custom domain.

## Đề xuất làm chặt workflow (tương lai)

- Làm cho bước deploy **fail rõ ràng** khi thiếu secret, thay vì bỏ qua trong im
  lặng (bỏ guard `can_deploy`, hoặc cho job fail kèm thông báo rõ).
- Đổi bước verify để curl **custom domain**, không phải URL `pages.dev`.
