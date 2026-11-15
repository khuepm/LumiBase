---
title: Static Export to Cloudflare Pages
version: 2
lastUpdated: 2026-11-15T08:38:14.448Z
sourceLang: en
contentHash: 63a9024b64e372f2
codeVerified: 2026-11-15T08:38:14.448Z
codeVerifiedHash: 63a9024b64e372f2
codeVerifiedClaims: 20
---

# Static export to Cloudflare Pages

How to ship a LumiBase-backed site as static files on Cloudflare Pages, using
the [Astro starter](../tutorials/astro-starter.md) as the worked example. The
same steps apply to any static build (for example the SvelteKit starter with
`@sveltejs/adapter-static`). This page is about your **website**; for hosting
the CMS itself see [Cloudflare](./cloudflare.md) and
[One-click deploys](./one-click.md).

## The model

1. `astro build` reads content from the CMS with a **publishable** key
   (`lbk_pub_…`) and writes HTML to `dist/`.
2. `wrangler pages deploy dist` (or the Pages Git integration) uploads `dist/`.
3. When an editor publishes, a **deploy hook** rebuilds the site.

Nothing secret ends up in `dist/`: the key is only used during the build, and
the starter declares it as a server-only secret in `astro.config.mjs`.

## Option A — Pages Git integration

Workers & Pages → Create → Pages → Connect to Git, then:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `NODE_VERSION=22` (Astro 7 needs ≥ 22.23.4) |
| Variables | `LUMIBASE_URL`, `LUMIBASE_SITE_ID` |
| Secrets | `LUMIBASE_PUBLISHABLE_KEY` |

## Option B — direct upload from CI

`npm run deploy` runs `wrangler pages deploy dist`; `wrangler.jsonc` carries the
project name. It reads `CLOUDFLARE_API_TOKEN` (permission *Cloudflare Pages:
Edit*) and `CLOUDFLARE_ACCOUNT_ID` from the environment. Guard the deploy so a
run without them — a fork, a pull request — still builds and skips cleanly:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build
        env:
          LUMIBASE_URL: ${{ vars.LUMIBASE_URL }}
          LUMIBASE_SITE_ID: ${{ vars.LUMIBASE_SITE_ID }}
          LUMIBASE_PUBLISHABLE_KEY: ${{ secrets.LUMIBASE_PUBLISHABLE_KEY }}
      - name: Deploy to Cloudflare Pages
        if: env.CLOUDFLARE_API_TOKEN != '' && env.CLOUDFLARE_ACCOUNT_ID != ''
        run: npm run deploy -- --branch main
```

A skipped deploy leaves the job green, so do not read a green check as proof
of a deployment — the same caveat as
[Cloudflare Pages CI](./cloudflare-pages-ci.md).

### How the LumiBase repository checks this

The `scaffold-smoke` job in `.github/workflows/ci.yml` (driven by
`packages/create-lumibase/scripts/smoke-scaffold.mjs`) scaffolds every
template, installs it with npm and pnpm, typechecks it, and **builds** the
Astro and SvelteKit starters, failing if `dist/index.html` or
`.svelte-kit/cloudflare/_worker.js` is missing. On pushes to `main` with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` configured it then deploys
the scaffolded Astro build with the starter's own `npm run deploy` (project
name from the `STARTER_PAGES_PROJECT` repository variable, default
`lumibase-astro-starter`); otherwise it prints a notice and skips.

## Rebuild on publish (deploy hook)

1. Pages project → Settings → Builds → **Deploy hooks** → create one for the
   production branch. Anyone holding the URL can start a build: treat it as a
   secret.
2. In LumiBase, create a Flow with trigger type `event` and
   `triggerOptions: { "collection": "posts" }`, whose graph has a single `http`
   node with options `{ "url": "<deploy hook URL>", "method": "POST" }`. The
   `http` operation is SSRF-guarded and times out after 30 s
   (`apps/cms/src/services/flow-service.ts`). Event flows are enqueued on the
   CMS's `flow-events` queue, so that queue must be configured.

The trigger matches every create, update and delete in the collection, drafts
included (`apps/cms/src/services/flow-dispatch.ts`); put a `condition` node in
front of the `http` node to rebuild only on some changes. Every call starts a
Pages build and counts against your build quota. To narrow the trigger to
certain actions, set `"action": ["update"]` in `triggerOptions`.

## Draft previews of a static site

A static build cannot decide per visitor, so preview is a separate build: set
`LUMIBASE_PREVIEW=true` and a secret `LUMIBASE_PREVIEW_TOKEN` (a token whose
grant includes drafts) **only** on the Pages *Preview* environment, and protect
`*.pages.dev` preview URLs with Cloudflare Access. The starter refuses a
preview build without that token, or with a publishable key in its place. For
per-request preview, use the [SvelteKit starter](../tutorials/sveltekit-starter.md).

## Checklist

- [ ] `LUMIBASE_PUBLISHABLE_KEY` is a publishable key with a published-only grant
- [ ] Secrets are Pages *secrets* / CI secrets, never in `wrangler.jsonc` or a committed `.env`
- [ ] The deploy hook URL is stored only in the Flow
- [ ] Preview variables exist only on a protected preview environment
- [ ] Framing headers (`public/_headers`) still allow your Studio origin if you embed previews
