---
title: SvelteKit Starter — Server Loads and Draft Preview on Cloudflare Pages
version: 3
lastUpdated: 2026-11-15T08:39:52.066Z
sourceLang: en
contentHash: 0fe449a09715982d
codeVerified: 2026-11-15T08:39:52.066Z
codeVerifiedHash: 0fe449a09715982d
codeVerifiedClaims: 16
---

# SvelteKit starter — server loads and draft preview on Cloudflare Pages

`create-lumibase --template sveltekit` scaffolds a
[SvelteKit](https://svelte.dev/docs/kit) site that reads LumiBase content in
**server-side loads** and runs on Cloudflare Pages through
`@sveltejs/adapter-cloudflare`. Pages are rendered at request time, so a
publish in Studio shows up on the next request without a rebuild, and editors
can preview drafts.

| | |
|---|---|
| **You'll build** | A blog (`/` and `/posts/:slug`) with per-request draft preview |
| **Level** | Intermediate |
| **Time** | ~20 minutes |
| **Prerequisites** | Node.js ≥ 22.17, a LumiBase CMS you can reach, and (for deploys) a Cloudflare account |

## 1. Scaffold

```bash
npm create lumibase my-site -- --template sveltekit
cd my-site
cp .env.example .env
npm install
npm run dev      # http://localhost:5173
```

The template lives in `packages/create-lumibase/templates/sveltekit`. It
targets SvelteKit 3: configuration is passed to `sveltekit(...)` in
`vite.config.ts` (there is no `svelte.config.js`), library imports use `#lib`,
and environment variables are declared in `src/env.ts`.

| File | Role |
|---|---|
| `src/env.ts` | Declares every variable — none public, none static |
| `src/lib/server/config.ts` | Which credential a request uses — pure, unit-tested rules |
| `src/lib/server/preview.ts` | The signed preview cookie (Web Crypto only) |
| `src/lib/server/lumibase.ts` | The typed `lumibase` client, loads and cache headers |
| `src/hooks.server.ts` | Verifies the preview cookie once per request |
| `src/routes/api/preview/+server.ts`, `src/routes/api/preview/exit/+server.ts` | Enter / leave preview |
| `src/lib/components/VisualEditing.svelte` | Visual editing hook point (empty today) |
| `wrangler.jsonc` | Pages project name and `pages_build_output_dir: ".svelte-kit/cloudflare"` |

## 2. Connect the CMS

```bash
LUMIBASE_URL=https://cms.example.com
LUMIBASE_SITE_ID=your-site-id
LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

The CMS needs the same three things as the
[Astro starter](./astro-starter.md): a publishable key, a
read grant restricted to published rows, and a `posts` collection with
`title`, `slug` and `body` fields. A token without the `lbk_pub_` prefix in
`LUMIBASE_PUBLISHABLE_KEY` is refused: that key answers every anonymous
visitor.

The variables are read from `$app/env/private`, a server-only module —
SvelteKit fails the build if browser code imports it — and only from
`src/lib/server/`, hooks and `+server.ts` / `+page.server.ts` files. None is
`static`, so on Cloudflare Pages they come from the project's Variables and
Secrets when the app starts, not from the build.

## 3. Draft preview

Preview is **off** until both server-only values are set:

| Variable | Value |
|---|---|
| `LUMIBASE_PREVIEW_SECRET` | Random, 32+ characters (`openssl rand -base64 32`). Shorter values leave preview off |
| `LUMIBASE_PREVIEW_TOKEN` | A secret token (`lbk_…`, not `lbk_pub_…`) whose read grant includes drafts |

Enter preview by opening (or configuring as the preview URL in Studio):

```
https://<your-site>/api/preview?secret=<LUMIBASE_PREVIEW_SECRET>&redirect=/posts/<slug>
```

How it is enforced:

- The secret is compared after hashing both sides, in constant time.
- A correct secret sets an HttpOnly cookie `lumibase_preview` whose value is
  `<expiry>.<HMAC-SHA256(expiry)>` keyed by the secret, valid for one hour.
  Forged, expired or tampered cookies are ordinary visitors, and rotating the
  secret ends every session.
- Preview requests read with the preview token and every status, and are served
  `Cache-Control: private, no-store`. Everyone else reads with the publishable
  key and `status=published` (`public, max-age=0, s-maxage=60`).
- A wrong secret is a `401`; with preview not configured the route is a `404`.
- `redirect` accepts same-origin paths only (no `//host`, no absolute URLs).
- `/api/preview/exit` clears the cookie.
- In production the cookie is `Secure; SameSite=None` so preview also works
  inside a Studio iframe; it only ever unlocks reads.

> The Delivery API's own `?preview=true` flag on
> `GET /api/v1/deliver/page/:site_id/:slug` only **bypasses its caches** — it
> does not return drafts (the route never reads it beyond the cache decision,
> see `apps/cms/src/routes/deliver.ts`). Draft preview therefore needs a
> credential whose grant includes drafts, which is what
> `LUMIBASE_PREVIEW_TOKEN` is.

## 4. Typed content

```bash
LUMIBASE_TOKEN=… npm run types      # regenerates src/lib/lumibase-types.ts
npm run types:check
```

## 5. Deploy to Cloudflare Pages

```bash
npm run build                       # .svelte-kit/cloudflare (assets + _worker.js)
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy
npx wrangler pages secret put LUMIBASE_PUBLISHABLE_KEY
```

Or connect the repository in the dashboard with build command `npm run build`
and output directory `.svelte-kit/cloudflare`. Add `LUMIBASE_URL` and
`LUMIBASE_SITE_ID` as variables and the key, preview secret and preview token
as **secrets**. To run the built site under the Pages runtime locally, put the
variables in `.dev.vars` (git-ignored) and run `npm run preview`.

Prefer a fully static export instead? Swap in `@sveltejs/adapter-static`, set
`export const prerender = true` in `src/routes/+layout.server.ts` and remove the
preview routes and hook. The site is then written to `build/`: point
`pages_build_output_dir` in `wrangler.jsonc` (and the Pages output directory)
there, and follow
[Static export to Cloudflare Pages](../deployment/static-export-cloudflare-pages.md).

## 6. Visual editing

LumiBase visual editing (roadmap V03, the planned `@lumibase/visual-editing`
package) is **not released yet**. `src/lib/components/VisualEditing.svelte` is
where it will plug in: the root layout renders it only for verified preview
sessions, and it renders nothing today.

## Compatibility

| LumiBase | Starter | Notes |
|---|---|---|
| ≥ 2.0.0 CMS | `create-lumibase` releases after 2.0.0 | SvelteKit 3 / `@sveltejs/adapter-cloudflare` 8; the template is not in `create-lumibase@2.0.0` |

Contracts this tutorial relies on: `GET /api/v1/items/:collection` with
`status`, `filter` (`{ "slug": { "_eq": … } }`), `sort` and `limit`;
publishable keys (`lbk_pub_` prefix); secret API keys whose grant includes
drafts.
