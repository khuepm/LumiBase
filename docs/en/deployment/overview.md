# Deployment Overview

LumiBase supports two deployment modes from the same CMS codebase:

- **Cloudflare Workers** for the edge API runtime.
- **Docker self-hosting** for teams that want to operate the full stack in containers.

For a managed-cloud self-host, see [Google Cloud (single VM)](./google-cloud-vm.md) —
the cheapest way to run the full Docker stack on Google Cloud with Gemini as the
LLM provider, while keeping the CMS's long-lived background jobs working.

The public documentation site is a static Vite app deployed separately to **Cloudflare Pages**.
The public Marketplace site is also deployed to **Cloudflare Pages** and reads the CMS marketplace catalog at build/runtime revalidation.
The **Studio** admin SPA is a static Vite app deployed to **Cloudflare Pages** as well — see [Studio API connectivity](#studio-api-connectivity).

## Studio API connectivity

The Studio SPA talks to the CMS over a single base URL resolved by
`apps/studio/src/lib/api-base.ts` (`getApiBaseUrl()`):

- **Dev / Docker single-origin:** leave `VITE_API_URL` unset. The Studio uses
  same-origin requests — the Vite dev server proxies `/api` to the local CMS,
  and Docker serves the Studio from the same origin as the CMS.
- **Cloudflare Pages (e.g. `studio.lumibase.dev`):** the static SPA has **no
  co-located backend**, so it must call the CMS cross-origin. Set
  `VITE_API_URL` at build time to the CMS origin (e.g.
  `https://api.lumibase.dev`). The release workflow wires this from the
  `LUMIBASE_CMS_PRODUCTION_URL` repository variable.

Because the Studio then calls the CMS from a different origin, the CMS must
allow that origin via `CORS_ALLOWED_ORIGINS` (see `apps/cms/wrangler.toml`).
Production rejects `*`, so list the exact Studio origin. If `VITE_API_URL` is
missing on a standalone deploy, the Studio falls back to same-origin and the
setup gate shows **"Couldn't reach the server."**

> The **dev / staging / demo** environments instead serve Studio and the CMS
> from a **single hostname** (`<env>.lumibase.dev`), so `VITE_API_URL` is empty
> (same-origin) and no CORS is needed. See
> [Shared-domain environments](./shared-domain-environments.md).

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
See [Private admin path](./private-admin-path.md) for the production no-redirect policy that keeps the Studio entry point secret.
