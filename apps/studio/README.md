# @lumibase/studio

No-code admin SPA for LumiBase. Vite + React 18 + Tailwind + shadcn/ui tokens.

## Why a separate SPA from `apps/web`?

- `apps/studio` is **admin only**: authenticated, no SEO, prefers fast TTI over SSR.
- `apps/web` is the **Next.js delivery demo**: SSR + Page Hydration API consumer.

Keeping them separate avoids bundling admin-only deps (Monaco, dnd-kit, big
filter builder) into the public site.

## Dev

```bash
pnpm install
pnpm --filter @lumibase/cms dev      # API on :1989
pnpm --filter @lumibase/studio dev   # SPA on :2026 (proxies /api → :1989)
```

Open <http://127.0.0.1:2026>. The placeholder dashboard pings `/api/v1/utils/health` to confirm the wire-up.

### API base URL

The Studio resolves the CMS origin via `getApiBaseUrl()` (`src/lib/api-base.ts`):

- **Dev / Docker:** leave `VITE_API_URL` unset → same-origin (`/api/*`). Dev
  goes through the Vite proxy; Docker serves the SPA from the CMS origin.
- **Standalone (Cloudflare Pages):** set `VITE_API_URL` at build time to the
  CMS origin (e.g. `https://api.lumibase.dev`). The CMS must allow the Studio
  origin via `CORS_ALLOWED_ORIGINS`. See `docs/en/deployment/overview.md`.

## Structure

```
src/
  components/        # cross-module UI (app shell, presence, ...)
  modules/           # per-domain pages: content, files, users, access, settings
  interfaces/        # field interface registry (Phase B)
  displays/          # field display registry (Phase B)
  layouts/           # list view layouts: tabular, cards, kanban, ...
  lib/               # cn, api client, ws client, policy eval helpers
  main.tsx
  App.tsx
```

See `docs/ui/studio-ui-spec.md` for the full UI specification.
