---
version: 1
lastUpdated: 2026-07-28T10:26:33.340Z
sourceLang: en
translatedFrom: en
sourceHash: 2d9ebb23bcc28c05
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:26:33.340Z
codeVerifiedHash: 2d9ebb23bcc28c05
codeVerifiedClaims: 14
---

# Môi trường dùng chung domain (dev / staging / demo)

Các môi trường non-production của LumiBase phục vụ **Studio và CMS API từ một
hostname duy nhất**, dựa vào hành vi "Worker route thắng Pages custom domain" của
Cloudflare:

| Path trên `<env>.lumibase.dev` | Được phục vụ bởi | Vì sao |
| --- | --- | --- |
| `/api/*` | CMS Worker (`lumibase-cms-<env>`) | Bề mặt API |
| `/health`, `/metrics`, `/scim/*` | CMS Worker | Các endpoint CMS nằm ngoài `/api` |
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
  có `routes` của Worker cho `/api/*`, `/health`, `/metrics`, `/scim/*` và
  `CORS_ALLOWED_ORIGINS` để rỗng.
- `apps/cms/package.json` — `build:dev|staging|demo`, `deploy:dev|staging|demo`.
- `.github/workflows/deploy-cms.yml` — branch/dispatch → CMS env.
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
# cộng thêm DATABASE_URL / Hyperdrive, METRICS_TOKEN, v.v. tuỳ env của bạn cần
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
<env>.lumibase.dev/metrics
<env>.lumibase.dev/scim/*
```

### 6. Smoke test

```bash
curl -fsS https://<env>.lumibase.dev/health                 # → JSON health của CMS
curl -fsS https://<env>.lumibase.dev/api/v1/system/version  # → releaseChannel: "<env>"
curl -fsS https://<env>.lumibase.dev/                       # → HTML của Studio (SPA)
```

`/health` và `/api/*` phải chạm tới Worker; `/` và các route SPA phải chạm tới
Pages. Nếu `/api/*` trả về `index.html` của Studio, thì Worker route bị thiếu hoặc
DNS record chưa được proxy (bước 3 & 5).

## Cấu hình GitHub

- **Secrets** (ở repo hoặc theo từng environment): `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`. Các bước deploy bỏ qua một cách êm ái nếu chúng vắng mặt.
- **Environments** (tuỳ chọn): tạo GitHub environment tên `dev` và `demo` để có
  protection rule; nếu không, workflow sẽ lùi về dùng GitHub environment
  `staging` cho các target đó.
- **Branches**: tạo một branch `dev` sống lâu dài để bật deploy dev liên tục.

## Lưu ý

- **[Inference]** Hành vi "Worker route được ưu tiên hơn Pages custom domain trên
  cùng một hostname" dựa trên mô hình routing đã được Cloudflare tài liệu hoá,
  chưa được verify trong account này. Hãy chạy smoke test ở bước 6 sau khi setup
  để xác nhận trước khi dựa vào nó.
- WebSocket/realtime (`/api/v1/realtime`, SiteRoom DO) nằm dưới `/api`, nên nó
  được định tuyến đúng tới Worker.
- `/test-auth` **không** được route (chỉ là helper cho dev cục bộ).
