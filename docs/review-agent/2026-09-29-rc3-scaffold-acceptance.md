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

Separate reviewer role, Preview, pnpm/yarn/bun, and the `default`/`cloudflare` templates were not re-tested in this run.

### Studio defects found by the run, fixed on this branch

1. **`body` opened in the JSON editor.** The starter created `body` as `{ type: 'text', interface: 'textarea' }`. Studio has no `textarea` interface and no `text` type alias, so the field fell through to `json-raw`, which rejected the prose with *"… is not valid JSON"*. Create draft then saved the item without `body`. Fixes:
   - Studio maps type `text` to the multi-line editor.
   - The starter uses `input-multiline`.
   - Re-running `cms:bootstrap` repairs a `textarea` field. It left the other fields unchanged, and a second run changed nothing.
2. **The editor stayed "unsaved" after Save.** `isDirty` compared `JSON.stringify(draft)` with the saved row. JSONB returns keys in its own order, so filling `body` in after `slug`/`title` left the form dirty. Submit for review and Publish stayed disabled with *"Save your changes first."* until a reload. The editor now uses an order-insensitive comparison (`lib/json-equal.ts`).

Both fixes were checked against the same CMS with the branch's Studio build mounted at `/app/studio`. After a body-last save, Studio showed "Saved" and both editorial buttons were enabled with no reload.

Also found, not fixed: the Studio **dev** server, pointed at a CMS with a private admin prefix, reloaded in a loop until the API limiter answered 429 (backlog B99).

## Validation

- `create-lumibase`: 57 tests pass, including new ones for the version pin, the unknown-site probe and a bare-404 negative.
- `@lumibase/studio`: 411 tests pass, including new `json-equal` and `interface-registry` suites.
- `turbo run typecheck` for both packages: pass.
- `docs/{en,vi}/getting-started.md`: parity 0 problems, verify 0 findings, re-stamped `--verified`.

## Still required after release

Repeat the first table against the **published** `create-lumibase@next` once the next release ships, as B95 asks. This run only proves the tarball packed from this branch. Moving `lumibase`'s `latest` dist-tag is no longer needed for the starter, because the pin is exact. It is still a separate question for anyone who types `npm install lumibase` directly.
