---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:45:24.249Z
contentHash: ee3c803e9107939d
codeVerified: 2026-11-15T16:45:24.249Z
codeVerifiedHash: ee3c803e9107939d
codeVerifiedClaims: 10
---

# Supported Runtimes

This page is the support matrix for the runtimes and frameworks LumiBase runs on
or ships starters for: Node.js, the Cloudflare Workers runtime, PostgreSQL,
Redis, Next.js/React, and the browsers that run Studio. It also says how a
version joins the matrix, how it leaves, and how users are warned first.

Every number here comes from a file in the repository or from the upstream
project's published release schedule. Where the two meet, the repository wins: a
version is **supported** only if CI runs on it. Accepted-but-untested versions
are labelled **best effort**.

The [versioning policy](./versioning-policy.md) covers LumiBase's own releases.
This page covers what those releases run on.

## Support levels

| Level | Meaning |
|-------|---------|
| **Supported** | CI installs, typechecks and tests on it on every change. Bugs specific to it are release blockers. |
| **Best effort** | The declared ranges accept it, but CI does not run it. Reports are welcome; fixes are not guaranteed. |
| **Unsupported** | Outside the declared range. Tools warn or refuse to start (see [CLI notices](#cli-notices)). |

## Node.js

LumiBase supports **Node.js LTS lines only**. The range is declared once, in the
root `package.json`:

```json
"engines": { "node": "^22.22.2 || ^24.15.0 || >=26.0.0" }
```

The patch floors come from the toolchain, not from preference: jsdom 30 (Studio's
test environment) declares exactly this range, and nanoid 6 excludes the odd
majors. A lower 22.x or 24.x patch fails to install or test, so it is not offered.

| Line | Codename | Upstream status (2026-11) | Upstream end of life | LumiBase |
|------|----------|---------------------------|----------------------|----------|
| Node.js 22 | Jod | Maintenance LTS | 2027-04-30 | **Supported** from 22.22.2 — CI matrix, Docker image |
| Node.js 24 | Krypton | Maintenance LTS | 2028-04-30 | **Supported** from 24.15.0 — CI matrix, `.nvmrc`, main CI gate |
| Node.js 26 | Lithium | Active LTS since 2026-10-28 | 2029-04-30 | **Best effort** — accepted by `>=26.0.0`, not yet in the CI matrix |
| Node.js 23, 25 | — | End of life (odd, never LTS) | 2025-06-01, 2026-06-01 | **Unsupported** — CLIs warn |
| Node.js 27 | — | Alpha (release 2027-04-22, LTS 2027-10-20) | 2030-04-30 | **Best effort** until its LTS date |
| Node.js ≤ 21 | — | End of life | — | **Unsupported** — CLIs refuse to start |

Dates are from the Node.js Release Working Group's
[schedule](https://github.com/nodejs/Release#release-schedule).

**"LTS only", not "even majors only".** Up to Node.js 25, odd majors were never
LTS. Under the release schedule that starts with Node.js 27, every major becomes
LTS about six months after release, after a period as "Current". The rule
stays the same: a line enters **Supported** when it reaches Active LTS and CI runs
it. It never depends on whether the number is even.

### Where each line is used

- **Local development:** `.nvmrc` pins `24`, the same line as `NODE_VERSION` in
  `.github/workflows/ci.yml`, so "green on my machine" means green in CI.
- **Main CI gate:** `.github/workflows/ci.yml` runs on Node.js 24.
- **CI matrix:** `.github/workflows/runtime-matrix.yml` installs, typechecks and
  unit-tests the main packages (`@lumibase/cms`, `@lumibase/studio`,
  `@lumibase/sdk`, `@lumibase/runtime`, `@lumibase/database`, `lumibase`,
  `create-lumibase`) on Node.js 22 and Node.js 24.
- **Docker image:** `docker/Dockerfile` builds on `node:22-slim` and runs on
  `gcr.io/distroless/nodejs22-debian13`. Builder and runtime must name the
  same major.
- **Published CLIs:** `lumibase` and `create-lumibase` declare the same
  `engines.node` as the root and check it at startup.
- **`@lumibase/mcp-server`** keeps its own `>=18` range. That range is a
  contract with the consumers of the published package, not the repo's
  toolchain floor.

## Cloudflare Workers

Workers do not run a Node.js version. They run the `workerd` runtime at a pinned
**compatibility date**, and Cloudflare keeps old compatibility dates working.
The date is therefore a contract we move on purpose, never a floating value.

| Where | `compatibility_date` | Flags |
|-------|----------------------|-------|
| CMS (`apps/cms/wrangler.toml`) | `2024-10-01` | `nodejs_compat` |
| `create-lumibase --template cloudflare` | `2025-01-01` | `nodejs_compat` |
| Docs site (`apps/docs/wrangler.toml`) | `2026-06-01` | — |

Moving the CMS date is a reviewed change on its own. It must pass
`pnpm verify:worker-bundle` and `pnpm verify:worker-startup`, which boots the
Worker under `workerd`, and it is listed in the CHANGELOG. `wrangler` is the
`^4` line (root `package.json`).

## PostgreSQL

| Version | Upstream end of life | LumiBase |
|---------|----------------------|----------|
| PostgreSQL 16 | 2028-11-09 | **Supported** — CI (`postgres:16`), `docker/docker-compose.yml` (`postgres:16-alpine`), Render blueprint (`postgresMajorVersion: "16"`) |
| PostgreSQL 15 | 2027-11-11 | **Best effort** — the documented minimum in the deployment checklist |
| PostgreSQL 17, 18 | 2029-11-08, 2030-11-14 | **Best effort** — not run in CI |

Dates are from the PostgreSQL [versioning policy](https://www.postgresql.org/support/versioning/).
On Cloudflare, the CMS reaches Postgres through Hyperdrive. The same server
versions apply.

## Redis / Valkey

Redis is used by the Docker runtime (BullMQ queues, cache); a Docker production
install refuses to start without `REDIS_URL`. Workers do not use it.

| Server | LumiBase |
|--------|----------|
| Redis 7 | **Supported** — CI (`redis:7`), `docker/docker-compose.yml` (`redis:7-alpine`) |
| Valkey | **Best effort** — forked from Redis 7.2 and protocol-compatible, but not run in CI |
| Managed Redis/Key Value (Render, Fly, Railway templates) | **Best effort** — must run with `noeviction`, as the Render blueprint configures |

## Next.js and React

Next.js has its own [support policy](https://nextjs.org/support-policy): the
newest major is **Active LTS**, and the previous one is **Maintenance LTS**
(security and critical fixes) for two years after its release. As of 2026-11,
Next.js 16 (released 2025-10-21) is Active LTS and Next.js 15 is
Maintenance LTS. Upstream extended its security releases to 2027-01-31.

LumiBase follows that window: **current and current−1** are supported.

| Surface | Declares | LumiBase |
|---------|----------|----------|
| `create-lumibase --template nextjs` | `next` `^15.5.4`, `react`/`react-dom` `^19.2.0` | **Supported** on Next.js 15 and Next.js 16. CI scaffolds it, installs `next@^15` and `next@^16`, then typechecks and runs `next build` |
| `apps/consumer`, `apps/landing` | `next` `16.4.6` / `^16.4.6`, `react` `19.3.1` / `^19.3.1` | Internal apps, built by `pnpm build` in CI — current only |
| `examples/nextjs-blog`, `examples/nextjs-sensitive-content` | `next` `^15.5.19`, `react` `^18.3.0` | **Best effort** — outside the workspace, not run in CI |
| Studio (`apps/studio`) | `react` `^19.3.1` | React 19 only |
| `@lumibase/ui` | peer `react` `^18.3.1 \|\| ^19.0.0` | React 18 and 19 |

The SDK (`@lumibase/sdk`, re-exported by `lumibase`) has no framework
dependency. It works in any React or Next.js version that runs on a supported
Node.js line.

When upstream ships a new Next.js major, the matrix moves up one: the new major
becomes "current", the old current becomes "current−1", and the oldest one
leaves the matrix. The template's own `next` pin must always be one of the two
tested majors (`pnpm check:all` enforces this). Next.js 15 security releases
end on 2027-01-31, so the template default has to move to Next.js 16 before that
date.

## Browsers (Studio)

Studio is built with Vite 8 and uses Vite's default build target,
`baseline-widely-available`:

| Browser | Minimum |
|---------|---------|
| Chrome / Edge | 111 |
| Firefox | 114 |
| Safari (macOS and iOS) | 16.4 |

Older browsers are **unsupported**: the bundle uses syntax they cannot parse. The
desktop and mobile shells (`apps/shell`, Tauri) load the same build in the
platform webview, so the same floor applies.

## Pinned values

`scripts/check-runtime-matrix.mjs` (part of `pnpm check:all`, so it also runs in
the pre-commit hook and in CI) reads this table in both locales. It fails when a
value here disagrees with the repository, and when the repository disagrees with
itself:

| Key | Value |
|-----|-------|
| `.nvmrc` | `24` |
| `engines.node` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |
| `matrix.node` | `22`, `24` |
| `matrix.next` | `15`, `16` |
| `docker.builder` | `node:22-slim` |
| `docker.runtime` | `nodejs22-debian13` |

The check also enforces the following:

- The CI matrix's Node.js lines equal the bounded lines of `engines.node`.
- `.nvmrc` equals `NODE_VERSION` in `ci.yml` and is a matrix line.
- The Dockerfile's builder and runtime use the same major, and that major is a matrix line.
- Both published CLIs declare the root `engines.node`.
- The two copies of the CLI version check are identical.
- The Next.js template pins a tested major.

## CLI notices

`lumibase` and `create-lumibase` check the running Node.js version before they
load anything else. They take the range from their own `engines.node`, which
equals the root range above, so the check and the policy have one source:

- **Inside the range** — no output.
- **Below the lowest supported major (22)** — the command stops with exit code 1
  and a message that names the supported range and links to this page.
  Dependencies such as execa 10 cannot even load there.
- **At or above 22 but outside the range** (for example 22.12, 23.x or 25.x) —
  a warning on stderr, and the command continues.

## Dependency automation

Dependabot (`.github/dependabot.yml`) applies the policy to update PRs:

- **Docker:** Dependabot does not propose `node` image majors. A major is moved
  by hand together with the rest of the matrix. #803 bumped the builder to
  `node:25-slim`, a line that is not LTS and ships without corepack, while the
  distroless runtime stayed on Node.js 22. Digest and same-major tag updates
  still arrive weekly. The runtime image (`nodejs22-debian13`) carries its major
  in the image name, so Dependabot can never move it.
- **`@types/node`:** no major updates. A types major follows a change to the
  runtime matrix, never the other way round.
- **Next.js / React:** majors of `next`, `@next/*`, `eslint-config-next`,
  `react`, `react-dom`, `@types/react` and `@types/react-dom` arrive as **one**
  grouped PR (`framework-majors`), so the framework never lands half-migrated.
  Minor and patch updates stay in the weekly `minor-and-patch` group.

**Why Dependabot and not Renovate:** the repository already runs Dependabot for
npm, GitHub Actions and Docker, and the rules above (major ignores per
dependency, grouping by pattern and update type) are all available there.
Renovate would add a second bot and a GitHub App installation, and it would
make one more config that can drift. The one Renovate feature we would use,
an `allowedVersions` rule that knows which Node.js lines are LTS, is replaced by
the major ignore plus `check-runtime-matrix`. The check fails any PR, from a
bot or a person, that moves a Node.js major in one place only.

## Changing the matrix

### Adding a version

When a Node.js line reaches Active LTS (Node.js 26 did on 2026-10-28):

1. Add it to `matrix.node` in `.github/workflows/runtime-matrix.yml`.
2. Pin it as a bounded line in the root `engines.node` (for example
   `^26.x.y`), and copy the range to `packages/cli` and
   `packages/create-lumibase`.
3. Update the [pinned values](#pinned-values) table in both locales.
4. Run `pnpm check:all`, then let the matrix go green.

When a new Next.js major ships, replace the oldest entry of `matrix.next` with
it, then update this page and the template if its pin falls out of the matrix.

### Dropping a version

A version leaves the matrix when it reaches upstream end of life, or when a
dependency the product needs requires a newer one. Removing it from
`engines.node` is a **breaking change** under the
[versioning policy](./versioning-policy.md), so the following steps apply:

1. **Announce:** in a minor release, list the version under `Deprecated` in the
   CHANGELOG, mark it here with its removal release, and keep it in CI.
2. **Remove:** in the next major release at the earliest, drop it from
   `engines.node`, the CI matrix and this page in one PR. From then on the CLIs
   warn on it, or refuse it if it is below the new lowest major.

Upstream end of life does not wait for our release cycle. If a version reaches
end of life with no major release in between, it moves to **best effort** at
that date. It stays installable until the next major removes it, and security
fixes that need a newer runtime are documented as such.

### Moving the Docker image to another major

Change the builder `FROM node:<M>-slim` and the runtime
`FROM gcr.io/distroless/nodejs<M>-debian13` in the same PR, with fresh digests
for both, and update the [pinned values](#pinned-values). `<M>` must be a CI
matrix line. The release workflow's image smoke test then runs the image on the
new major.
