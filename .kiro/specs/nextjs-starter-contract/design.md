# Design Document — Next.js starter contract (#332, handoff A-02)

> **Status: IMPLEMENTED.** The owner directed implementation to proceed without
> waiting for reviewer grant (2026-09-12), so the four blocking questions in §8
> were decided as proposed.
>
> This contract is kept as the design record. What was actually run, and the
> evidence for it, is in §9.
>
> Baseline: main `6a20441af5dde899b976479f0ed7f8d1a9341dee`.
> Every claim below was verified against the source tree, the registry, or a
> running instance.

## 1. Overview

What #332 asks for: a new user, **outside the monorepo**, scaffolds a Next.js
website, connects CMS and Studio, sees seeded content, edits and publishes in
Studio, then reads the change back on the website through a **least-privilege**
client — with no admin token anywhere in the browser bundle.

Principles:

- **Reuse, don't reinvent** — publishable API keys, the setup wizard, the seed
  pattern and Studio-in-Docker all exist already; this contract assembles them.
- **Do not add a package merely to raise download counts** (an explicit #332
  requirement).
- **`create-lumibase` stays the single implementation** — `lumibase init`
  delegates to it, so the two entrypoints cannot drift.
- **Distinguish a local artifact from a published one** — "the code is merged"
  does not mean "the image/npm package is published".

## 2. The Next.js template

Add a third template, `nextjs`, keeping `default` and `cloudflare` untouched.

`scaffold.ts` **needs no logic change**: it already copies a template directory
recursively and renders any `.hbs` file
(`packages/create-lumibase/src/scaffold.ts:50-95`). Adding a template is a new
directory plus a widened union type.

The edits, deliberately minimal:

| Location | Change |
|---|---|
| `packages/create-lumibase/src/index.ts:14` | `Template = 'default' \| 'cloudflare'` → add `'nextjs'` |
| `packages/create-lumibase/src/index.ts:78-96` | one more choice in the "Deployment target" prompt |
| `packages/create-lumibase/src/scaffold.ts:41-48` | `buildTemplateContext` gains an `isNextjs` flag (alongside `isCloudflare`/`isDefault`) |

**The two entrypoints cannot drift:** `lumibase init` does not re-implement the
scaffolder — it runs `dlx create-lumibase@<the CLI's own version>`
(`packages/cli/src/commands/init.ts:20-45`). This contract does **not** modify
`init.ts`; it only adds a test (`init.test.ts`) asserting `--template nextjs` is
forwarded verbatim.

⚠️ **Release dependency — the reviewer was right (P2.2).** `init` resolves the
scaffolder from the **registry**, so a new template is not reachable through
`lumibase init` until `create-lumibase` is published again. Verified: the
published `create-lumibase@1.0.0-rc.1` tarball ships only `templates/cloudflare`
and `templates/default`, and `npx create-lumibase@1.0.0-rc.1 x --template nextjs`
**fails with ENOENT** on the template directory. The `--template` validation does
not catch this case, because the name is valid — only the published artifact is
old.

⇒ `npm create` (via the new tarball/`dist`) works today; `lumibase init` reaches
parity **after the next publish**. No code change can make that happen sooner.

## 3. Two backend paths

### 3.1 Path A — connect an existing CMS/Studio instance

The consumer needs only a base URL, a site id and a publishable key. No
provisioning.

### 3.2 Path B — Docker, CMS and Studio in one image

⚠️ **No semver tag contains Studio.** My first draft of this contract proposed
pinning `1.0.0-rc.1` and claimed the image carried Studio — **wrong**, and the
reviewer caught it. I had inferred it from *today's* `docker/Dockerfile`, but
that file does not describe the contents of a tag built earlier.

Verified by running the images themselves (`ls /app/studio`):

| tag | Studio | note |
|---|---|---|
| `1.0.0-rc.1` | ✖ no | built 2026-09-03 |
| `latest` / `0.26.0` | ✖ no | the 0.x line |
| `edge` | ✔ yes | revision `683a0270`, but a moving tag |

The reason: the commit that added Studio (`2bd5b0ab`) landed **2026-09-07**,
four days *after* `1.0.0-rc.1` was built. Exactly the trap the handoff warned
about.

⇒ **Pin by digest, not by tag.** `edge` has Studio but is rebuilt on every push
to main; semver tags have no Studio at all. Digest `sha256:3f125caa…` is
immutable and was verified to contain `/app/studio/index.html`. Running it
produces `[lumibase-cms] Serving Studio from /app/studio`, `GET /<adminPath>`
returns 200 `text/html` with `<title>LumiBase Studio</title>`, and `/api/v1/*`
still answers with the `{errors}` JSON envelope rather than being swallowed by
the SPA catch-all.

How Studio is served: `apps/cms/src/serve.ts:81` calls `mountStudio`; env
`LUMIBASE_SERVE_STUDIO` (disable) and `LUMIBASE_STUDIO_DIST` (relocate) —
`apps/cms/src/serve-studio.ts:94,110`.

**Local ≠ published:** `docker/docker-compose.yml:86-87` builds the CMS service
from source, so the repo's own compose file is *not* evidence that any published
image runs. The `nextjs` template ships a compose file that **pulls** the pinned
digest, verified by a cold pull.

### 3.3 Bootstrapping the first admin and site

- `POST /api/v1/setup/complete` (`apps/cms/src/modules/setup/routes.ts:317-379`),
  mounted publicly outside tenant/auth (`apps/cms/src/index.ts:173`).
  Body: `account{email,password,firstName,lastName}`, `adminPath`, `setupToken?`
  (`routes.ts:40-79`).
- The first site has the fixed id `__default__`
  (`apps/cms/src/modules/setup/site-constants.ts:11`), chosen so re-running the
  wizard is idempotent.
- `LUMIBASE_REQUIRE_SETUP_TOKEN=true` **appears** to print a token once
  (`apps/cms/src/modules/setup/setup-token.ts:199`), but that helper is never
  actually called — see §9.1(a) and #470. The template therefore leaves the flag
  off.

## 4. Collection, seed and public client

### 4.1 Collection

One `posts` collection with a minimal `title` / `slug` / `body` field set.

The model is `collections → fields → items`
(`packages/database/src/schema/cms.ts:47,88,184`); `items.status` defaults to
`draft` (`:194-195`). Create the collection with inline `fields` via
`POST /api/v1/collections` (`apps/cms/src/routes/collections.ts:97,162-178`), and
items via `POST /api/v1/items/:collection`
(`apps/cms/src/routes/items.ts:106-118`).

### 4.2 A seed that is safe to re-run

Following the pattern the repo already uses: stable ids plus
`onConflictDoNothing`, as in
`packages/database/scripts/seed-content-os-demo.ts:109,127,166`. The seed is
site-scoped and runs **server-side** during bootstrap.

### 4.3 Public client — publishable key

A **publishable key** rather than the pure anonymous realm (reasoning in §6):

- Key class `lbk_pub_` (`apps/cms/src/services/api-key-publishable.ts:29`),
  distinct from the secret `lbk_`. Sent as `Authorization: Bearer <token>`; the
  server stores only a hash (`apps/cms/src/middleware/auth.ts:285-291`).
- Publishable keys are **origin-checked** against `metadata.allowedOrigins`
  (`apps/cms/src/middleware/auth.ts:329-349`).
  ⚠️ An empty allowlist means `no_constraint` — usable from anywhere
  (`apps/cms/src/services/api-key-publishable.ts:75-80`) — so the template must
  set `allowedOrigins` explicitly.
- The key is bound to one site: `apiKey.siteId !== siteId` ⇒ 401 plus an audit
  record (`apps/cms/src/middleware/auth.ts:299-305`). That is the mechanism which
  stops a tenant B client reading tenant A content.

### 4.4 ⚠️ Draft-leak risk — decided and verified

`GET /api/v1/items` does **not** filter to published on its own: `status` is an
optional query parameter, applied only when the caller passes it
(`apps/cms/src/routes/items.ts:27`,
`apps/cms/src/services/item-service.ts:693`). And `enablePublicAccess`
provisions a role and a policy but **no permission rows**
(`apps/cms/src/services/auth/public-role.ts:130-175`).

⇒ A `read` grant without a row filter means the public client **reads drafts**.

**Decided:** the `read` grant on `posts` always carries `publishedOnly: true`
(`apps/cms/src/routes/access-grants.ts:82`), which compiles to
`{ status: { _eq: 'published' } }`
(`apps/cms/src/services/auth/realm-access.ts:35`), plus a `fields` whitelist.
Passed explicitly rather than relying on the server-side default
(`realm-access.ts:226` turns it on for `read`) — defaults can change.

Verified on a live instance: the seed deliberately leaves one post as a draft,
and `cms:verify` confirms the publishable key sees only `published` (§9).

### 4.5 The admin token

Used only during server-side bootstrap and seeding. Admin variables carry no
`NEXT_PUBLIC_` prefix, so they cannot reach the browser bundle. Evidence: a
production build with sentinel values (§9).

## 5. Files, environment and commands

### 5.1 File grant requested

| File | Added/Changed |
|---|---|
| `packages/create-lumibase/templates/nextjs/**` | new — Next.js app + compose pulling the pinned image + bootstrap/seed scripts |
| `packages/create-lumibase/src/index.ts` | changed — `Template` union, one prompt choice |
| `packages/create-lumibase/src/scaffold.ts` | changed — `isNextjs` context flag |
| `packages/create-lumibase/src/templates.test.ts` | changed — extend `it.each` to `nextjs` |
| `packages/create-lumibase/src/nextjs-template.test.ts` | new — safety invariants (no credential leak, `publishedOnly`, digest pin) |
| `packages/create-lumibase/src/utils/print.ts` | changed — next-steps for the `nextjs` template |
| `packages/cli/src/commands/init.test.ts` | changed — pin verbatim `--template` forwarding |

**Untouched:** `packages/sdk/**`, `apps/studio/**`, the root manifest/lockfile,
`.github/workflows/**`, shared docs/specs. `#334` owns the reference example, so
this contract adds no standalone example. Avoids colliding with `#467` (branch
`chore/deps-batch-2026-09`).

### 5.2 Environment variable contract

| Variable | Side | Role |
|---|---|---|
| `NEXT_PUBLIC_LUMIBASE_URL` | browser | CMS base URL |
| `NEXT_PUBLIC_LUMIBASE_SITE_ID` | browser | `__default__`; sent as `X-Lumi-Site` |
| `NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY` | browser | `lbk_pub_` key, read-only + published-only |
| `LUMIBASE_ADMIN_TOKEN` | **server only** | bootstrap/seed only |
| `LUMIBASE_REQUIRE_SETUP_TOKEN` | container | setup-token gate (left off — #470) |

Tenant resolution: the **`X-Lumi-Site`** header is the primary path
(`apps/cms/src/middleware/tenant.ts:26`) — the same header the SDK already sends
(`packages/sdk/src/client.ts:183`).

### 5.3 Cold-install commands (outside the monorepo, no `workspace:*`)

```bash
pnpm -F create-lumibase build && npm pack
cd "$(mktemp -d)" && npm i <tarball>
npx create-lumibase my-site --template nextjs --pm npm --no-git
```

## 6. Where SDK/API support is needed

`LumiClientOptions.token` is **required**, typed `string`, and documented as a
"Logto access token" (`packages/sdk/src/client.ts:12`); the client always sets
`authorization: Bearer ${currentToken}` (`packages/sdk/src/client.ts:182`). There
is no anonymous/publishable mode.

- A publishable key **works today**: it travels over that same
  `Authorization: Bearer` header, so passing the key as `token` is enough.
  **Not a blocker for #332.**
- But the **pure anonymous** path (`apps/cms/src/middleware/auth.ts:529-545`;
  `GET`/`HEAD` only, and only the prefixes `/api/v1/items|search|media|files` —
  `:567-575`) is unreachable from the SDK, because the `authorization` header
  cannot be omitted.
- Decision: #332 uses a publishable key. Relaxing `token?: string` belongs to the
  SDK owner; this contract does **not** modify `packages/sdk`.

## 7. Acceptance evidence to be supplied

- Pack and install into a directory outside the monorepo; no `workspace:*`; both
  entrypoints behave equivalently.
- Seed twice with no duplication.
- Edit/publish in Studio → the website reads the **real** change, no mock data.
- Grep the bundle to prove no admin token leaks.
- A tenant B client cannot read tenant A content.
- **Assert the publishable key cannot see a draft** (§4.4).
- Regression on the `default` and `cloudflare` templates.
- Handoff records base/head, changed paths, commands/exit codes/skips, and what
  remains unverified.
- Local artifacts recorded separately from published npm/image artifacts;
  cold-install evidence supplied to #448.

## 8. The four blocking questions — decided

The owner directed implementation to proceed, so all four were decided as
proposed:

1. **#450**: the known-fail request is **withdrawn**. The reviewer was right
   (P2.4): I inferred "the cloudflare template cannot install" from the header of
   `templates.test.ts`, but that paragraph describes the failure **before** it was
   fixed. Verified for real: scaffolding `cloudflare` and running `npm install`
   **adds 63 packages with no ERESOLVE**. No reproduction, so no waiver to ask
   for. #450 still needs its own reviewer acceptance.
2. **The `status = published` row filter**: mandatory. The API already exposes a
   `publishedOnly` flag (`apps/cms/src/routes/access-grants.ts:82`) compiling to
   `{ status: { _eq: 'published' } }`
   (`apps/cms/src/services/auth/realm-access.ts:35`), so no hand-written DSL is
   needed.
3. **Image pin**: the original proposal (`1.0.0-rc.1`) was **wrong** — that tag
   has no Studio. Changed to a digest pin, `sha256:3f125caa…` (§3.2).
4. **`packages/sdk` untouched**: unchanged. A publishable key travels over the
   existing `Authorization: Bearer` header, so the current client works as-is.

## 9. What was actually run — evidence

The whole lifecycle ran against a real instance (cold install outside the
monorepo → Docker → bootstrap → seed → website), with no mocks:

| Item | Result |
|---|---|
| Cold install from a packed tarball, outside the monorepo | ✔ no `workspace:*`, no leftover `.hbs` |
| `npm install` in the scaffolded project | ✔ 31 packages, **no ERESOLVE** |
| `tsc --noEmit` in the scaffolded project | ✔ exit 0 |
| Pull the image by digest `sha256:3f125caa…` | ✔ runs, **contains Studio** |
| Studio served at `/<adminPath>` | ✔ 200 `text/html`, `<title>LumiBase Studio</title>` |
| `/api/v1/*` not swallowed by the SPA | ✔ still returns the `{errors}` JSON envelope |
| `cms:bootstrap` | ✔ all 6 steps |
| `cms:seed` run twice | ✔ first run creates 3, second creates 0 — idempotent |
| `cms:verify` | ✔ reads published, **cannot see the draft**, cannot write |
| Website render | ✔ 2 published posts, **no draft** |
| Publish the draft → reload | ✔ appears (0 → 1), real data |
| Admin token/password in runtime HTML | ✔ 0 occurrences |
| **Sentinel production build** | ✔ admin/password sentinels **0 files** in `.next`; publishable key **2 files** (the positive control that makes the zero meaningful) |
| **Studio in a browser** | ✔ signed in, opened `posts`, saw 3 items: 1 `DRAFT` + 2 `PUBLISHED` |
| Draft fetched by **direct id** | ✔ unreachable (`ZYkt-txK…`) |
| `?status=draft` via the public key | ✔ 0 items |
| Regression: scaffold `default` + `cloudflare` | ✔ both fine |
| `npm install` on the `cloudflare` template | ✔ 63 packages, **no ERESOLVE** (refutes the earlier claim) |
| `turbo run typecheck` across the repo | ✔ 18/18 |
| `create-lumibase` tests | ✔ 30/30 |
| `lumibase` tests | ✔ 47/47 |

### 9.1 Two CMS bugs found by running it (issues #469, #470)

Both are **outside the scope of #332** (`apps/cms` must not be modified here), so
the template works around them and the starter's README says why:

**(a) The setup-token flag locks the instance out — #470.**
`printSetupTokenIfRequired` (`apps/cms/src/modules/setup/setup-token.ts:148`) is
unit-tested but **called from nowhere** at startup — a repo-wide grep returns
three hits, all inside that file. With `LUMIBASE_REQUIRE_SETUP_TOKEN=true`,
`/setup/state` reports `requiresSetupToken: true`, `/setup/complete` answers
`SETUP_TOKEN_REQUIRED`, and there is no way to obtain the token. Verified
directly. ⇒ the compose file leaves the flag off; the stack binds to localhost
instead.

**(b) A forged site header crashes the CMS — unauthenticated DoS — #469.**
`withTenant` only shape-checks `X-Lumi-Site`
(`apps/cms/src/middleware/tenant.ts:29-43`); it does not confirm the site exists.
When an API key is rejected, `auditApiKeyUseDenied` writes the audit row under
that client-supplied site id (`apps/cms/src/middleware/auth.ts:93`), violating the
`lumibase_audit_log_site_id_lumibase_sites_id_fk` foreign key. Tracing further:
`AuditLogger.write` **does** catch failures on the synchronous insert path
(`logger.ts:485-490`); the crash comes from the **queue** path — the batcher
catches and then **`throw err`** (`worker.ts:139-141`) inside a fire-and-forget
flush ⇒ unhandled rejection ⇒ **the process dies**. The batch also groups several
sites into one insert, so one bad row **loses the audit records of valid sites**.
Reliably reproduced: a single request → 401 → `health` = 000.
⇒ `verify.mjs` keeps its cross-tenant probe behind
`LUMIBASE_VERIFY_CROSS_TENANT=1`; otherwise `cms:verify` would knock over the
user's own CMS.

### 9.2 Divergences from the original contract

- **Redis added to the compose file.** Without it the Docker runtime falls back
  to `127.0.0.1:6379` and floods the log with **506 ECONNREFUSED lines**, burying
  anything useful. With Redis: **0 errors**.
- **`LUMIBASE_REQUIRE_SETUP_TOKEN` dropped** — reasoning in §9.1(a).
- **`--template` validation added**: a misspelled template name used to reach
  `scaffold()` unchecked and die on ENOENT naming an internal path.
