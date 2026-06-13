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

## Deploying

The build output (`dist/`) is a fully static site. The repository deploy script publishes it to Cloudflare Pages project `lumibase-docs`, which is intended to serve `docs.lumibase.dev`.

Cloudflare Pages uses [`public/_redirects`](./public/_redirects) to route all direct page loads back to `index.html`, so React Router deep links such as `/en/docs/README` work after refresh.

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
