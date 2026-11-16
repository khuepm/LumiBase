---
version: 2
lastUpdated: 2026-10-31T22:37:08.167Z
sourceLang: en
contentHash: 2d3980a634eeacb6
codeVerified: 2026-10-31T22:37:08.167Z
codeVerifiedHash: 2d3980a634eeacb6
codeVerifiedClaims: 34
---

# Shared-domain environments (dev / staging / demo)

LumiBase's non-production environments serve **Studio and the CMS API from a
single hostname** using Cloudflare's "Worker route wins over Pages custom
domain" behaviour:

| Path on `<env>.lumibase.dev` | Served by | Why |
| --- | --- | --- |
| `/api/*` | CMS Worker (`lumibase-cms-<env>`) | API surface |
| `/health`, `/health/*`, `/metrics`, `/scim/*` | CMS Worker | CMS endpoints outside `/api` |
| everything else (`/`, `/items`, assets…) | Studio Pages (`lumibase-studio`, branch `<env>`) | SPA + static assets |

Because Studio and the CMS share an origin, the SPA calls `/api/...`
**same-origin** — `VITE_API_URL` is empty and **no CORS** is involved.

> Production keeps the **split-origin** model (`studio.lumibase.dev` +
> `api.lumibase.dev`) with a cross-origin CORS allow-list. It is owned by
> `release.yml` and is intentionally not changed by this setup.

## Environments

| Env | Hostname | CMS Worker | Studio Pages branch | CI trigger |
| --- | --- | --- | --- | --- |
| dev | `dev.lumibase.dev` | `lumibase-cms-dev` | `dev` | push to `dev` branch |
| staging | `staging.lumibase.dev` | `lumibase-cms-staging` | `staging` | push to `main` branch |
| demo | `demo.lumibase.dev` | `lumibase-cms-demo` | `demo` | manual (`workflow_dispatch`) |

`LUMIBASE_ENV` is set to `staging` for all three (non-`development`,
non-`production`): auth is enforced, dev-auth bypass is off, and the CORS
resolver stays permissive (harmless for same-origin). `LUMIBASE_RELEASE_CHANNEL`
is the per-env name (`dev` / `staging` / `demo`) used by the deploy health check.

## What the repo already wires (code/config)

- `apps/cms/wrangler.toml` — `[env.dev]`, `[env.staging]`, `[env.demo]` each with
  Worker `routes` for `/api/*`, `/health`, `/health/*`, `/metrics`, `/scim/*`
  and empty `CORS_ALLOWED_ORIGINS`. A route without a trailing `*` matches one
  path exactly, so `/health` alone leaves `/health/ready` to Pages.
  `apps/cms/src/__tests__/shared-domain-worker-routes.test.ts` fails when a CMS
  path outside `/api` is not routed.
- `apps/cms/package.json` — `build:dev|staging|demo`, `deploy:dev|staging|demo`.
- `.github/workflows/deploy-cms.yml` — branch/dispatch → CMS env, then
  `scripts/verify-cms-deploy.mjs` (see [Deploy check](#deploy-check)).
- `.github/workflows/deploy-studio-env.yml` — branch/dispatch → Studio Pages
  branch built with `VITE_API_URL=""`.

## One-time Cloudflare setup (manual — needs dashboard/API access)

Do this once per environment. Replace `<env>` with `dev` / `staging` / `demo`.

### 1. Create the CMS Worker

The Worker name (`lumibase-cms-<env>`) is taken from `wrangler.toml`. A deploy
creates it on first run:

```bash
# from repo root, with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported
pnpm --filter @lumibase/cms run deploy:<env>
```

> On Cloudflare's free plan, the Durable Object migration uses
> `new_sqlite_classes` (already in `wrangler.toml`) — see
> [DO sqlite classes note](./cloudflare.md).

### 2. Set Worker secrets

Routes resolve only after the Worker is deployed with its secrets:

```bash
cd apps/cms
wrangler secret put JWT_SECRET        --env <env>
wrangler secret put ENCRYPTION_KEY    --env <env>
wrangler secret put CF_ACCESS_CERTS_URL --env <env>   # if using CF Access
wrangler secret put CF_ACCESS_AUDIENCE  --env <env>   # if using CF Access
wrangler secret put METRICS_TOKEN       --env <env>   # recommended, see below
wrangler secret put MEILISEARCH_API_KEY --env <env>   # only if search is used
```

Without `METRICS_TOKEN`, a non-production Worker serves `/metrics` and the
per-dependency breakdown of `/health` to anyone. With it, both need
`Authorization: Bearer <token>`.

### 2b. Bindings: database, cache, storage, search

The Worker reads its database, cache and media storage from **bindings**, not
from secrets. `[env.<env>]` in `wrangler.toml` ships with these blocks
commented out, because each needs an id that exists in your account. Without
them the Worker boots and `/health` answers 200 `degraded`, but every route
that touches the database answers 500, and the tail log shows
`HYPERDRIVE binding is not configured for this Worker environment`.

```bash
cd apps/cms
# PostgreSQL reachable from Cloudflare, via Hyperdrive
wrangler hyperdrive create lumibase-hyperdrive-<env> \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DATABASE"
# KV for the config/permission cache
wrangler kv namespace create lumibase-config-cache-<env>
# R2 for media
wrangler r2 bucket create lumibase-media-<env>
```

Then uncomment and fill `[[env.<env>.hyperdrive]]` (binding `HYPERDRIVE`),
`[[env.<env>.kv_namespaces]]` (binding `CONFIG_CACHE`) and
`[[env.<env>.r2_buckets]]` (binding `MEDIA`) with the ids printed above. Apply
the migrations to that database from your machine:

```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DATABASE" pnpm db:migrate
```

Search is optional: set `MEILISEARCH_HOST` in `[env.<env>.vars]` and the
`MEILISEARCH_API_KEY` secret, or leave both unset and accept that `search`
reports unhealthy. Every queue that `[env.<env>]` names must exist before the
deploy, or `wrangler deploy` fails:

```bash
wrangler queues create lumibase-agent-runs-<env>
wrangler queues create lumibase-agent-runs-<env>-dlq
```

### 3. DNS record for the hostname

Add a proxied (orange-cloud) DNS record for `<env>.lumibase.dev` in the
`lumibase.dev` zone. A `CNAME <env> → lumibase.dev` (or the Pages project's
`*.pages.dev` target) works; it must be **Proxied** so Worker routes apply.

### 4. Attach the Studio Pages custom domain

In **Pages → `lumibase-studio` → Custom domains**, add `<env>.lumibase.dev`.
Map it to the **`<env>` branch alias** (Pages → branch deployments) so the
hostname serves the `<env>` preview build, not production.

Deploy the Studio branch once so the alias exists:

```bash
gh workflow run deploy-studio-env.yml -f environment=<env>
```

### 5. Confirm the Worker routes own `/api`

The `routes` in `wrangler.toml` are applied on `deploy:<env>`. Verify in
**Workers → `lumibase-cms-<env>` → Triggers → Routes** that you see:

```
<env>.lumibase.dev/api/*
<env>.lumibase.dev/health
<env>.lumibase.dev/health/*
<env>.lumibase.dev/metrics
<env>.lumibase.dev/scim/*
```

### 6. Smoke test

```bash
curl -fsS https://<env>.lumibase.dev/health                 # → CMS health JSON
curl -sS  https://<env>.lumibase.dev/health/ready           # → JSON: 200 ready, 503 not ready
curl -fsS https://<env>.lumibase.dev/api/v1/system/version  # → releaseChannel: "<env>"
curl -fsS https://<env>.lumibase.dev/                       # → Studio HTML (SPA)
```

`/health` and `/api/*` must hit the Worker; `/` and SPA routes must hit Pages.
If `/api/*` returns Studio's `index.html`, the Worker route is missing or the
DNS record is not proxied (steps 3 & 5). The same holds for `/health/ready`:
Studio HTML there means the `/health/*` route is missing.

## Deploy check

After `deploy:<env>`, `deploy-cms.yml` runs:

```bash
node scripts/verify-cms-deploy.mjs --base-url https://<env>.lumibase.dev --channel <env>
```

It answers three separate questions:

| Question | Probe | Fails the step |
| --- | --- | --- |
| Did the Worker boot and does it own its routes? | `/health` is 200 CMS JSON, not Studio HTML | always |
| Is it the build for this channel? | `/api/v1/system/version` reports `releaseChannel` = `<env>` | always |
| Are its dependencies ready? | `/health/ready` is 200, or 503 JSON | only with `--require-ready` |

`/health` stays 200 when a dependency is down, because it is a degraded-info
endpoint. Only `/health/ready` reports "not ready". By default a 503 is a
workflow warning that lists each dependency when the Worker exposes the detail.
To make readiness block the deploy, set the GitHub environment **variable**
`CMS_REQUIRE_READY=true` on that environment once its bindings exist (step 2b).

## Troubleshooting: Worker up, routes answer 500

This was the state of staging in #461. Diagnose from outside first:

```bash
curl -sS https://<env>.lumibase.dev/health          # 200 degraded, with services when no METRICS_TOKEN
curl -sS https://<env>.lumibase.dev/health/ready    # 503 lists what is not ready
curl -sS https://<env>.lumibase.dev/api/v1/setup/state
```

Then read the exception behind the `requestId` of a 500 body. Both commands
are read-only:

```bash
cd apps/cms
wrangler tail --env <env> --format pretty
wrangler deployments list --env <env>
```

| Tail log message | Cause | Fix |
| --- | --- | --- |
| `HYPERDRIVE binding is not configured for this Worker environment` | no `[[env.<env>.hyperdrive]]` | step 2b |
| `LUMIBASE_RUNTIME=docker is not supported on Cloudflare Workers` | `LUMIBASE_RUNTIME` is set to `docker` | set `cloudflare` in `[env.<env>.vars]` |
| errors naming `ENCRYPTION_KEY` or `JWT_SECRET` | missing secret | step 2 |

## GitHub configuration

- **Secrets** (repo or per-environment): `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`. The deploy steps skip gracefully if absent.
- **Environments** (optional): create GitHub environments named `dev` and
  `demo` for protection rules; otherwise the workflows fall back to the
  `staging` GitHub environment for those targets.
- **Branches**: create a long-lived `dev` branch to enable continuous dev
  deploys.

## Caveats

- The "Worker route takes priority over a Pages custom domain on the same
  hostname" behaviour was observed on staging on 2026-11-01: `/health` and
  `/api/v1/system/version` answered from the Worker, `/` from Pages. The same
  check showed the other side of it: `/health/ready` was not routed, so Pages
  answered it with Studio HTML and a 200. Run the step 6 smoke test after any
  route change.
- WebSocket/realtime (`/api/v1/realtime`, SiteRoom DO) is under `/api`, so it is
  correctly routed to the Worker.
- `/test-auth` is **not** routed (local-dev helper only).
