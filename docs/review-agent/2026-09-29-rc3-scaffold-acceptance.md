# RC.3 scaffold clean-install acceptance (B95)

Date: 2026-09-29. Branch: `fix/b95-scaffold-rc3-pins`, based on `main` at `35bdd5d2`. Release under test: `1.0.0-rc.3`. Coordination: [#448](https://github.com/khuepm/LumiBase/issues/448), [#331](https://github.com/khuepm/LumiBase/issues/331). Follows [the RC.2 acceptance](./2026-09-26-rc2-acceptance.md), whose findings 1–3 are backlog B95–B97.

**Verdict: local acceptance passes after the fix on this branch, and two Studio bugs it found are fixed too.** The run used a tarball packed from the branch (`npm pack`), not the published package. The published `create-lumibase@1.0.0-rc.3` still has the old pins (see below), so a fresh `npx create-lumibase@next` only gets this result once the next release ships.

## Before the fix — the published RC.3 tarball

`npm pack create-lumibase@1.0.0-rc.3`, from the registry:

| File in the tarball | Value |
| --- | --- |
| `dist/templates/nextjs/docker-compose.yml` | `ghcr.io/khuepm/lumibase-cms@sha256:3f125caa…`, the `edge` build of `683a0270` (2026-09-11) |
| `dist/templates/nextjs/package.json.hbs` | `"lumibase": "^1.0.0-rc.1"` |

`683a0270` does not contain `fc778abc` (B96), `368e0e9a` (B97) or `4a830470`. A fresh `npm install` of `^1.0.0-rc.1` resolved **`1.0.0-rc.1`**, even though rc.2 and rc.3 are published. The `lumibase` dist-tags are `latest: 1.0.0-rc.1` and `next: 1.0.0-rc.3`, and npm takes the `latest` version whenever it satisfies the range (backlog B53).

The digest pin fell behind a release by construction. The digest only exists after the release that should have carried it.

## The fix

- `scaffold.ts` reads the scaffolder's own version and passes it to the templates as `lumibaseVersion`.
- The `nextjs` template renders `"lumibase": "<version>"` (exact) and `image: ghcr.io/khuepm/lumibase-cms:<version>`. The compose file became `docker-compose.yml.hbs`.
- The old reason for pinning a digest ("semver tags have no Studio") is no longer true. `ghcr.io/khuepm/lumibase-cms:1.0.0-rc.3` is `sha256:93687a55…`, labelled `revision=ede2f30e`, `version=1.0.0-rc.3`, and contains `/app/studio/index.html`.
- `cms:verify` now always probes a made-up site id, and re-checks `/health` afterwards. It accepts 401/403, or 404 only when the code is `TENANT_NOT_FOUND`.
- The README, `.env.example`, `bootstrap.mjs` and the compose comments no longer describe rc.1 bugs as current.

## Acceptance run

Node 24.14.0, npm, Docker (OrbStack). Scaffolded from the packed tarball into a scratch directory outside the checkout.

| Check | Result |
| --- | --- |
| `npx ./create-lumibase-1.0.0-rc.3.tgz b95site --template nextjs --pm npm --install` | Pass |
| Rendered `package.json` / `docker-compose.yml` | `"lumibase": "1.0.0-rc.3"` / `lumibase-cms:1.0.0-rc.3` |
| `package-lock.json` → `node_modules/lumibase` | `1.0.0-rc.3` |
| `cms:up`, `/health` | Up; `degraded` (storage/search not configured, as in RC.2) |
| `cms:bootstrap`, `cms:seed` | Pass; 3 posts created, one draft |
| `cms:verify` | Pass; other-site check skipped (no second site) |
| Made-up `X-Lumi-Site` (#469): the verify probe plus manual requests with and without the key | `404 TENANT_NOT_FOUND` each time; no container restart (`RestartCount 0`); health 200 |
| Setup-token gate (#470), separate stack with `LUMIBASE_REQUIRE_SETUP_TOKEN=1` | `SETUP_TOKEN=…` printed at startup; bootstrap using that token passed |
| `tsc --noEmit`, `next build` | Pass |
| Studio login at `/admin-a7f3c1` | Pass; footer shows `Studio v1.0.0-rc.3` |
| Studio → posts, direct reload of `/admin-a7f3c1/content/posts` (B96) | Prefix kept; "New item" links to `/admin-a7f3c1/content/posts/new` |
| New item → Create draft → Submit for review → Approve → Publish (B97) | Pass. Public site did not show the post before Publish, showed it after |

### Second pass: separate reviewer, other templates

- **`default` / `cloudflare` templates**: `node scripts/smoke-scaffold.mjs` passed 4/4. That covers both templates × npm and pnpm (install and typecheck). yarn and bun were not run.
- **Separate reviewer**:
  - Set `meta.requireSeparateReviewer = true` on `posts`.
  - Invited `reviewer@example.com`. With no mail server, the account was activated directly in the disposable database with the admin's fixture password, and given the Administrator role.
  - Over the API, the author's own approve got `409 SEPARATE_REVIEWER_REQUIRED` and the reviewer's approve passed.
  - In Studio, the author clicking Approve saw *"The reviewer must be different from the author."*
  - On the RC.3 image the reviewer then could not open the item. Studio showed "You do not have read permission" because `/permissions/me` answered 403 (B100, below).
  - On an image built from this branch (`lumibase-cms:b95-local`), the reviewer opened, approved and published in Studio. The publishable key then listed the post.
- **Preview**: the editor has no Preview action (Share creates a share link). This is a feature gap, not a regression; logged as B102 and not built here.

### Studio defects found by the run, fixed on this branch

1. **`body` opened in the JSON editor.** The starter created `body` as `{ type: 'text', interface: 'textarea' }`. Studio has no `textarea` interface and no `text` type alias, so the field fell through to `json-raw`, which rejected the prose with *"… is not valid JSON"*. Create draft then saved the item without `body`. Fixes:
   - Studio maps type `text` to the multi-line editor.
   - The starter uses `input-multiline`.
   - Re-running `cms:bootstrap` repairs a `textarea` field. It left the other fields unchanged, and a second run changed nothing.
2. **The editor stayed "unsaved" after Save.** `isDirty` compared `JSON.stringify(draft)` with the saved row. JSONB returns keys in its own order, so filling `body` in after `slug`/`title` left the form dirty. Submit for review and Publish stayed disabled with *"Save your changes first."* until a reload. The editor now uses an order-insensitive comparison (`lib/json-equal.ts`).

Both fixes were checked against the same CMS with the branch's Studio build mounted at `/app/studio`. After a body-last save, Studio showed "Saved" and both editorial buttons were enabled with no reload.

3. **Studio at the site root reloaded forever (B99).** Before sign-in, anonymous requests such as the UI translations answer 401. `handleUnauthorized` answered each one with `location.assign('/')`, the page it was already on, so the page reloaded until the API limiter answered 429. This first showed on the dev server, but any Studio served at the root is affected. The handler now redirects only when a stale token is present. That redirect clears the token, so the reloaded page's anonymous 401s stop there instead of repeating. On the dev server `/` then held steady on the "configured admin URL" notice, and `/admin-a7f3c1/login` rendered.
4. **Invited users were refused by `/permissions/me` (B100).** The control-plane backstop covers `/api/v1/permissions`. It only recognises a role literally named `admin`, and invited users carry their role **id**. As a result, every non-bootstrap user got 403 and Studio showed no read permission. `GET /permissions/me` returns only the caller's own bundle and is now open to any authenticated principal. The rest of `/permissions` stays admin-only. A broader mismatch remained: an invited Administrator was refused by every control-plane route (B101). It is fixed in the same PR. The backstop now also admits a signed-in **user** whose site bundle has `admin`, which is the check `requireSiteAdmin` makes. API keys, anonymous and `frontend`-audience sessions are excluded. Live results:

| Principal | Endpoint | Status |
| --- | --- | --- |
| Invited Administrator | `/roles`, `/users`, `/settings` | 200 |
| Editor (app access, no admin access) | `/roles` | 403 |
| Editor | `/permissions/me` | 200 |
| Editor | items (role grants nothing) | 403 |
| Publishable key | `/roles` | 403 |
| Anyone | invite with empty `roleId` | 400 |
5. **`POST /users/invite` accepted `roleId: ""`** and stored it as the membership role. A malformed body answered 500. Both now answer 400.

## Validation

- `create-lumibase`: 57 tests pass, including new ones for the version pin, the unknown-site probe and a bare-404 negative.
- `@lumibase/studio`: new `json-equal`, `interface-registry` and `api-unauthorized` suites pass, along with the rest of the suite (count in the PR).
- `@lumibase/cms`: new self-introspection cases in `control-plane-access-guard.test.ts` and `users-invite-validation.test.ts` pass. So do the existing guard wiring, auth matrix and MCP backstop suites.
- `turbo run typecheck` for both packages: pass.
- `docs/{en,vi}/getting-started.md` and `security/route-guards.md`: parity 0 problems, verify 0 findings, re-stamped `--verified`.

## Published-package acceptance (v1.0.0-rc.4)

Release run [36478335762](https://github.com/khuepm/LumiBase/actions/runs/36478335762):
- Attempt 1 failed in `Verify release tag` on a property test that found a real CDC cursor bug. The fix is [#497](https://github.com/khuepm/LumiBase/pull/497).
- Attempt 2 succeeded: GitHub prerelease, npm `next`, Docker image and image smoke test.
- The npm registry showed `create-lumibase@1.0.0-rc.4` about two minutes after the job had logged it as published.

The run below started from `npx create-lumibase@next`, whose `next` tag is `1.0.0-rc.4`, in a clean directory. The CMS image was `ghcr.io/khuepm/lumibase-cms:1.0.0-rc.4`, revision `4c2078d8`.

| Check | Result |
| --- | --- |
| Rendered pins | `"lumibase": "1.0.0-rc.4"`, `lumibase-cms:1.0.0-rc.4` |
| Lockfile `node_modules/lumibase` | `1.0.0-rc.4` |
| `cms:bootstrap`, `cms:seed` | Pass; `body` created as `input-multiline` |
| `cms:verify` | Pass, including the unknown-site probe (`404 TENANT_NOT_FOUND`, health after); other-site skipped |
| `tsc --noEmit`, `next build` | Pass |
| Invite with `roleId: ""` | 400 |
| Invited Administrator: `/roles`, `/users`, `/settings`, `/permissions/me` | 200 each |
| Invited Editor (no admin access): the same four | 403, 403, 403, 200 |
| `requireSeparateReviewer`: author approves own item | 409 `SEPARATE_REVIEWER_REQUIRED` |
| Invited Administrator approves, then publishes | `approved`, then `published`; the publishable key lists it |
| Studio `v1.0.0-rc.4`: new item, then body typed last and saved | Body uses the multi-line editor with no JSON error; "Saved", Submit for review and Publish enabled without a reload |

The invited accounts were activated directly in the disposable database, because the test stack has no mail server.

Still open, and out of this report's scope:
- `lumibase`'s own `latest` dist-tag still points at rc.1 (B53). The starter no longer depends on it, because the pin is exact.
- The preview feature (B102) is specified in [#496](https://github.com/khuepm/LumiBase/pull/496) and awaits review.
