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

The original draft proposed stable ids plus `onConflictDoNothing`, copying
`packages/database/scripts/seed-content-os-demo.ts:109,127,166`. That pattern
belongs to scripts that talk to the database directly; this seed goes through
the REST API, where `ON CONFLICT` is not available and item ids are
server-assigned.

**What is implemented:** each sample is looked up by its own slug before being
created —
`GET /api/v1/items/posts?filter={"slug":{"_eq":"…"}}&limit=1` — and created only
when absent. Idempotence is therefore by slug, not by id.

Looking the slug up server-side (rather than listing the collection and
searching the page that comes back) is what keeps it correct once the collection
outgrows one page; see §9.2. The filter spans both statuses, so an existing
draft counts as already-seeded, and existing content is never overwritten: the
script only ever creates what is missing.

The seed is site-scoped and runs **server-side**, with the admin token, never
from the browser.

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

`npm pack` packs whatever directory it runs in, so it must run **inside the
package** — from the repo root it would pack the root manifest instead and the
test would prove nothing. The artifact path is then passed absolutely, because
the install runs in a different directory:

```bash
# 1. build, then pack from the package directory itself
pnpm -F create-lumibase build
cd packages/create-lumibase && npm pack          # → create-lumibase-<version>.tgz
TARBALL="$PWD/create-lumibase-1.0.0-rc.1.tgz"    # absolute: install runs elsewhere

# 2. install it somewhere with no connection to this repo
cd "$(mktemp -d)"
npm init -y >/dev/null
npm i --ignore-scripts "$TARBALL"

# 3. confirm the artifact is the one just built, not a registry copy
node -p "require('create-lumibase/package.json').version"
ls node_modules/create-lumibase/dist/templates     # must list: nextjs

# 4. scaffold from it
./node_modules/.bin/create-lumibase my-site --template nextjs --pm npm --no-git
```

This exercises the `npm create` path. The second entrypoint needs a registry,
because `init` fetches `create-lumibase@<CLI version>` rather than resolving
anything locally (`packages/cli/src/commands/init.ts:20-45`), and the unit test
covering it mocks the runner. §5.4 proves it against a disposable one.

### 5.4 Proving `lumibase init` against a local registry

```bash
# 1. a disposable registry, proxying npmjs for everything else
npx verdaccio@6 --config conf/config.yaml --listen 4873
curl -X PUT -H 'content-type: application/json' \
  -d '{"name":"test","password":"test1234"}' \
  http://localhost:4873/-/user/org.couchdb.user:test     # → auth token

# 2. publish all three, with pnpm — `npm publish` does NOT rewrite
#    `workspace:*`, so a package published that way is uninstallable
cd packages/sdk            && pnpm publish --registry=http://localhost:4873 --tag latest --no-git-checks
cd ../cli                  && pnpm publish --registry=http://localhost:4873 --tag latest --no-git-checks
cd ../create-lumibase      && pnpm publish --registry=http://localhost:4873 --tag latest --no-git-checks

# 3. install the CLI from the registry, outside the monorepo
cd "$(mktemp -d)" && npm init -y
echo 'registry=http://localhost:4873' > .npmrc
npm i lumibase

# 4. the actual test — init must resolve the scaffolder holding the new template
rm -rf ~/.npm/_npx/*                     # npx caches by spec, not by registry
npm_config_registry=http://localhost:4873 \
  ./node_modules/.bin/lumibase init my-site --template nextjs --pm npm --no-git
```

Four things this surfaced that a plan on paper would not have:

- **`npm publish` leaves `workspace:*` in the manifest.** Only `pnpm publish`
  rewrites it to the real version. Published the wrong way, `lumibase` reaches
  the registry depending on `@lumibase/sdk@workspace:*`, which no client can
  resolve. §5.3's `npm pack` recipe is unaffected — it packs `create-lumibase`,
  which has no workspace dependencies — but the CLI must go through pnpm.
- **npx caches by package spec, not by registry.** A previous
  `create-lumibase@1.0.0-rc.1` fetched from npmjs is reused even after the
  registry changes, so the first run failed with ENOENT on the template
  directory — the public artifact, exactly as §2 describes. Clearing
  `~/.npm/_npx` is part of the procedure, not an aside.
- **`npm publish` also ignores `publishConfig` fields that pnpm applies.**
  Published with npm, `@lumibase/sdk` reached the registry with
  `types: "./src/index.ts"` — a path excluded from `files`, so it does not exist
  in the tarball. The install succeeds and only fails later, at `tsc`, with
  "Module 'lumibase' has no exported member 'createLumiClient'". Re-published
  with pnpm the field resolves to `./dist/index.d.ts` and typecheck passes. This
  is a release-mechanics hazard beyond this ticket: any publish of these
  packages must go through pnpm.
- **Verdaccio listens on IPv6.** It reports `http://localhost:4873`; probing
  `127.0.0.1` gets nothing.

Result: `lumibase init --template nextjs` scaffolds successfully; diffing its
output against `npm create lumibase` from the same registry shows **only the
project name**; and the generated project installs from that registry and
typechecks clean (`tsc --noEmit`, exit 0). The two entrypoints are equivalent in
practice, not merely by construction. See §9.5.

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

### 9.2 Review round 2 (`5187608588`) — five findings, all valid

Reviewed at `e3e97d00`; every finding was reproduced before fixing.

1. **[P1] The stack was published on every interface.** `"1989:1989"` publishes
   on `0.0.0.0` — Docker binds all interfaces unless a host IP is given. With the
   setup-token gate off and a fixed dev `JWT_SECRET`, anyone on the same network
   could claim the admin account, which contradicts the "binds to localhost"
   argument the README used to justify leaving the gate off. All three services
   now bind `127.0.0.1`; confirmed by `docker compose config` (`host_ip:
   127.0.0.1`) and by the running container's port table.

2. **[P2] `cms:verify` passed against a broken server.** `catch (err) { if
   (!(err instanceof CmsError)) throw err }` treated *any* HTTP failure as a
   successful denial, so a 500 read as "the guard worked". Reproduced with a
   fixture that answers 500: the old script reported the write and
   `status=draft` checks as ✔. Now only 401/403 count as a denial — plus 404
   where hiding a row *is* the refusal, which is how this CMS answers a filtered
   read (verified: same id → draft for the admin token, 404 for the publishable
   key, 200 for a published id). Anything else fails and prints the status;
   un-runnable checks report SKIPPED separately from the pass count.

3. **[P2] Bootstrap minted a key on every run.** Step 5 always POSTed a new
   publishable key, so a retry left extra live keys carrying read access with
   nothing to revoke them. It now reuses the existing key, rotates it when the
   local token is gone, and creates one only when none exists. Re-running twice
   leaves exactly one key with one role (verified). The role attachment is also
   checked first: `api_key_roles` has no ON CONFLICT clause and a
   `(api_key_id, role_id)` primary key, so re-posting the same pair errors rather
   than no-opping — my earlier "idempotent on the server" assumption was wrong.

4. **[P2] The seed could duplicate past 200 items.** It listed `limit=200` and
   searched that page, so a sample sitting on page two read as missing. Now each
   sample is looked up by its own slug with a server-side filter. Demonstrated on
   a 213-item collection: the old script recreated all three samples; the new one
   creates none, and `hello-lumibase` stays a single row.

5. **[P2] The onboarding screen asked for a token the stack never issues.**
   `app/page.tsx` still told users to copy `SETUP_TOKEN` out of the logs after
   the gate was disabled — the README and CLI next-steps had been updated, that
   page had not. It now names the real flow.

All five are pinned by tests in `nextjs-template.test.ts` (30 → 40).

### 9.3 Review round 3 (`c43ac32b`) — four findings, all valid

1. **[P1] The collection had no fields, so Studio could not edit anything.**
   `POST /api/v1/collections` validates with `collectionInputSchema`, which has
   no `fields` property (`apps/cms/src/routes/collections.ts:15,165`) — Zod
   stripped the array, the request returned 201, and the collection was created
   empty. Seeded items still saved because item validation accepts undeclared
   JSON keys, so nothing looked wrong until Studio rendered "No editable
   fields". The edit→publish→read loop this starter exists to demonstrate was
   never actually exercised; my earlier evidence had published through the API,
   not through the UI. Confirmed on a live instance: `GET
   /collections/posts/fields` returned 0.

   Fields are now provisioned through `PUT /collections/:name/fields/:field`
   (an upsert), reconciled on every run — including when the collection already
   exists — and verified afterwards, failing loudly if any field is missing.

   Fixing this surfaced a second, quieter bug in my own fix: I read existing
   fields from `GET /collections/:name`, which returns the collection row with
   **no `fields` key**, so the check was vacuous and re-PUT every field each
   run. It now reads `GET /collections/:name/fields`.

   Proven end to end in a browser: Studio shows "Edit item" with `title`,
   `slug` and `body`; editing the title and saving reports "Saved"; and the
   publishable key then reads the edited title while still not seeing the draft.

2. **[P2] A token in `.env` was trusted without being checked.** Any non-empty
   value counted as the key's token, so a revoked or externally rotated token
   was written back unchanged: bootstrap exited 0 while the website kept getting
   401, and rerunning could not recover. The token is now spent against the API
   the website uses, with the Origin the browser sends, before the reuse path is
   taken; 401/403 triggers rotation. Other failures bubble — a broken CMS must
   not read as "the token is fine". The freshly chosen token is re-checked after
   the role is attached, and bootstrap refuses to write a token it could not use.

3. **[P2] A display name did not establish ownership of a key.** Every
   generated project searched for the same `Website (publishable)` name, so a
   second site bootstrapped against the same CMS would select the first site's
   key and rotate it — breaking a live website while still not working itself,
   since rotation preserves the original origin allowlist. Ownership is now
   carried in the key's metadata as `starterOwner: lumibase-starter:<origin>`,
   with the origin as the natural key.

4. **[P2] The verifier accepted a malformed 200 as an empty draft list.**
   `asked?.data ?? []` treated an HTML error page or a changed envelope as "no
   drafts visible". Responses are now required to be a `{ data: [...] }`
   envelope before an empty result is read as proof.

   Per the reviewer's note that source-string assertions cannot catch this, the
   suite gained **behavioural tests** (`nextjs-scripts.behaviour.test.ts`) that
   run the real scripts against a stub CMS. Confirmed they catch the regression:
   against the pre-fix `verify.mjs` the two malformed-response tests fail and the
   output reads `✔ All checks passed` — the exact false pass reported.

Tests: 40 → 50.

### 9.4 Remaining acceptance items — closed

The six items left open by round 3:

1. **Spec §5.3 pack command** — rewritten. `npm pack` packs the directory it
   runs in, so the recipe now `cd`s into the package, captures an absolute
   tarball path (the install runs elsewhere), and verifies the installed
   artifact is the one just built (`dist/templates` must list `nextjs`). It also
   states plainly what the recipe does *not* prove: `lumibase init` resolves
   from the registry, and the unit test covering it mocks the runner, so proving
   that entrypoint needs a publish or a disposable local registry.

2. **Spec §4.2 wording** — corrected. It described stable ids plus
   `onConflictDoNothing`, which belongs to scripts talking to the database
   directly; this seed goes through the REST API, where `ON CONFLICT` is not
   available and ids are server-assigned. It now documents what is implemented:
   a per-slug lookup.

3. **Existing-CMS connect path** — documented in the starter's README (a
   "Connecting to a CMS you already run" section: the three `.env` values, and
   the four things the CMS administrator must provide) and surfaced in the setup
   screen. The fourth prerequisite is called out explicitly, because it is the
   one that bites: a collection with no declared fields still accepts and
   returns item JSON, so the website looks fine while Studio shows "No editable
   fields".

4. **Two-existing-sites isolation evidence** — obtained. A real second site
   (`site_tenant_b`) was created and the publishable key presented against it:
   **401, and the server stayed healthy across repeats**. That matters beyond
   the check itself — it shows #469 is triggered by *non-existent* site ids, not
   by cross-tenant access as such. The two probes are now separate: the real-site
   one (`LUMIBASE_VERIFY_OTHER_SITE`) is the isolation test and runs normally;
   the non-existent-id one stays behind `LUMIBASE_VERIFY_CROSS_TENANT=1` until
   #469 is fixed.

5. **`COLLECTION_EXISTS`** — confirmed rather than inferred. The service raises
   that code with 409 (`apps/cms/src/services/schema-service.ts:436`), verified
   against a live instance. Bootstrap now matches the code; any other 409/422 is
   a real failure and propagates instead of being mistaken for "already there".

6. **CHANGELOG + out-of-scope backlog** — added: an `[Unreleased] / Added` entry
   for the template, and backlog rows **B64** (#469) and **B65** (#470) pointing
   at the existing issues. No duplicate issues were created.

### 9.5 `lumibase init` proven against a local registry

Round 3 flagged that the mocked init-runner test is not evidence that both real
entrypoints resolve the new artifact. A disposable Verdaccio settles it.

| Step | Result |
|---|---|
| Publish `@lumibase/sdk`, `lumibase`, `create-lumibase` (pnpm) | ✔ all three, `workspace:*` rewritten to `1.0.0-rc.1` |
| `npm i lumibase` from that registry, outside the monorepo | ✔ 3 packages |
| `lumibase init my-site --template nextjs` | ✔ scaffolded |
| `diff` against `npm create lumibase` from the same registry | ✔ **only the project name differs** |
| `npm install` + `tsc --noEmit` in the generated project | ✔ exit 0 |

Two hazards this exposed, neither visible without actually publishing:

- **`npm publish` does not rewrite `workspace:*`**, so `lumibase` reached the
  registry depending on `@lumibase/sdk@workspace:*` — uninstallable. Only
  `pnpm publish` rewrites it.
- **`npm publish` ignores `publishConfig` fields pnpm applies**, so
  `@lumibase/sdk` published with `types: "./src/index.ts"` — a path not in
  `files`, so absent from the tarball. Installing succeeded; `tsc` then failed
  with "Module 'lumibase' has no exported member 'createLumiClient'". Both
  packages must be published with pnpm; §5.4 records this.

The first ENOENT run is worth keeping too: before the npx cache was cleared,
`lumibase init --template nextjs` failed exactly as §2 predicts for the public
artifact, which is the behaviour users see until `create-lumibase` is published
again. The release dependency in §2 is unchanged — this proves the mechanism,
not that the public registry already has the template.

### 9.6 Divergences from the original contract

- **Redis added to the compose file.** Without it the Docker runtime falls back
  to `127.0.0.1:6379` and floods the log with **506 ECONNREFUSED lines**, burying
  anything useful. With Redis: **0 errors**.
- **`LUMIBASE_REQUIRE_SETUP_TOKEN` dropped** — reasoning in §9.1(a).
- **`--template` validation added**: a misspelled template name used to reach
  `scaffold()` unchecked and die on ENOENT naming an internal path.
