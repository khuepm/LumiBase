# LumiBase Docs

Public documentation site for [LumiBase](https://github.com/khuepm/lumibase) — an edge-native, multi-tenant headless CMS.

This is a **Vite + React** static docs viewer that consumes markdown from the project root `docs/` folder via a virtual module produced by `vite-plugin-docs-loader`.

## Stack

- **Vite 5** — fast dev server + static build
- **React 18** — UI runtime
- **React Router v7** — client-side routing
- **react-markdown + remark-gfm** — markdown rendering with GitHub-flavored extensions
- **Shiki** — syntax highlighting (loaded lazily per language)
- **MiniSearch** — client-side full-text search
- **Tailwind CSS** — styling

## Configuration (Docusaurus-style)

Site metadata, navbar items, sidebar groups and footer links are declared in [`docs.config.json`](./docs.config.json). The schema mirrors the relevant parts of Docusaurus' `docusaurus.config.ts`, so contributors familiar with Docusaurus can edit it without learning a new format.

```jsonc
{
  "title": "LumiBase",
  "navbar": { "items": [/* ... */] },
  "sidebar": { "docs": [/* category + items */] },
  "footer": { "links": [/* ... */] }
}
```

## Local development

```bash
pnpm --filter @lumibase/docs dev      # http://localhost:5174
pnpm --filter @lumibase/docs build    # static output in dist/
pnpm --filter @lumibase/docs preview  # serve the build locally
```

## Content source

All `.md` files under the repo root `docs/` directory are auto-discovered. Front-matter is parsed with `gray-matter`; the title falls back to the filename in title-case if not provided.

```markdown
---
title: My great doc
---
```

## Analytics and consent

Traffic is counted by Cloudflare Web Analytics, which is cookieless and always on.
Google Analytics 4 is optional and consent-gated: set `VITE_GA_ID` at build time to
offer it, leave it unset and the site ships no tag, no cookie, and no banner.

The rules live in [`packages/analytics-consent`](../../packages/analytics-consent)
(shared with `apps/landing`) — read its README for the invariants. This app
contributes:

| File | Role |
| --- | --- |
| `src/lib/analytics.ts` | Resolves `VITE_GA_ID` into a validated measurement ID, or `null` |
| `src/components/analytics/AnalyticsConsent.tsx` | Injects the tag once granted; renders the banner while undecided |
| `src/components/analytics/CookiePreferences.tsx` | Footer control to see and withdraw the choice |

Two things worth knowing before changing them:

- **Consent is per-origin.** `docs.lumibase.dev` and `lumibase.dev` have separate
  `localStorage`, so this site asks for itself and needs its own withdrawal
  control. Do not assume the landing page's banner covered it.
- **The prerender must stay banner-free.** `useConsent()` reports `'unhydrated'`
  during SSR so the 296 prerendered pages carry no banner and no tag. Verify with
  `grep -rl googletagmanager dist/**/*.html` — that must stay empty.

What an unset `VITE_GA_ID` does *not* do is remove the code: Vite still bundles the
components, so `dist/assets/*.js` contains the string `googletagmanager.com` and the
banner copy as unreachable code. Nothing renders and no request is made — confirm by
network log rather than by grepping the bundle.

Behaviour is covered by `src/components/__tests__/analytics-consent.test.tsx`
(jsdom): undecided asks and loads nothing, a stored decline stays silent, and
withdrawal brings the banner back.

## Deploying

The build output (`dist/`) is a fully static site. The repository deploy script publishes it to Cloudflare Pages project `lumibase-docs`, which is intended to serve `docs.lumibase.dev`.

Cloudflare Pages uses [`public/_redirects`](./public/_redirects) to route all direct page loads back to `index.html`, so React Router deep links such as `/en/docs/README` work after refresh.

> **Refresh returns 404 on every page?** That symptom means the SPA fallback
> isn't reaching Cloudflare — it is a deployment/config problem, not a code
> problem (the fallback works in `wrangler pages dev dist`). Check that the
> live Cloudflare Pages project serves the **`dist/` produced by
> `pnpm docs:build`**: the build emits `dist/_redirects` (`/* /index.html 200`)
> plus prerendered `*/index.html` files. If the project is wired through the
> dashboard Git integration rather than the `wrangler pages deploy` workflow,
> confirm its **build command** runs `pnpm docs:build` and its **output
> directory** is `apps/docs/dist`; a stale deploy or a wrong output directory
> drops `_redirects`, and then every direct load / refresh 404s.

Wrangler does not support `account_id` inside a Pages `wrangler.toml`; pass the account through the environment when the local login cannot resolve it automatically.

```bash
export CLOUDFLARE_ACCOUNT_ID=792c8e28da56d9568474df5fcf00cfc7
pnpm --filter @lumibase/docs build
pnpm docs:deploy
```

Equivalent Wrangler command:

```bash
CLOUDFLARE_ACCOUNT_ID=792c8e28da56d9568474df5fcf00cfc7 \
wrangler pages deploy dist --project-name lumibase-docs --branch main --cwd apps/docs
```
