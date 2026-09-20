---
title: Next.js Quickstart — Display LumiBase Content
version: 6
lastUpdated: 2026-09-20T13:04:29.109Z
sourceLang: en
contentHash: 650223b28d48a21b
codeVerified: 2026-09-20T13:04:29.109Z
codeVerifiedHash: 650223b28d48a21b
codeVerifiedClaims: 26
---

<!--
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ TUTORIAL VERSIONING — read before editing                                  │
  │                                                                            │
  │ applies_to_min: 0.9.0   ← lowest LumiBase version this tutorial is valid   │
  │ verified_on:    1.0.0-rc.1  ← version it was last actually tested against      │
  │                                                                            │
  │ This tutorial is intentionally version-pinned. Do NOT clone it per         │
  │ release. Only bump `verified_on` (and, if a breaking change forces it,     │
  │ `applies_to_min`) when one of the contracts in the "Compatibility" table   │
  │ below actually changes. See the DoD checklist in                           │
  │ .kiro/steering/definition-of-done.md §5 (Tutorial impact).                 │
  └──────────────────────────────────────────────────────────────────────────┘
-->

<div align="center">

<h1>🟡 Display LumiBase content in a Next.js app</h1>

<p><strong>Go from a clean machine to a Next.js page rendering content from LumiBase.</strong></p>

<p>
  <img alt="LumiBase version" src="https://img.shields.io/badge/LumiBase-%E2%89%A5%200.9.0%20%C2%B7%20verified%201.0.0-rc.1-F5A623?style=for-the-badge">
  <img alt="Level" src="https://img.shields.io/badge/Level-Beginner-3DDC97?style=for-the-badge">
  <img alt="Time" src="https://img.shields.io/badge/Time-~20%20min-4A90E2?style=for-the-badge">
  <img alt="Stack" src="https://img.shields.io/badge/Next.js-App%20Router-black?style=for-the-badge&logo=next.js">
</p>

</div>

> [!NOTE]
> **Which LumiBase version is this for?** Valid from **LumiBase `0.9.0`** onward (last
> verified on `1.0.0-rc.1`).
> It stays valid for any newer release **until** one of the API contracts in the
> [Compatibility](#compatibility) table changes — see that section to pick the right
> version, with the newest on top.

You will:

1. Run LumiBase locally (CMS API + Studio).
2. Complete the setup wizard and create a `posts` collection with a few published items.
3. Mint a long-lived API key and find your `siteId`.
4. Build a tiny Next.js app that reads those posts with the official `lumibase`
   package (plain `fetch` is shown afterwards as an alternative).

By the end you'll have a working `http://localhost:3000` page listing posts that live in
LumiBase.

> **You need:** Node.js ≥ 22, pnpm ≥ 9, Docker + Docker Compose, Git.

---

## How the pieces fit together

<div align="center">
<table border="0" cellpadding="0" cellspacing="0">
<tr>
<td align="center" valign="middle" width="220" style="background:#1f2430;border-radius:12px;padding:16px;">
  <div style="font-size:32px;">🖥️</div>
  <strong>Next.js app</strong><br>
  <code>localhost:3000</code><br>
  <sub>frontend (your code)</sub>
</td>
<td align="center" valign="middle" width="260">
  <div style="font-size:13px;color:#888;">GET /api/v1/items/posts</div>
  <div style="font-size:22px;">➡️</div>
  <div style="font-size:11px;color:#888;">Authorization: Bearer &lt;token&gt;<br>X-Lumi-Site: &lt;siteId&gt;</div>
  <div style="font-size:22px;">⬅️</div>
  <div style="font-size:13px;color:#888;">{ "data": [ …posts ] }</div>
</td>
<td align="center" valign="middle" width="220" style="background:#1f2430;border-radius:12px;padding:16px;">
  <div style="font-size:32px;">🟡</div>
  <strong>LumiBase</strong><br>
  <code>localhost:1989</code> · API<br>
  <code>localhost:2026</code> · Studio<br>
  <sub>Postgres · Redis · …</sub>
</td>
</tr>
</table>
</div>

LumiBase is the headless backend (API + admin Studio). Next.js is just a client that calls
the **Delivery API** over HTTP. Every request carries two things: a **bearer token** (who
you are) and an **`X-Lumi-Site` header** (which tenant/site you're reading from).

---

## Step 1 — Run LumiBase locally

```bash
git clone https://github.com/khuepm/lumibase.git
cd lumibase

pnpm install

# Backing services: PostgreSQL, Redis, MeiliSearch, Logto
docker compose -f docker/docker-compose.yml up -d

# Database migrations
pnpm -F @lumibase/database db:migrate

# Start CMS API (:1989) + Studio (:2026)
pnpm dev
```

When `pnpm dev` is running you should have:

<table>
<thead><tr><th>Service</th><th>URL</th><th>What it is</th></tr></thead>
<tbody>
<tr><td>🔌 CMS API</td><td><code>http://localhost:1989</code></td><td>The REST API your Next.js app calls</td></tr>
<tr><td>🎛️ Studio</td><td><code>http://localhost:2026</code></td><td>Admin UI to model & edit content</td></tr>
</tbody>
</table>

> See [Local Development](../deployment/local-development.md) for the full service list and
> troubleshooting.

---

## Step 2 — Complete the setup wizard

On first run the database is empty, so the CMS activates a **setup wizard**. Open
**`http://localhost:1989/setup`** and:

1. Create the first **admin user** (email + password — remember these).
2. Set a **site name** and default language.
3. Finish. The response includes one-time **backup codes** — store them somewhere safe.

> [!IMPORTANT]
> The setup wizard creates a **default site** with the id **`__default__`**. That is your
> `siteId` for everything below. (You can confirm it any time with
> `GET /api/v1/site` — see Step 4.)

Verify setup is complete:

```bash
curl http://localhost:1989/health
# → { ... "setup_complete": true }
```

---

## Step 3 — Create a `posts` collection and add content

In **Studio** (`http://localhost:2026`):

<table>
<thead><tr><th>#</th><th>Action</th></tr></thead>
<tbody>
<tr><td>1</td><td>Go to <strong>Collections → New Collection</strong>, name it <code>posts</code>.</td></tr>
<tr><td>2</td><td>Add fields: <code>title</code> (String), <code>body</code> (Text). Do <strong>not</strong> add a <code>status</code> field — every item already has a built-in <code>status</code> column that the publish workflow drives.</td></tr>
<tr><td>3</td><td>Save the collection.</td></tr>
<tr><td>4</td><td>Go to <strong>Content → posts → New Item</strong>. Create 2–3 items and set <code>status</code> = <strong>published</strong>.</td></tr>
</tbody>
</table>

> Prefer the API? Create the collection with `POST /api/v1/collections` and items with
> `POST /api/v1/items/posts`. See the [API spec](../api/hono-api-spec.md).

---

## Step 4 — Get an API key and confirm your `siteId`

Your Next.js app authenticates with a bearer token. For a real integration you want a
**long-lived API key**, not the short login token.

**4a. Log in to get a session token** (used only to create the API key):

```bash
curl -X POST http://localhost:1989/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "email": "admin@example.com", "password": "your-password" }'
```

Response (note: the field is **`token`**, single token — there's no separate
`access_token`/`refresh_token` in this version):

```json
{
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "usr_...", "email": "admin@example.com" }
  }
}
```

**4b. Create a long-lived API key** with that session token:

```bash
curl -X POST http://localhost:1989/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "name": "nextjs-frontend" }'
```

Response — copy the `token` (it starts with **`lbk_`** and is shown **only once**):

```json
{
  "data": {
    "id": "...",
    "name": "nextjs-frontend",
    "prefix": "lbk_",
    "token": "lbk_live_xxxxxxxxxxxxxxxx"
  }
}
```

**4c. Confirm your `siteId`** (optional sanity check):

```bash
curl http://localhost:1989/api/v1/site \
  -H "Authorization: Bearer lbk_live_xxxxxxxxxxxxxxxx" \
  -H "X-Lumi-Site: __default__"
# → { "data": { "id": "__default__", "name": "My Site", ... } }
```

> [!TIP]
> Keep the `lbk_…` key **server-side only** — never ship it to the browser. We use it from
> a Next.js Server Component below, so it never leaves your server.

**4d. Give the key least privilege.** A fresh key carries no permissions. Rather
than attaching the Administrator role, create a policy that can only *read*
`posts`, restrict it to published items, and attach it through a role:

```bash
# A policy whose single rule is "read published posts"
curl -X POST http://localhost:1989/api/v1/policies \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "name": "Blog read-only" }'

curl -X POST http://localhost:1989/api/v1/policies/<policy-id>/permissions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "collection": "posts", "action": "read",
        "permissions": { "status": { "_eq": "published" } } }'

# A role that carries the policy, then attach the role to the key
curl -X POST http://localhost:1989/api/v1/roles \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "name": "Blog Reader" }'

curl -X POST http://localhost:1989/api/v1/roles/<role-id>/policies \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "policyId": "<policy-id>" }'

curl -X POST http://localhost:1989/api/v1/api-keys/<key-id>/roles \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "roleId": "<role-id>" }'
```

The rule is enforced **server-side**: a request from this key that omits
`status=published`, or asks for a draft by id, still gets back only published
items (`404` for the draft). A write attempt answers `403`.

---

## Step 5 — Create the Next.js app

In a **separate directory** (outside the LumiBase repo):

```bash
npx create-next-app@latest my-lumibase-frontend
cd my-lumibase-frontend
```

Accept the defaults (App Router, TypeScript). Create `.env.local`:

```bash
# .env.local — server-side only, NOT prefixed with NEXT_PUBLIC_
LUMIBASE_API_URL=http://localhost:1989
LUMIBASE_SITE_ID=__default__
LUMIBASE_TOKEN=lbk_live_xxxxxxxxxxxxxxxx
```

> We call LumiBase from a **Server Component**, so the token stays on the server and there
> is no CORS to configure. This is the recommended pattern for production too.

---

## Step 6 — Fetch with the SDK

Install `lumibase`. One package gives you both the client you import at runtime
and the `lumibase` CLI used in Step 7:

```bash
npm install lumibase
```

Create the client once. It is imported only from Server Components, so the token
never reaches the browser:

```ts
// lib/lumibase.ts
import { createLumiClient, legacyRest, type ItemRow } from 'lumibase'

// Your collection's content fields, as declared in Studio.
export interface PostFields {
  title: string
  body: string
  [key: string]: unknown
}

export type Post = ItemRow<PostFields>

export const lumibase = createLumiClient<{ posts: PostFields }>({
  url: process.env.LUMIBASE_API_URL!,
  siteId: process.env.LUMIBASE_SITE_ID!,
  // static API key — skips the login flow
  token: process.env.LUMIBASE_TOKEN!,
}).with(legacyRest())
```

```tsx
// app/page.tsx
import { lumibase, type Post } from '@/lib/lumibase'

export default async function Home() {
  // `status` is a dedicated list parameter, not a filter. Sorting uses the
  // structural column's snake_case name.
  const { data: posts } = await lumibase.items('posts').list({
    status: 'published',
    sort: ['-created_at'],
    limit: 20,
  })

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Posts from LumiBase</h1>
      {posts.length === 0 && <p>No published posts yet.</p>}
      <ul>
        {posts.map((post: Post) => (
          <li key={post.id} style={{ marginBottom: '1.5rem' }}>
            <h2>{post.data.title}</h2>
            <p>{post.data.body}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

> [!IMPORTANT]
> **Content fields live under `.data`.** A row is an `ItemRow`: structural
> columns (`id`, `status`, `createdAt`, …) are at the top level, while the
> fields you declared are nested — `post.data.title`, not `post.title`.

Run it:

```bash
# open http://localhost:3000
npm run dev
```

You should see your published posts. Here's roughly what renders:

<div align="center">
<table border="0" width="520"><tr><td style="border:1px solid #d0d7de;border-radius:10px;padding:20px 28px;background:#ffffff;">
<div style="font-family:system-ui;">
<h2 style="margin:0 0 14px;color:#1f2430;">Posts from LumiBase</h2>
<div style="margin-bottom:16px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Hello, Edge 👋</div>
  <div style="color:#444;">My first post served from LumiBase.</div>
</div>
<div style="margin-bottom:4px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Why a Content OS</div>
  <div style="color:#444;">Intent in, reconciled content out.</div>
</div>
</div>
</td></tr></table>
<sub><em>Illustration of the rendered page (not a live screenshot).</em></sub>
</div>

Reading a single post works the same way. Every non-2xx answer throws a
`LumiError` carrying the status, which maps cleanly onto `notFound()`:

```tsx
// app/posts/[id]/page.tsx
import { notFound } from 'next/navigation'
import { LumiError } from 'lumibase'
import { lumibase, type Post } from '@/lib/lumibase'

// Required. Without it this route is cached indefinitely and edits made in
// Studio never reach the page.
export const revalidate = 60

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let post: Post

  try {
    const res = await lumibase.items('posts').detail(id)
    post = res.data
  } catch (err) {
    if (err instanceof LumiError && err.status === 404) return notFound()
    throw err
  }

  return (
    <article>
      <h1>{post.data.title}</h1>
      <p>{post.data.body}</p>
    </article>
  )
}
```

A draft the credential cannot see answers `404` — the same path as an unknown
id — so a draft that was never published has no route into these pages at all.

> [!IMPORTANT]
> **Set `revalidate` on every cached route, not just the list.** A route with
> `generateStaticParams` but no `revalidate` is rendered once at build time and
> then cached forever, so edits made in Studio never appear on it. A post
> published *after* the build is still served: `dynamicParams` defaults to
> `true`, so Next renders it on demand the first time it is requested.

> [!WARNING]
> **Unpublishing is not the same as never having published.** A draft that never
> went live cannot appear — the API answers `404` and no page was ever generated.
> But a post that *was* live and is then unpublished stays readable from the
> cache for up to the `revalidate` window, because the cached HTML is served
> while the revalidation happens in the background.
> Measured against a live CMS with `revalidate = 60`, unpublishing a post whose
> page had just been regenerated: the API stopped serving it to the reader
> credential **immediately**, while the detail page and the list page both kept
> serving it for **64 s**. Editing a post that was already past its window showed
> up in **3–4 s**, and a post published after the build was reachable at its URL
> **immediately** (the list took the same ~60 s to include it).
> So the withdrawal window is finite and bounded by `revalidate`, but it is not
> zero. If your content has a hard takedown requirement, lower `revalidate`, use
> `cache: 'no-store'` on the routes that must never serve withdrawn content, or
> trigger [on-demand revalidation](https://nextjs.org/docs/app/guides/incremental-static-regeneration#on-demand-revalidation-with-revalidatepath)
> from a LumiBase webhook when an item leaves `published`.

> **Already depend on `@lumibase/sdk`?** It exports the identical client —
> `lumibase` simply re-exports it so one name covers both the client and the
> CLI. Swap `from 'lumibase'` for `from '@lumibase/sdk'` and everything above
> works unchanged.

---

## Step 7 — Generate types in CI

`lumibase types` turns the live schema into TypeScript definitions. Commit the
output and let CI fail when it drifts from the schema.

Create `lumibase.config.json` next to `package.json` (it is meant to be
committed — it holds no secret):

```json
{
  "url": "http://localhost:1989",
  "siteId": "__default__",
  "typegen": { "out": "src/lumibase-types.d.ts" }
}
```

```bash
# write src/lumibase-types.d.ts — commit it
npx lumibase types
# exits non-zero if the file is stale
npx lumibase types --check
# show the resolved config and probe connectivity
npx lumibase doctor
```

> [!IMPORTANT]
> **Typegen needs a staff user token, not an API key.**
> `GET /api/v1/typegen/schema` sits behind the Studio access wall, which
> requires a user principal. An API key is rejected with `403` even when its
> role grants `schema:read`. Use a staff user's access token as a build-time
> secret for typegen, and keep the read-only API key from Step 4 for the
> runtime reads your pages do.

The generated file is deterministic — no host, site id or timestamp in its
header — so the same committed file verifies against any instance:

```yaml
- run: npm ci
- run: npx lumibase types --check
  env:
    LUMIBASE_URL: ${{ secrets.LUMIBASE_URL }}
    LUMIBASE_SITE_ID: ${{ secrets.LUMIBASE_SITE_ID }}
    LUMIBASE_TOKEN: ${{ secrets.LUMIBASE_TYPEGEN_TOKEN }}
```

---

## Alternative — the same read with plain `fetch`

The SDK only wraps the HTTP API; nothing stops you calling it directly if you
would rather not add a dependency. You give up typed results and typegen, and
you rebuild the URL, headers and filter encoding yourself:

```tsx
// app/page.tsx
type Post = { id: string; status: string; data: { title: string; body: string } }

async function getPosts(): Promise<Post[]> {
  const url = new URL('/api/v1/items/posts', process.env.LUMIBASE_API_URL)
  url.searchParams.set('status', 'published')
  // The `filter` param accepts two equivalent forms — pick either:
  //   (A) JSON string:       filter={"status":{"_eq":"published"}}
  //   (B) Bracket form:      filter[status][_eq]=published
  url.searchParams.set('sort', '-created_at')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.LUMIBASE_TOKEN}`,
      'X-Lumi-Site': process.env.LUMIBASE_SITE_ID!,
    },
    // ISR-style cache; use 'no-store' for always-fresh
    next: { revalidate: 60 },
  })

  if (!res.ok) throw new Error(`LumiBase responded ${res.status}: ${await res.text()}`)

  const json = (await res.json()) as { data: Post[] }
  return json.data
}
```

---

## Troubleshooting

<table>
<thead><tr><th>Symptom</th><th>Likely cause</th><th>Fix</th></tr></thead>
<tbody>
<tr><td><code>401 Unauthorized</code></td><td>Missing/invalid token</td><td>Re-check <code>LUMIBASE_TOKEN</code>; recreate the API key (Step 4b)</td></tr>
<tr><td><code>423 SETUP_REQUIRED</code></td><td>Setup not finished</td><td>Complete <code>http://localhost:1989/setup</code> (Step 2)</td></tr>
<tr><td><code>404 TENANT_NOT_FOUND</code></td><td>Wrong <code>X-Lumi-Site</code> — the header is well-formed but no such site exists</td><td>Use <code>__default__</code> unless you created another site</td></tr>
<tr><td>Empty <code>data: []</code></td><td>No <strong>published</strong> posts</td><td>Set items to <code>published</code> in Studio</td></tr>
<tr><td><code>404</code> on items</td><td>Collection name mismatch</td><td>Collection must be named exactly <code>posts</code></td></tr>
<tr><td>CORS error in browser</td><td>Fetching from client code</td><td>Fetch from a <strong>Server Component</strong> (as above)</td></tr>
<tr><td><code>429 RATE_LIMITED</code></td><td>Too many requests from one key/IP</td><td>Back off; honour the <code>Retry-After</code> header (see below)</td></tr>
<tr><td><code>503 RATE_LIMIT_UNAVAILABLE</code></td><td>Server's rate-limit cache is down (fail-closed deployments)</td><td>Transient — retry with backoff; not your app's fault</td></tr>
</tbody>
</table>

---

## Production & security notes for frontends

The happy path above works on localhost. Before you ship, wire in the contracts a
LumiBase client is expected to respect. These matter more once your frontend is a
public deployment (Next.js on Vercel/Cloudflare, etc.).

### 1. Keep the API key on the server — always

The `lbk_…` key is a **bearer credential**. Read it only in Server Components, Route
Handlers, or Server Actions — never in a `'use client'` component and never behind a
`NEXT_PUBLIC_` env var (those are inlined into the browser bundle). If the browser
genuinely needs data, proxy it through your own Route Handler so the key stays server-side.

### 2. Handle rate limiting (`429`) and, if fail-closed, `503`

LumiBase throttles per principal/IP and per site. Two responses your fetch layer should
handle:

- **`429 RATE_LIMITED`** — you're over the window. The response carries `Retry-After`
  (seconds) and `X-RateLimit-Reset`. Back off; don't hammer.
- **`503 RATE_LIMIT_UNAVAILABLE`** *(LumiBase ≥ 0.24.0)* — only in deployments that run
  the limiter **fail-closed** (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true`): the limiter's cache
  is momentarily down. It's transient and not your app's fault — retry with backoff.

```ts
async function lumibaseFetch(url: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(url, init)
  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return lumibaseFetch(url, init, attempt + 1)
  }
  return res
}
```

### 3. Watch for `Deprecation` / `Sunset` headers *(LumiBase ≥ 0.24.0)*

A retiring endpoint returns RFC 8594 headers: `Deprecation`, `Sunset` (a date), and a
`Link rel="deprecation"` to the changelog. Log them in your client so an endpoint doesn't
disappear on you:

```ts
if (res.headers.get('Deprecation')) {
  console.warn('[LumiBase] deprecated endpoint; sunset:', res.headers.get('Sunset'))
}
```

### 4. Calling from the browser? Configure CORS deliberately

The Server-Component pattern above needs no CORS. If you must call the API from client
code, the CMS only allows **exact-match** origins listed in `CORS_ALLOWED_ORIGINS` — a
credentialed response is **never** returned for a wildcard `*`. Add your frontend origin
explicitly (e.g. `https://app.example.com`), and remember client calls expose whatever
token they carry, so use a short-lived/narrow-scoped token, not the `lbk_…` key.

### 5. `/test-auth` is a dev-only playground

The interactive auth page at `/test-auth` is developer tooling. From **LumiBase ≥ 0.24.0**
it returns `404` in production — don't build anything that depends on it being reachable
on a production host.

### 6. Keep Next.js patched — SSRF advisories

Frontend framework hygiene is part of your API's attack surface. Recent Next.js releases
fixed **server-side request forgery** issues:

- `GHSA-89xv-2m56-2m9x` — SSRF in Server Actions on custom servers.
- `GHSA-p9j2-gv94-2wf4` — SSRF in `rewrites` via an attacker-controlled destination host.

Use **`next` ≥ 16.2.11**, and never build a `rewrites`/Server-Action destination from
unvalidated user input (a user-supplied hostname or full URL). If you must fetch a
user-provided URL server-side, validate it against an allowlist and block private/metadata
IP ranges — the same discipline LumiBase applies in its own SSRF guard.

---

## Compatibility

This tutorial is **pinned to a minimum LumiBase version** and only re-verified when an API
contract it relies on actually changes. Pick the row matching your LumiBase version
(**newest on top**):

<table>
<thead><tr><th>LumiBase version</th><th>This tutorial</th><th>Notes</th></tr></thead>
<tbody>
<tr><td><strong>0.9.0 → latest</strong></td><td>✅ This page (verified on <code>1.0.0-rc.1</code>)</td><td>Login returns <code>{ data: { token } }</code>; API keys via <code>POST /api/v1/api-keys</code> (<code>lbk_</code> prefix); items filter accepts JSON <em>and</em> bracket form; default site <code>__default__</code>.</td></tr>
<tr><td>&lt; 0.9.0</td><td>⚠️ Not covered</td><td>Earlier releases predate the contracts above. Upgrade to ≥ 0.9.0, or adapt the auth/filter calls to your version.</td></tr>
</tbody>
</table>

**Contracts this tutorial depends on** (if any of these change in a future release, bump
the table above and re-verify — see DoD §5):

- `POST /api/v1/auth/login` → `{ data: { token, user } }`
- `POST /api/v1/api-keys` → `{ data: { token: "lbk_…" } }`
- `GET /api/v1/items/:collection` filter accepts **both** `filter=<JSON>` and
  `filter[field][_op]=value` bracket form (JSON wins if both sent); `sort=<csv>`
- `GET /api/v1/site` returns the active tenant; default id `__default__`
- `lumibase` (re-exports `@lumibase/sdk`) —
  `createLumiClient({ url, siteId, token }).with(legacyRest()).items(c).list(...)` /
  `.detail(id)`; rows are `ItemRow` with content fields under `.data`
- `lumibase types` / `types --check` read `GET /api/v1/typegen/schema`, which
  requires a **staff user** principal (an API key gets `403`)
- Rate limiting returns `429 RATE_LIMITED` with `Retry-After`; the "Production &
  security" section additionally covers `503 RATE_LIMIT_UNAVAILABLE` and
  `Deprecation`/`Sunset` headers, both **added in `0.24.0`** (the core flow above still
  works unchanged from `0.9.0`)

---

## Next steps

- [JavaScript SDK reference](../sdk/javascript.md) — auth, items, files, realtime, Flows.
- [API specification](../api/hono-api-spec.md) — every endpoint, filters, pagination.
- [Deployment overview](../deployment/overview.md) — take this from localhost to dev /
  staging / production (Cloudflare or Docker).
