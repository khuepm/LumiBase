---
title: Astro Starter — Static Site on Cloudflare Pages
version: 2
lastUpdated: 2026-11-15T08:38:13.859Z
sourceLang: en
contentHash: 0269f961a6832c9d
codeVerified: 2026-11-15T08:38:13.859Z
codeVerifiedHash: 0269f961a6832c9d
codeVerifiedClaims: 10
---

# Astro starter — a static LumiBase site on Cloudflare Pages

`create-lumibase --template astro` scaffolds an [Astro](https://astro.build)
site that reads LumiBase content **once, at build time**, and writes plain HTML
to `dist/`. Cloudflare Pages serves that directory as-is: no server, no API
calls from visitors, no credential in the browser.

| | |
|---|---|
| **You'll build** | A static blog (`/` plus one page per post) from a `posts` collection |
| **Level** | Beginner |
| **Time** | ~15 minutes |
| **Prerequisites** | Node.js ≥ 22.23.4, a LumiBase CMS you can reach, and (for deploys) a Cloudflare account |

> No CMS yet? Scaffold the Next.js template first
> (`npm create lumibase my-cms -- --template nextjs`): it runs CMS + Studio +
> Postgres locally and creates the publishable key and grant this starter
> needs. To host one, see [One-click deploys](../deployment/one-click.md).

## 1. Scaffold

```bash
npm create lumibase my-site -- --template astro
cd my-site
cp .env.example .env
```

The template lives in `packages/create-lumibase/templates/astro`. What you get:

| File | Role |
|---|---|
| `astro.config.mjs` | `output: 'static'` and the typed env schema (`astro:env`) |
| `src/lib/config.ts` | Which credential a build uses — pure, unit-tested rules |
| `src/lib/lumibase.ts` | The typed `lumibase` client and the build-time fetch |
| `src/lumibase-types.d.ts` | Generated collection types (regenerate with `npm run types`) |
| `src/pages/index.astro`, `src/pages/posts/[slug].astro` | The list page and one static page per post |
| `src/components/VisualEditing.astro` | Visual editing hook point (empty today) |
| `public/_headers` | Cloudflare Pages response headers |
| `wrangler.jsonc` | Pages project name and `pages_build_output_dir: "dist"` |

## 2. Connect the CMS

Fill in `.env`:

```bash
LUMIBASE_URL=https://cms.example.com
LUMIBASE_SITE_ID=your-site-id
LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

The CMS administrator provides:

1. **A publishable key** (Studio → Access → API keys, marked publishable). The
   build refuses any token that does not start with `lbk_pub_` in
   `LUMIBASE_PUBLISHABLE_KEY` — a secret key there would widen what a normal
   build can read.
2. **A read grant restricted to published rows.** `GET /api/v1/items/:collection`
   applies no published-only filter of its own. The build also asks for
   `status=published` explicitly, but the grant is what enforces it.
3. **A `posts` collection** with `title`, `slug` and `body` fields.

All five variables are declared `context: 'server'` in `astro.config.mjs`, and
the key and preview token are `access: 'secret'`, so Astro will not let them
into client code.

## 3. Build and run

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static HTML in dist/
```

Two failure modes are deliberate:

- **Not configured** (`LUMIBASE_URL` or the key empty): the build succeeds and
  produces a "connect your CMS" page, so a first deploy never fails on missing
  settings.
- **Configured but unreachable**: the build fails. Publishing an empty site
  over a working one is worse than keeping the last good deploy.

Posts whose `slug` is not URL-safe (`[a-z0-9][a-z0-9_-]*`) are listed but get
no page. Post bodies are rendered as text, not HTML — CMS content is untrusted
input until you add a sanitiser you trust.

## 4. Typed content

```bash
LUMIBASE_TOKEN=… npm run types      # regenerates src/lumibase-types.d.ts
npm run types:check                 # fails when the file is stale (CI)
```

`src/lib/lumibase.ts` derives each collection's `data` shape from the generated
file, so `post.data.title` is typed and a renamed field is a type error.
`LUMIBASE_TOKEN` needs schema read access; it is used only by these two
commands, never by the build.

## 5. Deploy to Cloudflare Pages

See [Static export to Cloudflare Pages](../deployment/static-export-cloudflare-pages.md)
for both deploy paths (Git integration and `npm run deploy`), the CI example,
and rebuilding on publish with a deploy hook.

## 6. Draft preview builds

A static site cannot switch preview on per visitor, so preview is a separate
**build**: set `LUMIBASE_PREVIEW=true` and `LUMIBASE_PREVIEW_TOKEN` (a secret
`lbk_…` token whose grant includes drafts) on a protected environment, such as
the Pages *Preview* environment behind Cloudflare Access. The build then
includes drafts, adds a banner and `noindex`, and fails if the token is missing
or is a publishable key. For per-request preview, use the
[SvelteKit starter](./sveltekit-starter.md).

## 7. Visual editing

LumiBase visual editing (roadmap V03, the planned `@lumibase/visual-editing`
package) is **not released yet**. The starter does not emulate it.
`src/components/VisualEditing.astro` is the single place it will plug in; the
layout renders it only on preview builds, and it renders nothing today.

## Compatibility

| LumiBase | Starter | Notes |
|---|---|---|
| ≥ 2.0.0 CMS | `create-lumibase` releases after 2.0.0 | The template ships in the first `create-lumibase` release after 2.0.0; `create-lumibase@2.0.0` does not have it |

Contracts this tutorial relies on: `GET /api/v1/items/:collection` with
`status`, `sort`, `limit` and `offset`; publishable keys (`lbk_pub_` prefix);
the typegen manifest read by `lumibase types`.
