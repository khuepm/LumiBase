# Cloudflare Deployment

This guide covers the Cloudflare deployment used by the monorepo: the CMS API runs as a Worker and the docs app is deployed as a Cloudflare Pages static site.

## Prerequisites

- Node.js 20 or newer.
- `pnpm` matching the root `packageManager` field.
- Wrangler authenticated with an account that can write Workers, Pages, KV, R2, Hyperdrive and Durable Objects.
- Production values for PostgreSQL, Cloudflare Access and CMS JWT secrets.

Check authentication:

```bash
pnpm exec wrangler whoami
```

## CMS Worker

The Worker lives in `apps/cms` and uses `apps/cms/wrangler.toml`.

Create or attach the production bindings before deploying:

```bash
pnpm exec wrangler hyperdrive create lumibase-hyperdrive \
  --connection-string="postgres://user:pass@host:5432/lumibase"

pnpm exec wrangler kv namespace create CONFIG_CACHE
pnpm exec wrangler r2 bucket create lumibase-media
```

Update `apps/cms/wrangler.toml` with the returned IDs. Keep local defaults in the top-level `[vars]` block, and keep staging/production non-sensitive values and bindings in the named `[env.staging]` and `[env.production]` profiles. Do not place production secret values in `wrangler.toml`; store them as Cloudflare secrets:

```bash
cd apps/cms
pnpm exec wrangler secret put JWT_SECRET --env production
pnpm exec wrangler secret put CF_ACCESS_CERTS_URL --env production
pnpm exec wrangler secret put CF_ACCESS_AUDIENCE --env production
```

Run the release guard before deploying. It verifies production is not using dev auth, the development JWT secret is not present, and required secrets exist in CI environment variables or Cloudflare secrets:

```bash
pnpm release:check
```

Build and deploy:

```bash
pnpm --filter @lumibase/cms build:production
pnpm --filter @lumibase/cms deploy:production
```

After deploy, verify:

```bash
curl -fsS https://<worker-host>/health
```

## Documentation Site

The docs viewer reads markdown from the root `docs/` directory and builds to `apps/docs/dist`.

```bash
pnpm --filter @lumibase/docs build
pnpm docs:deploy
```

The root deploy script runs:

```bash
wrangler pages deploy apps/docs/dist --project-name lumibase-docs
```

## Production Notes

- Do not deploy production with `LUMIBASE_DEV_AUTH="true"` or the development `JWT_SECRET`; `pnpm release:check` blocks these values before `wrangler deploy`.
- Keep Durable Object migrations in top-level `[[migrations]]` entries in `wrangler.toml`.
- Run database migrations before exposing a new API build if the code depends on schema changes.
- Keep the docs and Worker deploys separate so documentation-only changes do not force an API rollout.
