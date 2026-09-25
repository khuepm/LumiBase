# Next.js Blog Example

A minimal blog built with Next.js (App Router, Server Components) that reads
published posts from a LumiBase CMS through the **`lumibase`** package.

`lumibase` is the one dependency you install: its library entry re-exports the
JS/TS client, and the same package provides the `lumibase` CLI used below for
type generation. `@lumibase/sdk` remains supported and exports the identical
client — see [Using `@lumibase/sdk` instead](#using-lumibasesdk-instead).

This example is **standalone**: copy the directory anywhere outside the
LumiBase repo and it installs from the registry with no workspace linking.

## Prerequisites

You need a **running LumiBase CMS** with content to read — this app is only the
frontend. Follow the [Next.js quickstart](../../docs/en/tutorials/nextjs-quickstart.md)
to start the CMS, complete the setup wizard, create a `posts` collection, and
mint an API key.

This example expects a `posts` collection with the fields `title` (string),
`body` (text) and `author` (string), and at least one item set to
**published**.

## Getting started

1. **Configure the environment**

   ```bash
   cp .env.example .env.local
   ```

   Set `LUMIBASE_URL`, `LUMIBASE_SITE_ID` and `LUMIBASE_TOKEN`. Use a
   **read-only** API key — the example only lists and reads items. None of
   these are `NEXT_PUBLIC_*`, so the token stays server-side.

2. **Install and run**

   ```bash
   npm install
   npm run dev
   ```

3. Open <http://localhost:3000>.

## How it works

The client is built once in [`src/lib/lumi.ts`](src/lib/lumi.ts):

```ts
import { createLumiClient, legacyRest } from 'lumibase';

export const lumi = createLumiClient<Schema>({ url, token, siteId }).with(legacyRest());
```

Pages then use the typed resource helpers from Server Components:

```ts
// list — drafts are filtered out by the server
const { data } = await lumi.items('posts').list({
  status: 'published',
  sort: ['-created_at'],
  limit: 50,
});

// detail
const { data: post } = await lumi.items('posts').detail(id);
```

Two details worth knowing:

- **Content fields live under `.data`.** A row is an `ItemRow`: structural
  columns (`id`, `status`, `createdAt`, …) sit at the top level, while your
  declared fields are nested — `post.data.title`, not `post.title`.
- **`status` is a list parameter, not a filter**, and sorting uses the
  structural column's snake_case name (`-created_at`).

Every non-2xx response throws a `LumiError` carrying `.status`, which
[`src/app/posts/[id]/page.tsx`](src/app/posts/[id]/page.tsx) maps to Next.js's
`notFound()`:

```ts
try {
  const res = await lumi.items('posts').detail(id);
  post = res.data;
} catch (err) {
  if (err instanceof LumiError && err.status === 404) return notFound();
  throw err;
}
```

## Caching

**Both** routes set `export const revalidate = 60`. The list page needs it, and
so does the detail page — `generateStaticParams` on its own renders each post
once at build time and then caches it forever, so edits made in Studio would
never appear. Declaring `revalidate` is what makes the detail page refresh too.

Publishing or editing in Studio is visible to the API immediately, while the
rendered pages keep serving their cached copy until the window elapses. Lower
`revalidate`, or use `cache: 'no-store'`, if a page must be always-fresh.

A post published *after* the build is not in `generateStaticParams`. The detail
route leaves `dynamicParams` at its default (`true`), so Next renders that post
on demand the first time it is requested and caches it like the rest.

### The withdrawal window, measured

A draft that was **never** published cannot appear here: the reader credential
gets `404` and no page is ever generated for it. A post that *was* live and is
then unpublished is a different case — the cached HTML keeps being served while
revalidation happens in the background.

One measurement, against a live CMS with `revalidate = 60`, unpublishing a post
whose page had just been regenerated:

| Change | API / reader key | List page | Detail page |
|---|---|---|---|
| Edit a post already past its window | immediate | 4 s | 3 s |
| Unpublish (page freshly generated) | immediate (`404`) | 64 s | 64 s |
| Publish a post that did not exist at build time | immediate | ~60 s | immediate at its URL |

**This example has no hard withdrawal SLA, and `revalidate` is not an upper
bound.** It is the minimum age at which a page may go looking for fresh data.
Per [the ISR
docs](https://nextjs.org/docs/app/guides/incremental-static-regeneration), the
first request after expiry is still answered from the stale cache while
regeneration runs behind it; a page nobody requests is never regenerated at all;
and a regeneration that fails leaves the previous HTML in place. The 64 s above is
one path — traffic present, regeneration successful — not a ceiling.

If your content has a takedown requirement, do not rely on this default. Lower
`revalidate`, use `cache: 'no-store'` on routes that must never serve withdrawn
content, or trigger
[on-demand revalidation](https://nextjs.org/docs/app/guides/incremental-static-regeneration#on-demand-revalidation-with-revalidatepath)
from a LumiBase webhook when an item leaves `published` — the only option here
that reacts to the change instead of waiting for a clock.

## Type generation

`lumibase types` generates TypeScript definitions from the live schema into
`src/lumibase-types.d.ts` (path configured in
[`lumibase.config.json`](lumibase.config.json)), and the generated file is
committed:

```bash
npm run types          # write the types
npm run types:check    # CI: fail if the committed file is stale
```

> **Typegen needs a different credential from the one this app runs with.**
> `GET /api/v1/typegen/schema` sits behind the Studio access wall, which
> requires a **staff user** principal — an API key is rejected with `403` even
> when its role grants `schema:read`. Use a staff user's access token for
> typegen (a build-time/CI secret), and keep the read-only API key for the
> runtime reads. `lumibase doctor` reports which credential it resolved.

The output is deterministic — no host, site id or timestamp in the header — so
it can be committed and verified in CI:

```yaml
- run: npm ci
- run: npx lumibase types --check
  env:
    LUMIBASE_URL: ${{ secrets.LUMIBASE_URL }}
    LUMIBASE_SITE_ID: ${{ secrets.LUMIBASE_SITE_ID }}
    LUMIBASE_TOKEN: ${{ secrets.LUMIBASE_TYPEGEN_TOKEN }}
```

`--check` exits `0` when the committed file matches the live schema and
non-zero when it drifts, without writing anything.

## Security notes

- **Keep the token on the server.** Every fetch here runs in a Server
  Component. Never move it to `NEXT_PUBLIC_LUMIBASE_TOKEN` — that ships the
  credential to every visitor.
- **Use least privilege.** Give the key a role whose policy grants only
  `read` on the collections you render. A policy rule of
  `{"status": {"_eq": "published"}}` makes the server withhold drafts even if a
  request asks for them.
- **Never use an admin token in a frontend.** It can write and delete content.

## Using `@lumibase/sdk` instead

`lumibase` re-exports `@lumibase/sdk`, so the imports are interchangeable — the
exported `createLumiClient`, `legacyRest` and `LumiError` are the *same*
objects. If your project already depends on the SDK directly, swap the import:

```ts
import { createLumiClient, legacyRest } from '@lumibase/sdk';
```

In that case point typegen at the same package so the generated file imports
from what you installed:

```bash
lumibase types --import-from @lumibase/sdk
```

(or set `typegen.importFrom` in `lumibase.config.json`). The `lumibase` CLI is
still what generates the types.
