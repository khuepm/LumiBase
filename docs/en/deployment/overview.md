# Deployment Overview

LumiBase supports two deployment modes from the same CMS codebase:

- **Cloudflare Workers** for the edge API runtime.
- **Docker self-hosting** for teams that want to operate the full stack in containers.

The public documentation site is a static Vite app deployed separately to **Cloudflare Pages**.
The public Marketplace site is also deployed to **Cloudflare Pages** and reads the CMS marketplace catalog at build/runtime revalidation.

## Cloudflare Targets

| Target | Package | Output | Deploy command |
| --- | --- | --- | --- |
| CMS API Worker | `@lumibase/cms` | Worker bundle | `pnpm --filter @lumibase/cms deploy` |
| Documentation site | `@lumibase/docs` | `apps/docs/dist` | `pnpm docs:deploy` |
| Landing site | `@lumibase/landing` | `apps/landing/out` | `pnpm landing:deploy` |
| Marketplace site | `@lumibase/marketplace` | `apps/marketplace/out` | `pnpm marketplace:deploy` |

Run the build or dry-run command before deploying:

```bash
pnpm --filter @lumibase/docs build
NEXT_PUBLIC_USE_REAL_API=true NEXT_PUBLIC_CMS_API_URL=https://<cms-production-host> pnpm marketplace:build
pnpm --filter @lumibase/cms build
```

Marketplace smoke URLs after deploy: `/`, `/extensions/`, `/categories/seo/`, and `/extensions/<slug>/`.

## Required Cloudflare Services

The CMS Worker can run with only environment variables for local development, but production expects the Cloudflare bindings described in `apps/cms/wrangler.toml`:

- `HYPERDRIVE` for pooled PostgreSQL access.
- `CONFIG_CACHE` for KV-backed schema, permission and settings cache.
- `MEDIA` for R2 media storage.
- `SITE_ROOM` Durable Object for per-site realtime WebSocket fan-out.
- Cron Triggers for scheduled audit/login-attempt retention cleanup.

Secrets such as `JWT_SECRET`, Cloudflare Access values and database credentials must be set with Wrangler secrets or dashboard-managed secret variables, not committed to the repository.

## Recommended Release Flow

1. Install dependencies with `pnpm install`.
2. Run `pnpm --filter @lumibase/docs build` for the docs site.
3. Run `pnpm --filter @lumibase/cms build` to dry-run the Worker bundle.
4. Deploy docs with `pnpm docs:deploy`.
5. Deploy the CMS Worker with `pnpm --filter @lumibase/cms deploy` after production bindings and secrets are configured.

See [Cloudflare deployment](./cloudflare.md) for the detailed Worker and Pages commands.
