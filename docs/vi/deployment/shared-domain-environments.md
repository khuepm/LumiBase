---
version: 2
lastUpdated: 2026-10-31T22:37:08.167Z
sourceLang: en
translatedFrom: en
sourceHash: 2d3980a634eeacb6
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-31T22:37:08.167Z
codeVerifiedHash: 2d3980a634eeacb6
codeVerifiedClaims: 34
---

# Môi trường dùng chung domain (dev / staging / demo)

Các môi trường non-production của LumiBase phục vụ **Studio và CMS API từ một
hostname duy nhất**, dựa vào hành vi "Worker route thắng Pages custom domain" của
Cloudflare:

| Path trên `<env>.lumibase.dev` | Được phục vụ bởi | Vì sao |
| --- | --- | --- |
| `/api/*` | CMS Worker (`lumibase-cms-<env>`) | Bề mặt API |
| `/health`, `/health/*`, `/metrics`, `/scim/*` | CMS Worker | Các endpoint CMS nằm ngoài `/api` |
| mọi thứ còn lại (`/`, `/items`, asset…) | Studio Pages (`lumibase-studio`, branch `<env>`) | SPA + static asset |

Vì Studio và CMS dùng chung một origin, SPA gọi `/api/...` **cùng origin** —
`VITE_API_URL` để rỗng và **không có CORS** nào tham gia.

> Production vẫn giữ mô hình **split-origin** (`studio.lumibase.dev` +
> `api.lumibase.dev`) với một allow-list CORS cross-origin. Nó do `release.yml`
> sở hữu và cố ý không bị setup này thay đổi.

## Các môi trường

| Env | Hostname | CMS Worker | Branch Studio Pages | CI trigger |
| --- | --- | --- | --- | --- |
| dev | `dev.lumibase.dev` | `lumibase-cms-dev` | `dev` | push vào branch `dev` |
| staging | `staging.lumibase.dev` | `lumibase-cms-staging` | `staging` | push vào branch `main` |
| demo | `demo.lumibase.dev` | `lumibase-cms-demo` | `demo` | thủ công (`workflow_dispatch`) |

`LUMIBASE_ENV` được đặt là `staging` cho cả ba (không phải `development`, không
phải `production`): auth được enforce, đường bypass dev-auth bị tắt, và CORS
resolver vẫn dễ dãi (vô hại với cùng origin). `LUMIBASE_RELEASE_CHANNEL` là tên
riêng theo từng env (`dev` / `staging` / `demo`), được deploy health check dùng.

## Những gì repo đã nối sẵn (code/config)

- `apps/cms/wrangler.toml` — `[env.dev]`, `[env.staging]`, `[env.demo]`, mỗi cái
  có `routes` của Worker cho `/api/*`, `/health`, `/health/*`, `/metrics`,
  `/scim/*` và `CORS_ALLOWED_ORIGINS` để rỗng. Route không có `*` ở cuối chỉ
  khớp đúng một path, nên chỉ có `/health` thì `/health/ready` rơi về Pages.
  `apps/cms/src/__tests__/shared-domain-worker-routes.test.ts` fail khi một path
  CMS nằm ngoài `/api` không được route.
- `apps/cms/package.json` — `build:dev|staging|demo`, `deploy:dev|staging|demo`.
- `.github/workflows/deploy-cms.yml` — branch/dispatch → CMS env, rồi chạy
  `scripts/verify-cms-deploy.mjs` (xem [Kiểm tra sau deploy](#kiểm-tra-sau-deploy)).
- `.github/workflows/deploy-studio-env.yml` — branch/dispatch → branch Studio
  Pages, build với `VITE_API_URL=""`.

## Thiết lập Cloudflare một lần (thủ công — cần quyền dashboard/API)

Làm việc này một lần cho mỗi môi trường. Thay `<env>` bằng `dev` / `staging` / `demo`.

### 1. Tạo CMS Worker

Tên Worker (`lumibase-cms-<env>`) lấy từ `wrangler.toml`. Một lần deploy sẽ tạo
nó ở lần chạy đầu:

```bash
# từ gốc repo, đã export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
pnpm --filter @lumibase/cms run deploy:<env>
```

> Trên free plan của Cloudflare, migration Durable Object dùng
> `new_sqlite_classes` (đã có trong `wrangler.toml`) — xem
> [ghi chú DO sqlite classes](./cloudflare.md).

### 2. Đặt secret cho Worker

Route chỉ resolve sau khi Worker đã được deploy cùng secret của nó:

```bash
cd apps/cms
wrangler secret put JWT_SECRET        --env <env>
wrangler secret put ENCRYPTION_KEY    --env <env>
wrangler secret put CF_ACCESS_CERTS_URL --env <env>   # nếu dùng CF Access
wrangler secret put CF_ACCESS_AUDIENCE  --env <env>   # nếu dùng CF Access
wrangler secret put METRICS_TOKEN       --env <env>   # nên đặt, xem bên dưới
wrangler secret put MEILISEARCH_API_KEY --env <env>   # chỉ khi dùng search
```

Không có `METRICS_TOKEN` thì Worker non-production phục vụ `/metrics` và phần
chi tiết theo từng dependency của `/health` cho bất kỳ ai. Có token thì cả hai
đều cần `Authorization: Bearer <token>`.

### 2b. Binding: database, cache, storage, search

Worker đọc database, cache và storage media từ **binding**, không phải từ
secret. `[env.<env>]` trong `wrangler.toml` để sẵn các block này ở dạng comment,
vì mỗi block cần một id có thật trong account của bạn. Thiếu chúng thì Worker
vẫn boot và `/health` trả 200 `degraded`, nhưng mọi route đụng tới database đều
trả 500, và tail log ghi
`HYPERDRIVE binding is not configured for this Worker environment`.

```bash
cd apps/cms
# PostgreSQL mà Cloudflare kết nối được, qua Hyperdrive
wrangler hyperdrive create lumibase-hyperdrive-<env> \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DATABASE"
# KV cho cache config/permission
wrangler kv namespace create lumibase-config-cache-<env>
# R2 cho media
wrangler r2 bucket create lumibase-media-<env>
```

Sau đó bỏ comment và điền `[[env.<env>.hyperdrive]]` (binding `HYPERDRIVE`),
`[[env.<env>.kv_namespaces]]` (binding `CONFIG_CACHE`) và
`[[env.<env>.r2_buckets]]` (binding `MEDIA`) bằng các id vừa in ra. Chạy
migration lên database đó từ máy của bạn:

```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DATABASE" pnpm db:migrate
```

Search là tuỳ chọn: đặt `MEILISEARCH_HOST` trong `[env.<env>.vars]` và secret
`MEILISEARCH_API_KEY`, hoặc để trống cả hai và chấp nhận `search` báo unhealthy.
Mọi queue mà `[env.<env>]` khai báo phải tồn tại trước khi deploy, nếu không
`wrangler deploy` sẽ fail:

```bash
wrangler queues create lumibase-agent-runs-<env>
wrangler queues create lumibase-agent-runs-<env>-dlq
```

### 3. DNS record cho hostname

Thêm một DNS record được proxy (orange-cloud) cho `<env>.lumibase.dev` trong zone
`lumibase.dev`. Một `CNAME <env> → lumibase.dev` (hoặc trỏ tới target
`*.pages.dev` của Pages project) là được; nó **phải** ở trạng thái Proxied để
Worker route có hiệu lực.

### 4. Gắn custom domain của Studio Pages

Trong **Pages → `lumibase-studio` → Custom domains**, thêm `<env>.lumibase.dev`.
Map nó vào **alias của branch `<env>`** (Pages → branch deployments) để hostname
phục vụ build preview của `<env>`, không phải production.

Deploy branch Studio một lần để alias tồn tại:

```bash
gh workflow run deploy-studio-env.yml -f environment=<env>
```

### 5. Xác nhận Worker route sở hữu `/api`

Các `routes` trong `wrangler.toml` được áp khi `deploy:<env>`. Hãy verify trong
**Workers → `lumibase-cms-<env>` → Triggers → Routes** rằng bạn thấy:

```
<env>.lumibase.dev/api/*
<env>.lumibase.dev/health
<env>.lumibase.dev/health/*
<env>.lumibase.dev/metrics
<env>.lumibase.dev/scim/*
```

### 6. Smoke test

```bash
curl -fsS https://<env>.lumibase.dev/health                 # → JSON health của CMS
curl -sS  https://<env>.lumibase.dev/health/ready           # → JSON: 200 sẵn sàng, 503 chưa sẵn sàng
curl -fsS https://<env>.lumibase.dev/api/v1/system/version  # → releaseChannel: "<env>"
curl -fsS https://<env>.lumibase.dev/                       # → HTML của Studio (SPA)
```

`/health` và `/api/*` phải chạm tới Worker; `/` và các route SPA phải chạm tới
Pages. Nếu `/api/*` trả về `index.html` của Studio, thì Worker route bị thiếu hoặc
DNS record chưa được proxy (bước 3 & 5). Với `/health/ready` cũng vậy: nhận
HTML của Studio ở đó nghĩa là thiếu route `/health/*`.

## Kiểm tra sau deploy

Sau `deploy:<env>`, `deploy-cms.yml` chạy:

```bash
node scripts/verify-cms-deploy.mjs --base-url https://<env>.lumibase.dev --channel <env>
```

Script trả lời ba câu hỏi tách biệt:

| Câu hỏi | Probe | Làm fail step |
| --- | --- | --- |
| Worker đã boot và sở hữu route của nó chưa? | `/health` là JSON 200 của CMS, không phải HTML của Studio | luôn luôn |
| Có đúng build của channel này không? | `/api/v1/system/version` báo `releaseChannel` = `<env>` | luôn luôn |
| Dependency đã sẵn sàng chưa? | `/health/ready` là 200, hoặc JSON 503 | chỉ khi có `--require-ready` |

`/health` vẫn trả 200 khi một dependency hỏng, vì đó là endpoint báo trạng thái
degraded. Chỉ `/health/ready` mới báo "chưa sẵn sàng". Mặc định một 503 là
warning của workflow, liệt kê từng dependency khi Worker cho xem chi tiết. Để
readiness chặn deploy, đặt **variable** của GitHub environment
`CMS_REQUIRE_READY=true` cho environment đó khi binding đã có (bước 2b).

## Xử lý sự cố: Worker chạy, route trả 500

Đây là trạng thái của staging trong #461. Chẩn đoán từ bên ngoài trước:

```bash
curl -sS https://<env>.lumibase.dev/health          # 200 degraded, kèm services khi không có METRICS_TOKEN
curl -sS https://<env>.lumibase.dev/health/ready    # 503 liệt kê thứ chưa sẵn sàng
curl -sS https://<env>.lumibase.dev/api/v1/setup/state
```

Rồi đọc exception ứng với `requestId` trong body của một response 500. Cả hai
lệnh đều chỉ đọc:

```bash
cd apps/cms
wrangler tail --env <env> --format pretty
wrangler deployments list --env <env>
```

| Thông điệp trong tail log | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `HYPERDRIVE binding is not configured for this Worker environment` | không có `[[env.<env>.hyperdrive]]` | bước 2b |
| `LUMIBASE_RUNTIME=docker is not supported on Cloudflare Workers` | `LUMIBASE_RUNTIME` đang là `docker` | đặt `cloudflare` trong `[env.<env>.vars]` |
| lỗi nhắc tới `ENCRYPTION_KEY` hoặc `JWT_SECRET` | thiếu secret | bước 2 |

## Cấu hình GitHub

- **Secrets** (ở repo hoặc theo từng environment): `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`. Các bước deploy bỏ qua một cách êm ái nếu chúng vắng mặt.
- **Environments** (tuỳ chọn): tạo GitHub environment tên `dev` và `demo` để có
  protection rule; nếu không, workflow sẽ lùi về dùng GitHub environment
  `staging` cho các target đó.
- **Branches**: tạo một branch `dev` sống lâu dài để bật deploy dev liên tục.

## Lưu ý

- Hành vi "Worker route được ưu tiên hơn Pages custom domain trên cùng một
  hostname" đã được quan sát trên staging ngày 2026-11-01: `/health` và
  `/api/v1/system/version` do Worker trả lời, `/` do Pages. Cùng lần kiểm đó
  cho thấy mặt còn lại: `/health/ready` không được route, nên Pages trả lời nó
  bằng HTML của Studio với mã 200. Chạy smoke test ở bước 6 sau mỗi lần đổi route.
- WebSocket/realtime (`/api/v1/realtime`, SiteRoom DO) nằm dưới `/api`, nên nó
  được định tuyến đúng tới Worker.
- `/test-auth` **không** được route (chỉ là helper cho dev cục bộ).
