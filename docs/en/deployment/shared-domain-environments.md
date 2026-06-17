# Shared-domain environments (dev / staging / demo)

LumiBase's non-production environments serve **Studio and the CMS API from a
single hostname** using Cloudflare's "Worker route wins over Pages custom
domain" behaviour:

| Path on `<env>.lumibase.dev` | Served by | Why |
| --- | --- | --- |
| `/api/*` | CMS Worker (`lumibase-cms-<env>`) | API surface |
| `/health`, `/metrics`, `/scim/*` | CMS Worker | CMS endpoints outside `/api` |
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
  Worker `routes` for `/api/*`, `/health`, `/metrics`, `/scim/*` and empty
  `CORS_ALLOWED_ORIGINS`.
- `apps/cms/package.json` — `build:dev|staging|demo`, `deploy:dev|staging|demo`.
- `.github/workflows/deploy-cms.yml` — branch/dispatch → CMS env.
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
# plus DATABASE_URL / Hyperdrive, METRICS_TOKEN, etc. as your env needs
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
<env>.lumibase.dev/metrics
<env>.lumibase.dev/scim/*
```

### 6. Smoke test

```bash
curl -fsS https://<env>.lumibase.dev/health                 # → CMS health JSON
curl -fsS https://<env>.lumibase.dev/api/v1/system/version  # → releaseChannel: "<env>"
curl -fsS https://<env>.lumibase.dev/                       # → Studio HTML (SPA)
```

`/health` and `/api/*` must hit the Worker; `/` and SPA routes must hit Pages.
If `/api/*` returns Studio's `index.html`, the Worker route is missing or the
DNS record is not proxied (steps 3 & 5).

## GitHub configuration

- **Secrets** (repo or per-environment): `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`. The deploy steps skip gracefully if absent.
- **Environments** (optional): create GitHub environments named `dev` and
  `demo` for protection rules; otherwise the workflows fall back to the
  `staging` GitHub environment for those targets.
- **Branches**: create a long-lived `dev` branch to enable continuous dev
  deploys.

## Caveats

- **[Inference]** The "Worker route takes priority over a Pages custom domain on
  the same hostname" behaviour is based on Cloudflare's documented routing
  model, not verified in this account. Run the step 6 smoke test after setup to
  confirm before relying on it.
- WebSocket/realtime (`/api/v1/realtime`, SiteRoom DO) is under `/api`, so it is
  correctly routed to the Worker.
- `/test-auth` is **not** routed (local-dev helper only).
