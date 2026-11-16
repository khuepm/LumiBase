---
sourceLang: en
version: 2
lastUpdated: 2026-11-12T18:23:47.335Z
translatedFrom: en
sourceHash: 337314e0f842957a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-12T18:23:47.335Z
codeVerifiedHash: 337314e0f842957a
codeVerifiedClaims: 22
---

# Deploy một cú nhấp

Các template đưa một tài khoản mới trên Render, Railway hoặc Fly.io tới setup
wizard của LumiBase: CMS API **và** Studio, phục vụ từ một container trên cùng một
origin, có sẵn PostgreSQL và Redis, và secret được sinh giúp bạn.

| Nền tảng | Bạn nhấp hoặc gõ gì | Bước thủ công còn lại |
|----------|---------------------|-----------------------|
| Render | Nút **Deploy to Render** (`render.yaml`) | Không có bước nào trước wizard. |
| Railway | Template LumiBase, khi đã được publish (`railway.json`, `docker/railway-template-variables.json`) | Không có bước nào trước wizard. Bản thân template là bước một lần của maintainer — xem [Railway](#railway). |
| Fly.io | `fly launch` với `fly.toml` | Tạo Postgres và Redis, đặt hai secret — bốn lệnh. Fly không sinh secret. |
| Cloudflare | Không có nút | Hiện chưa một cú nhấp được — xem [Cloudflare](#cloudflare). |

Render, Fly.io và template Railway chạy image đã publish
`ghcr.io/khuepm/lumibase-cms` (xem [Image đã hardening](./docker.md#image-đã-hardening)),
nên thứ chúng deploy là bản release đã ký và đã scan, không phải bản build từ bản
sao repository của bạn. `railway.json` là ngoại lệ: service Railway tạo từ
repository **build `docker/Dockerfile` từ source** — xem [Railway](#railway) để
biết bản build đó thiếu gì.

Các template cần image từ bản release đầu tiên sau `2.0.0`: chúng dựa vào việc
entrypoint suy ra `CORS_ALLOWED_ORIGINS`, điều mà `2.0.0` (`latest` hiện nay)
không làm, nên cho tới khi bản release đó được publish, một lần deploy sẽ dừng ở
bước kiểm tra production với `CORS_ALLOWED_ORIGINS is required in production`.

## Mọi template thiết lập những gì

| Biến | Được cung cấp thế nào |
|------|-----------------------|
| `JWT_SECRET`, `ENCRYPTION_KEY` | Do nền tảng sinh (Render, Railway) hoặc do bạn sinh bằng `openssl` (Fly). Không bao giờ lưu trong repository. `ENCRYPTION_KEY` đến server đúng như khi được sinh; entrypoint không bao giờ mã hóa lại nó. |
| `DATABASE_URL`, `REDIS_URL` | Nối từ PostgreSQL và Redis của nền tảng. |
| `CORS_ALLOWED_ORIGINS` | Không template nào đặt nó. Khi chưa đặt, được suy ra lúc khởi động từ URL công khai của nền tảng (`RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN`, `FLY_APP_NAME`). Một giá trị không có host, như `https://`, được coi là chưa đặt. |
| `LUMIBASE_REQUIRE_SETUP_TOKEN` | `true`: instance đã lên internet trước khi có ai setup, và không có token thì ai tới `/setup` trước sẽ thành admin. |
| `DATABASE_SSL_MODE` | `disable`, vì mỗi template kết nối qua mạng private của chính nền tảng. Đặt thành `require` khi dùng database bên ngoài. |
| `NODE_ENV`, `LUMIBASE_ENV`, `LUMIBASE_RUNTIME`, `PORT` | `production`, `production`, `docker`, `1989`. |

Production từ chối khởi động nếu thiếu `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`ENCRYPTION_KEY` và `CORS_ALLOWED_ORIGINS`, và từ chối một `ENCRYPTION_KEY`
không phải base64 chuẩn, có padding, của một key 128, 192 hoặc 256 bit. Entrypoint
của image (`docker/scripts/entrypoint.mjs`) áp dụng cùng các kiểm tra đó trước khi
chạm tới database và thoát kèm tên biến.

**Không được cấp phát** bởi template nào: storage media tương thích S3,
Meilisearch và imgproxy. Instance vẫn khởi động và setup vẫn hoàn tất khi thiếu
chúng — `/health` báo `degraded` cho tới khi có — nhưng upload, search và biến đổi
ảnh cần các biến của chúng (`S3_ENDPOINT`, `MEILISEARCH_HOST`, `IMGPROXY_URL`, …),
xem [Biến môi trường](./environment-variables.md).

## Sau khi deploy: setup wizard

1. Mở log của service. Khi server đã trả lời, entrypoint in ra URL:

   ```text
   [entrypoint] Setup is pending. Open https://<your-app>/setup to create the first admin account.
   ```

2. Copy token dùng một lần được in trước đó trong cùng log:

   ```text
   [lumibase-cms] SETUP_TOKEN=<token>
   ```

3. Mở `/setup`, dán token, và tạo admin đầu tiên. Sau đó Studio nằm dưới admin
   path bạn chọn ở đó.

Token chỉ được in một lần. Nếu dòng log đã mất, xem
[Setup lần đầu](./environment-variables.md#setup-lần-đầu) để biết cách cấp
token mới.

## Render

> **Nâng cấp không người giám sát.** `render.yaml` deploy `:latest` và image chạy
> migration mỗi lần khởi động, nên bất kỳ lần restart nào sau một bản release mới
> — kể cả bản major — đều nâng cấp instance và migrate database của nó. Hãy pin
> bản sao của bạn: `url: ghcr.io/khuepm/lumibase-cms:<version>`. Xem
> [Pin một phiên bản](#pin-một-phiên-bản).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/khuepm/lumibase)

Blueprint `render.yaml` tạo một web service từ image đã publish, một database
Render Postgres 16 và một instance Render Key Value (`noeviction`, điều mà các job
queue cần), tất cả chỉ truy cập được qua mạng private của Render.
`JWT_SECRET` và `ENCRYPTION_KEY` dùng `generateValue`, mà Render mô tả là một giá
trị 256 bit mã hóa base64. Nếu một lần deploy dừng với `ENCRYPTION_KEY must be a
base64-encoded 128, 192, or 256-bit AES key`, thì chưa có gì được mã hóa: hãy thay
giá trị trong dashboard bằng output của `openssl rand -base64 32`.

Plan: web service dùng `starter` vì instance free sẽ ngủ khi rảnh, kéo theo
scheduler và các queue worker mà process này chạy. Đổi plan trong dashboard hoặc
trong bản sao `render.yaml` của bạn.

## Railway

> **Nâng cấp không người giám sát.** Hãy cho service `lumibase` của template một
> tag release, `ghcr.io/khuepm/lumibase-cms:<version>`, đừng bao giờ dùng
> `:latest`: image chạy migration mỗi lần khởi động, nên một lần restart sau bản
> release major sẽ nâng cấp instance mà không ai giám sát.

`railway.json` cấu hình một service **build từ source** bằng `docker/Dockerfile`,
với deploy check `/health`. Đó là thứ Railway dùng khi bạn tạo service từ
repository, và bản build đó không phải image release: nó không được ký hay scan
bằng Trivy, không có SBOM, và được build không có `LUMIBASE_GIT_SHA`, nên
`/api/v1/system/version` báo commit là `unknown`. Nó được build từ bất kỳ branch
nào bạn kết nối. Để chạy image đã ký, hãy tạo service từ Docker image, như template
làm. Một **template** Railway — nút bấm đồng thời tạo Postgres và Redis và
sinh secret — được soạn trong template editor của Railway và publish từ một tài
khoản Railway; nó không thể đọc từ repository. Cho tới khi được publish, một
maintainer tạo nó một lần:

1. Trong template editor, thêm các service chính thức **Postgres** và **Redis**
   và một service tên `lumibase` từ Docker image
   `ghcr.io/khuepm/lumibase-cms:<version>`, có public domain. Public domain là
   bắt buộc: `CORS_ALLOWED_ORIGINS` được suy ra từ `RAILWAY_PUBLIC_DOMAIN` và
   không phải biến của template.
2. Copy các biến từ `docker/railway-template-variables.json`. Chúng dùng các hàm
   `${{secret(…)}}` của Railway, nên mỗi lần deploy tự sinh `JWT_SECRET` và
   `ENCRYPTION_KEY` riêng (công thức tạo ra một key AES-256 base64 chuẩn, có
   padding, mà server chấp nhận nguyên trạng; test của repository kiểm tra điều
   đó).
3. Publish, rồi thêm nút của template vào đây và vào README.

Để deploy không cần template, tạo cùng ba service trong một project và đặt cùng
các biến, sinh hai secret bằng `openssl` như với Fly. Hãy tạo service `lumibase`
từ Docker image để có image release; service tạo từ repository dùng
`railway.json` và build từ source.

## Fly.io

> **Nâng cấp không người giám sát.** `fly.toml` deploy `:latest` và image chạy
> migration mỗi lần khởi động, nên một lần `fly deploy` hoặc restart machine sau
> một bản release mới — kể cả bản major — sẽ nâng cấp app và migrate database của
> nó. Hãy pin nó trong `[build]`: `image = "ghcr.io/khuepm/lumibase-cms:<version>"`.

Fly không có nút deploy, không sinh secret, và chạy Postgres và Redis như các
resource riêng. Từ một thư mục trống:

```bash
fly launch --from https://github.com/khuepm/lumibase --no-deploy
fly postgres create --name <app>-db
fly postgres attach <app>-db             # sets the DATABASE_URL secret
fly redis create                          # prints a redis:// URL
fly secrets set REDIS_URL=<that URL> \
  JWT_SECRET="$(openssl rand -base64 48)" \
  ENCRYPTION_KEY="$(openssl rand -base64 32)"
fly deploy
```

Nếu dùng Fly Managed Postgres thay thế, đặt `DATABASE_URL` từ connection string
của nó bằng `fly secrets set`, và nếu chuỗi đó có `sslmode=require` thì đặt thêm
`DATABASE_SSL_MODE=require`.

`fly.toml` giữ một machine luôn chạy (`auto_stop_machines = "off"`): machine đã
dừng thì không chạy scheduler hay worker nào. Nó dừng app bằng `SIGTERM`, tín
hiệu mà server dùng để drain; `SIGINT` mặc định của Fly sẽ kết thúc nó giữa chừng
request. Một lần deploy thiếu secret sẽ fail ngay, nêu tên chúng, trước khi
database bị chạm tới. `CORS_ALLOWED_ORIGINS` mặc định là `https://<app>.fly.dev`;
hãy đặt nó, hoặc `LUMIBASE_PUBLIC_URL`, khi bạn thêm domain riêng.

## Cloudflare

Hiện chưa có nút Deploy to Cloudflare cho LumiBase, và thêm một nút vào
repository này sẽ không chạy được:

- Nút bấm deploy một Worker từ một thư mục, và coi thư mục đó là gốc của
  repository mới. `apps/cms` phụ thuộc các package workspace sẽ không có ở đó.
- CMS cần PostgreSQL qua Hyperdrive. Một cấu hình Hyperdrive trỏ tới một database
  đã tồn tại, nên bản thân database không thể đến từ nút bấm.
- Cấu hình cấp cao nhất trong `apps/cms/wrangler.toml` là profile phát triển local
  (`LUMIBASE_DEV_AUTH = "true"`). Deploy nguyên trạng sẽ publish một instance dùng
  xác thực phát triển.
- Ở target này Studio là một project Cloudflare Pages riêng, và nút bấm chỉ deploy
  Workers.

Hãy dùng đường có script trong [Cloudflare Workers](./cloudflare.md). Một template
Worker tự chứa mà nút bấm deploy được được theo dõi ở backlog B211.

## Pin một phiên bản

Render và Fly trỏ tới `latest`, tag luôn theo bản release mới nhất, và image chạy
các migration đang chờ mỗi khi khởi động: một lần restart của nền tảng sau một bản
release là một lần nâng cấp không ai lên lịch, và sau một bản release major thì có
thể cần các bước thủ công trong upgrade notes của nó. Mặc định vẫn là `latest` vì
các template chỉ chạy với image có entrypoint hiện tại, và chưa tag release nào đã
publish có nó (xem ghi chú ở đầu trang).

Cho production, hãy pin bản release bạn đã kiểm thử — dòng cần đổi là
`url: ghcr.io/khuepm/lumibase-cms:<version>` trong `render.yaml`,
`image = "ghcr.io/khuepm/lumibase-cms:<version>"` trong `fly.toml`, hoặc image
của service Railway — và đổi nó có chủ đích, sau khi đọc upgrade notes của bản
release đó; xem [Docker → Cập nhật](./docker.md#cập-nhật).
