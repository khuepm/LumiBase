---
sourceLang: en
version: 1
lastUpdated: 2026-11-11T03:00:29.184Z
translatedFrom: en
sourceHash: 10186016e0521871
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-11T03:00:29.184Z
codeVerifiedHash: 10186016e0521871
codeVerifiedClaims: 20
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

Cả ba nền tảng container đều chạy image đã publish `ghcr.io/khuepm/lumibase-cms`
(xem [Image đã hardening](./docker.md#image-đã-hardening)), nên thứ bạn deploy là
bản release đã ký và đã scan, không phải bản build từ bản sao repository của bạn.

## Mọi template thiết lập những gì

| Biến | Được cung cấp thế nào |
|------|-----------------------|
| `JWT_SECRET`, `ENCRYPTION_KEY` | Do nền tảng sinh (Render, Railway) hoặc do bạn sinh bằng `openssl` (Fly). Không bao giờ lưu trong repository. |
| `DATABASE_URL`, `REDIS_URL` | Nối từ PostgreSQL và Redis của nền tảng. |
| `CORS_ALLOWED_ORIGINS` | Khi chưa đặt, được suy ra lúc khởi động từ URL công khai của nền tảng (`RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN`, `FLY_APP_NAME`). |
| `LUMIBASE_REQUIRE_SETUP_TOKEN` | `true`: instance đã lên internet trước khi có ai setup, và không có token thì ai tới `/setup` trước sẽ thành admin. |
| `DATABASE_SSL_MODE` | `disable`, vì mỗi template kết nối qua mạng private của chính nền tảng. Đặt thành `require` khi dùng database bên ngoài. |
| `NODE_ENV`, `LUMIBASE_ENV`, `LUMIBASE_RUNTIME`, `PORT` | `production`, `production`, `docker`, `1989`. |

Production từ chối khởi động nếu thiếu `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`ENCRYPTION_KEY` và `CORS_ALLOWED_ORIGINS`. Entrypoint của image
(`docker/scripts/entrypoint.mjs`) kiểm tra chúng trước khi chạm tới database và
thoát kèm tên các biến còn thiếu.

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

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/khuepm/lumibase)

Blueprint `render.yaml` tạo một web service từ image đã publish, một database
Render Postgres 16 và một instance Render Key Value (`noeviction`, điều mà các job
queue cần), tất cả chỉ truy cập được qua mạng private của Render.
`JWT_SECRET` và `ENCRYPTION_KEY` dùng `generateValue`.

Plan: web service dùng `starter` vì instance free sẽ ngủ khi rảnh, kéo theo
scheduler và các queue worker mà process này chạy. Đổi plan trong dashboard hoặc
trong bản sao `render.yaml` của bạn.

## Railway

`railway.json` cấu hình một service build từ `docker/Dockerfile` với deploy check
`/health`. Một **template** Railway — nút bấm đồng thời tạo Postgres và Redis và
sinh secret — được soạn trong template editor của Railway và publish từ một tài
khoản Railway; nó không thể đọc từ repository. Cho tới khi được publish, một
maintainer tạo nó một lần:

1. Trong template editor, thêm các service chính thức **Postgres** và **Redis**
   và một service tên `lumibase` từ Docker image
   `ghcr.io/khuepm/lumibase-cms:<version>`, có public domain.
2. Copy các biến từ `docker/railway-template-variables.json`. Chúng dùng các hàm
   `${{secret(…)}}` của Railway, nên mỗi lần deploy tự sinh `JWT_SECRET` và
   `ENCRYPTION_KEY` riêng (công thức tạo ra một key AES-256 hợp lệ; test của
   repository kiểm tra điều đó).
3. Publish, rồi thêm nút của template vào đây và vào README.

Để deploy không cần template, tạo cùng ba service trong một project và đặt cùng
các biến, sinh hai secret bằng `openssl` như với Fly.

## Fly.io

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

Mọi template trỏ tới `latest`, tag luôn theo bản release mới nhất. Cho production,
hãy pin tag bạn đã kiểm thử (`ghcr.io/khuepm/lumibase-cms:2.0.0`) và đổi nó có chủ
đích; xem [Docker → Cập nhật](./docker.md#cập-nhật).
