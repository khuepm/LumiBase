# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase) · Website: [lumibase.dev](https://lumibase.dev)

## [Unreleased]

_No unreleased changes yet._

## [0.24.0] - 2026-07-21

### Version

- `v0.24.0`

### Date

- `2026-07-21`

### Highlights

- **Unified Tauri 2 desktop + mobile app.** A native shell (`@lumibase/shell`)
  wraps the Studio SPA for desktop (signed auto-update) and mobile (Android/iOS),
  with hybrid bundled/remote asset delivery. (#171)
- **More LLM providers + read-only MCP insights.** NVIDIA and Vertex AI join the
  provider set, and the MCP server gains its first read-only insights tools. (#273, #274)
- **Security & abuse hardening.** GraphQL query cost limits, a per-IP brake on
  setup-complete, prototype-pollution blocking on `deep[]` query aliases, and a
  tighter AI-harness capability classification. (#278, #280, #276)

### Added

- **Unified Tauri 2 desktop + mobile shell** (`apps/shell`, `@lumibase/shell`).
  Thin native wrapper around the Studio SPA: desktop builds add signed
  auto-update; mobile builds target Android/iOS. Hybrid delivery bundles
  `apps/studio/dist` for instant/offline load and probes the remote Studio
  deployment on release builds. Adds `shell-check.yml` (Rust `cargo check`,
  desktop + Android) and `release-apps.yml` (multi-platform signed bundles via
  `tauri-action`). (#171)
- **GraphQL query cost limit + setup-complete per-IP rate brake** (`cms`). (#278)
- **Read-only insights tools for the MCP server** (Wave 1). (#274)
- **NVIDIA + Vertex AI LLM providers**, plus a MeiliSearch-on-AWS guide. (#273)
- **Idempotency-keys spec** (requirements, design, tasks). (#281)

### Fixed

- **`ci`:** Exclude `@lumibase/shell` from the root `turbo run build`. The
  shell's `build` script is `tauri build`, so `pnpm build` in the CI `checks`
  job attempted to bundle the Tauri desktop app on a runner without native GTK
  libraries (`glib-2.0` / `gobject-2.0`). The shell's native build stays covered
  by `shell-check.yml` and `release-apps.yml`; `pnpm -F @lumibase/shell build`
  remains available for local desktop builds. (#285)
- **`item-service`:** Block prototype-pollution via `deep[]` query aliases. (#280)
- **`ai-harness`:** Classify `createCdcSubscription` / `replayCdcSubscription`
  as control-plane capabilities. (#276)
- **`docs`:** Stop doc pages 404ing after hydration. (#282)

### Notes

- Ongoing en/vi documentation translation sync.

### Migrations

- None

## [0.23.0] - 2026-07-14

### Version

- `v0.23.0`

### Date

- `2026-07-14`

### Highlights

- **License changed to Apache License, Version 2.0.** `v0.22.0` remains the
  final MIT-licensed release; see Changed below.
- **Git integration (GitHub / GitLab).** Per-site repository connections with
  PR/CI tracking, GitOps reconcile, and opt-in preview environments.
- **Change Feed: schema-change capture + long-poll, plus a documented API/SDK
  surface.**
- **Visitor / pageview counting** and **extension signing + verify-everywhere**
  land as first-party modules.

### Added

- **Git integration (GitHub / GitLab).** Per-site repository connections with
  GitHub App / GitLab App or OAuth/PAT auth (tokens encrypted at rest). Tracks
  pull requests + CI, stores CI logs for replay, posts a
  `lumibase/content-validation` commit status, runs GitOps reconcile of
  `lumibase/intents.json` into content intents, records commit↔content
  provenance, and provisions opt-in ephemeral preview environments per PR. New
  `git-sync` agent role with conservative L1 autonomy. Studio: **Settings →
  Integrations → Git repositories**. Migration `0009_git_integration` is additive
  (`CREATE TABLE IF NOT EXISTS`, tables prefixed `lumibase_git_*` per ADR-010) —
  no backfill needed. Registry row #70.

  Optional env: `GITHUB_CLIENT_ID/SECRET`, `GITHUB_APP_ID/PRIVATE_KEY` (PKCS#8),
  `GITLAB_CLIENT_ID/SECRET`, `LUMIBASE_PUBLIC_URL`. Requires existing
  `ENCRYPTION_KEY` to manage integrations.
- **Change Feed API contract + SDK.** `apps/cms/openapi.yaml` now documents
  every `/cdc/events` and `/cdc/subscriptions/*` endpoint (schemas
  `EventEnvelope`, `ChangeFeedSubscription`, `ChangeFeedDelivery`, …), and
  `@lumibase/sdk` ships typed command resources — `readCdcEvents`,
  `listCdcSubscriptions`, `createCdcSubscription`, `updateCdcSubscription`,
  `deleteCdcSubscription`, `ackCdcSubscription`, `replayCdcSubscription`,
  `dispatchCdcSubscription`, `listCdcSubscriptionDeliveries` — with the
  matching `Cdc*` result/input types.
- **Change Feed captures schema changes + long-polls.** The outbox gained a
  `resource` discriminator (migration `0008_cdc_resource_column`, default
  `item`), so collection/field DDL now emits `collections.*` / `fields.*`
  events alongside `items.*` (envelope `type` is `<plural-resource>.<operation>`;
  schema payloads are stored verbatim — masking stays item-only). `GET
  /cdc/events` accepts `?wait=<seconds>` (≤25) to long-poll: the server holds an
  empty first read until an event arrives, cutting idle polls. `settings.*`
  capture, realtime WS fan-out, consumer-group parallelism, inbound/two-way
  sync, and outbox partitioning are specced in `.kiro/specs/cdc-feed-roadmap/`.
- **Visitor / pageview counting (`lumibase-pageview-counter`).** Built-in
  pageview module with four per-site strategies (`db-rollup` default,
  `hot-counter`, `cdc`, `hll`), selectable via the `pageviews` settings key. Adds
  an atomic counter to the runtime (`CacheProvider.increment`; Redis `INCRBY` on
  Docker, a new `PageviewCounter` Durable Object on Cloudflare) plus a public
  beacon `POST /api/v1/pageviews/:site_id/hit` and authenticated
  `GET /api/v1/pageviews/stats`. Attribution is consent-gated (`analytics`) and
  privacy-preserving (salted visitor hash, never a raw IP). Counters flush to
  `lumibase_pageview_daily` every 5 minutes.
- **Extension signing + verify-everywhere.** Detached Ed25519 signatures are now
  verified at every install/load path (marketplace install, generic CRUD, the
  dynamic endpoint mount, hook dispatch) — official `lumibase-*` extensions are
  fail-closed. New `lumibase_publisher_keys` registry (DB overrides env for
  `official`/`revoked`), server-derived `isOfficial`, and a signing CLI
  (`@lumibase/extension-cli`: `keygen`/`sign`/`verify`). Official extensions with
  `autoInstall`/`enabledByDefault` are installed during setup / on site-create.

### Changed

- **Project license updated to the Apache License, Version 2.0 (from MIT),
  effective this release.** `v0.22.0` is the final MIT-licensed release; no
  further `0.22.x` patch will be issued under MIT. `LICENSE` and the
  publishable packages' `package.json` (`create-lumibase`, `@lumibase/sdk`,
  `@lumibase/mcp-server`, `@lumibase/extension-sdk`) now declare
  `Apache-2.0`.

### Fixed

- **Release Docker image could lose its arm64 variant.** `release.yml`
  (amd64-only, no QEMU) and `docker-publish.yml` (multi-arch) raced to push
  the same semver tag; the amd64-only build could win and clobber the
  multi-arch manifest (forcing Rosetta on Apple Silicon). `release.yml` now
  builds `linux/amd64,linux/arm64` via QEMU; `docker-publish.yml` only
  publishes `edge` from `main`, so semver/`latest` tags come solely from
  `release.yml`.

### Notes

- Docs: anti-abuse mechanisms & best practices guide, OpenAPI setup-endpoint
  documentation, and a data-import guide.

### Migrations

- `0008_cdc_resource_column`, `0009_git_integration`, `0010_pageviews`,
  `0011_extension_signing` — all additive (`CREATE TABLE IF NOT EXISTS` /
  `ADD COLUMN IF NOT EXISTS`, all defaulted). No data backfill required.

### Upgrade steps

- **Cloudflare only:** deploy the new `PAGEVIEW_COUNTER` Durable Object binding +
  DO migration `tag="v2"` (`new_sqlite_classes`) and the added `*/5 * * * *` cron
  trigger (already in `wrangler.toml` for every env). Missing the DO binding
  degrades `hot-counter`/`hll` to `db-rollup` (fail-soft).
- **For official extensions to verify on an existing instance:** set
  `MARKETPLACE_PUBLIC_KEYS` to include the official key (`lumibase-official-v1`)
  and run setup key-seed / a one-time reconcile. `LUMIBASE_EXT_SIGNATURE_POLICY`
  defaults to `require` (set `warn` to soften third-party enforcement).
- **For Git integration:** set `ENCRYPTION_KEY` (if not already) plus the
  provider env vars above to enable connecting repositories.

## [0.22.0] - 2026-07-12

### Version

- `v0.22.0`

### Date

- `2026-07-12`

### Highlights

- **CDC Change Feed (Phases A–H).** Outbox capture, pull API, dispatcher,
  extension integration, retention, and Studio surface — plus skills/MCP
  coverage. The change-data-capture pipeline lands end to end (#244).
- **Realtime studio co-editing, hardened.** A read-gated, filterable realtime
  plane: subscribe is permission-scoped and fail-closed, broadcasts are
  signal-only (no row data on the wire), and the item editor shows a live
  co-editing warning (#249).
- **Security hardening pass.** Settings writes admin-gated with secret reads
  redacted, external-JWT DoS guards + denial/issuer auditing, scheduled-release
  publishes now audited, and an out-of-scope findings backlog wired into the
  Definition of Done (#251).
- **v1 readiness groundwork.** Golden-path E2E gate + dependency-audit in CI,
  "Upgrading to 1.0" runbook, SECURITY.md, and the versioning policy — staging
  the remaining work before the v1.0.0 tag (#243, #239).

### Security

- **Realtime subscribe is read-gated and filterable.** A studio session could
  previously subscribe to any collection name and receive change signals for
  collections it had no `read` grant on (metadata leak: which collections
  change, when, and which item ids). The studio realtime ticket now embeds the
  collections the principal can `read` (computed by PermissionService at ticket
  issuance — admin bypass gets `*`), and the hub rejects any other `subscribe`
  with `SUBSCRIBE_FORBIDDEN`, fail-closed on a missing/empty allowlist. The
  `subscribe` message also accepts an optional Directus-style `filter`,
  evaluated server-side per subscription over the event envelope
  (`collection`/`action`/`itemId` — the wire is signal-only, so row data is
  never filterable or leakable).
- **Scheduled release publishes are now audited.** The scheduler sweep
  published due releases without writing any audit row — only manual publishes
  were recorded. The sweep now writes the same `release_published` /
  `release_partially_published` / `release_publish_failed` vocabulary
  (shared helpers, counts-only metadata) with `trigger: 'scheduled'`.

- **Realtime studio broadcasts are signal-only.** An item mutation used to
  fan out the full `row.data` to every studio session subscribed to the
  collection, without re-checking that session's read grant or field mask —
  a client could read row content (including masked fields) straight off the
  WebSocket. The broadcast now carries only the change signal
  (`collection`/`action`/`itemId`, `payload: null`); the Studio client
  re-fetches through the permission-enforced `/items` API, so field masking and
  row RBAC apply by construction and no row content crosses the wire.
- **External JWT auth: DoS guards + denial/issuer auditing.** The verifier now
  rejects an oversized bearer (`> 8192` chars) before parsing it and caps the
  role-claim list it resolves (`≤ 50`), bounding attacker-controlled parse/query
  work. Denied external authentications now write an `external_auth_denied`
  audit row (classification code only — never the token, claims, or reason), and
  issuer create/update/delete write `external_issuer_*` audit rows.

- **FK dependent-records now enforce the caller's RBAC.** The
  `POST /api/v1/items/:collection/:id/resolve-dependents` and
  `GET …/dependents` endpoints previously ran the batch `set_null` / `reassign`
  / `delete` and the preflight report without the caller's permission context —
  any authenticated tenant member could clear, reassign, or delete records in a
  collection they had no `update`/`delete` grant on, and read dependent ids they
  could not otherwise see. The resolve path now gates each action against
  `update`/`delete` on the dependent collection (403 `FORBIDDEN`), scopes batch
  writes to the caller's row-level grant, delegates deletes through a
  permission-carrying `ItemService`, and the preflight requires `read` on the
  target and only samples rows the caller may read. A source-independent
  tripwire (`dependents-service-rbac.test.ts`) locks the gate, and Definition of
  Done §2c gains a rule for request-path services that delegate to `ItemService`
  or write content tables directly. No schema or setup change.

- **`/api/v1/settings` writes are now admin-only.** `POST /api/v1/settings` and
  `DELETE /api/v1/settings/:key` were open to any authenticated site member,
  letting a non-admin overwrite arbitrary settings keys (including
  `upload_policy` and `media.signedTransform`) and bypass the admin gates on
  dedicated config endpoints. Both now require `requireSiteAdmin`; reads stay
  open because non-admin editors legitimately read keys like `locales`.
- **Settings reads redact secret-bearing fields.** `GET /api/v1/settings` and
  `/:key` previously returned raw values including secrets such as
  `media.signedTransform.secret`. Secret-named fields (secret/token/password/
  apiKey/…) are now redacted (`[redacted]`) on read for every caller; code that
  needs the real value reads it directly from the DB, not this HTTP endpoint.

### Performance

- **Trusted external-JWT issuers are cached.** `getTrustedIssuers` queried the
  DB on every bearer-token request; it now reads through `runtime.cache`
  (`auth:issuers:<siteId>`, TTL 60s) and issuer create/update/delete drop the
  key, so config changes apply within the TTL bound.

### Added

- **Change Feed (CDC Extension Integration).** First-party transactional
  outbox + relay over content mutations: `lumibase_cdc_change_events` /
  `_subscriptions` / `_deliveries` (migration `0007_cdc_change_feed`, RLS
  site-isolated), cursor-paginated `GET /api/v1/cdc/events`, HMAC-signed
  webhook dispatcher with retry/dead handling, sandboxed extension
  subscribers (`defineCdcSubscriber`, manifest capability
  `cdc:subscribe:<collection>`), retention + replay, Studio → Settings →
  Change Feed panel, five governed AI skills and MCP tools.
  **Upgrade note:** two new capability strings exist — `cdc:subscribe`
  (read the feed / ack) and `cdc:manage` (AI-skill subscription
  management). Admin roles satisfy them implicitly (`adminAccess`
  wildcard); grant them explicitly only for narrow integration tokens.
  `deleteCdcSubscription` is control-plane → HITL below autopilot.
  Feed is off-by-default per site (`cdc_feed.enabled` or first active
  subscription turns it on). No backfill: three new empty tables.
- **Registry-numbering tripwire (`pnpm registry:check`).** A CI check
  (`scripts/check-registry-numbering.mjs`, wired into the CI `checks` job) fails
  the build when the Setup Impact Registry `#` column contains a duplicate —
  mechanizing the Definition of Done §2 uniqueness rule per §6 ("cơ giới hóa"),
  replacing the manual `grep`.
- **Out-of-scope findings backlog + Definition of Done §7.** A single place
  (`.kiro/steering/out-of-scope-backlog.md`) to log vulnerabilities, bugs, and
  follow-up tasks discovered while working a PR but outside its scope, so they
  are not lost after merge. DoD §7 makes logging them a required review step.

### Fixed

- **`build-release-manifest.mjs` is now idempotent.** Regenerating
  `apps/docs/public/releases.json` on a plain `docs:build` no longer dirties the
  working tree: editorial fields (`migrationWarning`, `minimumSafeUpgradeVersion`)
  and `releaseDate` are preserved from the committed manifest unless explicitly
  overridden (env var, or a matching CHANGELOG heading for the date). This also
  fixes a latent bug where a deploy build could clobber a hand-set editorial
  value back to its default.

### Changed

- **Setup Impact Registry `#` column deduplicated.** Parallel branches had kept
  picking "the next number" independently, leaving many collisions (#16/#20/#21
  through #38). Colliding rows were renumbered to fresh ids (45–68), keeping the
  occurrence that other rows cite by number so cross-references stay valid.

### Migrations

- `0007_cdc_change_feed` — Change Feed outbox/capture tables (additive,
  idempotent). No destructive changes.

## [1.0.0] - 2026-07-11

### Version

- `v1.0.0`

### Date

- `2026-07-11`

### Highlights

- **First release under a semver stability guarantee.** `1.0.0` freezes the
  public surface — REST/GraphQL API, `@lumibase/sdk` exports, the
  `{ data, meta }` / `{ errors }` response format, header contracts
  (`X-Lumi-Site`…), environment variable names/semantics, and setup-wizard
  flags. From here, breaking changes are deferred to `2.0.0`; additive changes
  ship in minors and bug/security fixes in patches. See the versioning policy in
  the README.
- **Policies are the source of truth for access.** The role→policy migration
  reaches its stable shape: `admin_access`/`app_access` (plus `enforce_tfa`, IP
  guards, and time windows) are owned by policies. Legacy role flags remain as a
  compatibility fallback through 1.0 for rollback safety. A verified,
  idempotent backfill materializes legacy role flags into policies on upgrade.
- **Backward-compatible upgrade path from `0.6.x`.** Instances on `0.6.x`–
  `0.21.x` upgrade in place; the full "Upgrading to 1.0" runbook documents which
  sources go direct, which need an intermediate stop, and the pre-`0.17.0`
  re-import boundary. See Upgrade notes below.
- **Golden-path E2E gate in CI.** No tag ships on hand-verified flows: CI now
  drives setup wizard → create site → create collection → CRUD item → publish →
  read via the public API, with a two-site isolation check.

### Added

- **CI golden-path E2E gate.** A new `e2e-golden-path` job in
  `.github/workflows/ci.yml` exercises the end-to-end content lifecycle
  (setup → site → collection → item CRUD → publish → public read) plus
  cross-tenant isolation, on every PR and push to `main`. The v1 release
  criteria (§3) require this gate to be green before tagging.
- **"Upgrading to 1.0" operations runbook.** `docs/en/operations/upgrades.md`
  (VI mirror in `docs/vi/`) gains a version-specific section: a supported-source
  matrix, the RBAC role→policy backfill with its idempotent SQL and zero-row
  verification query, and rollback guidance. Surfaced under a new "Operations"
  docs category.

### Changed

- **RBAC access model finalized on policies.** Effective access continues to be
  computed as `role flags OR active policy flags` during the 1.0 compatibility
  window; the role flag columns are retained (not dropped) so rollback stays
  safe. They are scheduled to drop in a later release only after
  `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false` has shipped and been verified.

### Security

- No new advisories in this release. The v1 security audit
  (`docs/en/security/cwe-top-100-audit.md`) is the release gate: every
  Partial/Not-addressed CWE must be fixed or accepted-with-rationale before the
  `v1.0.0` tag. CWE-521 (password-policy alignment, `register` → 12-char
  minimum) is tracked as a required v1 fix.

### Upgrade notes

- **Read `docs/en/operations/upgrades.md` → "Upgrading to 1.0" before
  upgrading.** Summary:
  - `0.18.x`–`0.21.x` → direct, no manual data step.
  - `0.6.x`–`0.17.x` → direct, plus the RBAC role→policy backfill (run against
    staging, verify the post-check returns zero rows).
  - Before `0.17.0` (unprefixed tables) → **not an in-place upgrade**; export and
    re-import into a fresh `1.0.0` install.
  - Before `0.6.0` → upgrade to an intermediate `0.17.x`–`0.21.x` release first,
    verify, then upgrade to `1.0.0`.
- **No destructive schema change over `0.21.x`.** Application rollback to the
  previous `0.21.x` deployment remains compatible with the 1.0 database. The
  backfill is separately reversible during the compatibility window (delete the
  `legacy_role_flags_%` policies; role flags are untouched).

## [0.21.0] - 2026-07-08

### Version

- `v0.21.0`

### Date

- `2026-07-08`

### Highlights

- **Self-service auth realms (PR #130).** Subscriber registration, email
  verification, password recovery, rotating refresh tokens, per-realm session
  TTLs, and SDK silent auto-refresh — with server-side role resolution and
  audience-pinned tokens. See ADR-011 and the Security section below.
- **Cloudflare Pages deploys repaired.** The Pages pipeline had been failing
  since v0.18.0. The `apps/marketplace` submodule is now decoupled from the
  pnpm workspace and built standalone (authenticated with a PAT), the docs
  deploy verification matches the current prerendered-404 SPA design, and the
  release checkout no longer aborts on private sibling submodules. See Fixed.

### Added

- **Self-service auth realms.** Subscriber registration (`/auth/register`) with email verification (`/auth/verify-email`, `/auth/resend-verification`), password recovery (`/auth/forgot-password`, `/auth/reset-password`), and an admin primitive to grant subscribers `read` on collections (`/api/v1/users/subscriber-access`). Tokens carry a per-realm `aud` (`studio`/`frontend`); `withStudioAccess` hard-rejects frontend tokens. See ADR-011.
- **Per-realm session TTLs.** Separate access-token lifetimes for staff vs subscribers (`STUDIO_SESSION_TTL` `12h` / `FRONTEND_SESSION_TTL` `30d`).
- **Rotating refresh tokens** (new table `lumibase_refresh_tokens`, migration `0005`). Silent renewal via `/auth/refresh`, `/auth/logout`; one-time-use rotation with family-wide reuse detection; tokens stored only as sha256. Per-realm refresh TTL (`STUDIO_REFRESH_TTL` `30d` / `FRONTEND_REFRESH_TTL` `90d`). Delivered as an `httpOnly` cookie **and** in the body.
- **Cross-domain refresh cookie** config (`REFRESH_COOKIE_SAMESITE`/`REFRESH_COOKIE_DOMAIN`/`REFRESH_COOKIE_SECURE`) with a CSRF brake (`X-LumiBase-Refresh` header required for cookie-sourced refresh/logout).
- **Authenticated account self-service:** `POST /api/v1/me/change-password` and session management (`GET`/`DELETE /api/v1/me/sessions[/:id]`).
- **Hourly prune** of expired refresh tokens on the existing audit-rotation cron (Workers `scheduled` + Node `node-cron`).
- **SDK silent auto-refresh.** `createLumiClient` accepts `refreshToken` + `onTokensRefreshed`; a 401 transparently refreshes and retries once (parallel 401s coalesce into one refresh). Studio wires this end to end (login persists the refresh token, logout revokes it server-side).

### Security

- **Public `/auth/register` is safe by construction** (supersedes the admin-only stopgap from #190): the endpoint is intentionally unauthenticated self-service, but the role is resolved **server-side** to a zero-privilege `subscriber` (`appAccess=false`, `adminAccess=false`) — the request body can never choose a role — and the account starts `invited` until email verification. Per-IP rate-limited and anti-enumeration (uniform `202`).
- **Password change/reset kills every outstanding session:** both handlers stamp `users.password_changed_at` (migration `0006`), bump `tokenVersion` (so all prior access JWTs die immediately, CWE-613/620), and revoke all refresh tokens. A reset token whose `iat` predates `password_changed_at` is rejected → single-use reset links (review finding H1).
- **Global unique email** (review finding H3): unique index on `lower(email)` (migration `0006`) closes the check-then-insert registration race that could create duplicate accounts for one email; registration maps the constraint violation to the same generic `202`.
- **Atomic refresh-token rotation** (review finding M1): rotation claims the row with a conditional `UPDATE ... WHERE revoked_at IS NULL`, so two concurrent `/refresh` calls can no longer both succeed — the loser is treated as reuse and the family is revoked.
- **Session Bearer verifier pins audience** (review finding M5): `verifyCustomJwt` requires `aud ∈ {studio, frontend}`, so a single-purpose `email-verify`/`password-reset` JWT can never be replayed as a session token even if its claim shape changes.
- **`/auth/refresh` re-checks tenant membership + recomputes realm** (review finding M4): a user removed from the site, or whose role lost `appAccess`, no longer keeps minting stale-audience access tokens. Renewed access JWTs embed the current `tokenVersion`.
- **`lumibase_refresh_tokens` under RLS** (review finding M6): added to `rls-policies.sql` `site_isolation` alongside the other tenant tables.

### Notes

- Run `pnpm -F @lumibase/database migrate` to apply migrations `0005` (adds `lumibase_refresh_tokens`) and `0006` (adds `users.password_changed_at` **and** the unique `lower(email)` index). Migration `0006` fails if the `users` table already contains case-insensitive duplicate emails — de-duplicate first; see the migration header. No other backfill required.
- **Known limitations (tracked follow-ups, not fixed here):** per-IP rate limiting relies on `LUMIBASE_TRUSTED_PROXIES` being configured (and, off Cloudflare, a wired remote-address resolver) — the same limitation the login-guard already carries (review finding H2); refresh rotation grants a fresh TTL per hop with no absolute session cap (M2); the refresh cookie is one host-scoped name across tenants on a shared host (L2). See `docs/en/security/user-management.md`.

### Fixed

- **Cloudflare Pages deploys (broken since v0.18.0).** Four defects kept the
  Pages pipeline red:
  - `apps/marketplace` (a private `lumibase-ai/marketplace` submodule) is now
    **decoupled from the pnpm workspace** (`!apps/marketplace`) and built
    standalone (`pnpm install --no-frozen-lockfile --ignore-workspace`), so the
    root `--frozen-lockfile` install no longer breaks when the submodule is
    present. It is versioned/released independently and dropped from
    `version:sync`.
  - The submodule clone now authenticates with the `MARKETPLACE_SUBMODULE_TOKEN`
    PAT (the runner's `GITHUB_TOKEN` cannot read another org's repo).
  - `release.yml` no longer uses a blanket `submodules: true` checkout, which
    aborted on the private `enterprise`/`extensions` submodules; it inits only
    the marketplace path.
  - The docs deploy verification now asserts the current design — an unmatched
    deep-link serves the prerendered `404.html` SPA shell (HTTP 404 + shell
    body) — instead of the removed `/* /index.html 200` catch-all.

### Migrations

- `0005_refresh_tokens.sql` — adds `lumibase_refresh_tokens` (rotating refresh
  tokens, under RLS).
- `0006_password_changed_at_and_email_unique.sql` — adds
  `users.password_changed_at` and a unique index on `lower(email)`. **Fails if
  the `users` table already contains case-insensitive duplicate emails —
  de-duplicate first** (see the migration header). Apply with
  `pnpm -F @lumibase/database migrate`.

## [0.20.0] - 2026-07-08

### Version

- `v0.20.0`

### Date

- `2026-07-08`

### Highlights

- **Backend + SDK gap-closing across 7 specs.** Content-versioning,
  presets, Visual Flow Builder operations/triggers, translation-memory,
  image-transform, realtime, and insights now have matching HTTP routes and
  `@lumibase/sdk` client methods (see Added).
- **High-load & cache readiness.** Delivery API HTTP caching, opt-in list
  totals, request body-size limits, immediate permission-cache invalidation,
  debounced API-key `lastUsedAt`, and a process-cached setup-complete check.
- **Marketplace deploy fix.** The `apps/marketplace` submodule URL was
  rewritten from SSH to HTTPS so CI can clone it, unblocking the Cloudflare
  Pages `lumibase-marketplace` deploy that failed during the `v0.19.0` run.

### Added

- **Delivery API HTTP caching.** `GET /api/v1/deliver/page/:site_id/:slug`
  now emits `Cache-Control: public, s-maxage=…, stale-while-revalidate=…`,
  a weak `ETag`, and `Vary: X-Lumi-Site` for credential-less requests, and
  answers `If-None-Match` with `304` from a single content-fingerprint query
  (no section hydration). Requests carrying `Authorization` get
  `private, no-store`. Tunable via `LUMIBASE_DELIVER_SMAXAGE` (default 60)
  and `LUMIBASE_DELIVER_SWR` (default 300).
- **Opt-in list totals.** `GET /api/v1/items/:collection?meta=none` skips the
  `count(*)` aggregate and omits `meta.total` for cheaper feed/infinite-scroll
  reads. Default (`meta=total_count`) is unchanged; the `@lumibase/sdk`
  `readItems` gains a matching `meta` option.
- **Request body-size limits.** Caddy caps request bodies (10 MB API, 50 MB
  media uploads); the app also rejects oversized JSON bodies with `413`
  (`LUMIBASE_MAX_JSON_BODY`, default 1 MiB) as defense-in-depth.
- **Image-transform presets.** Shared `TransformDsl` contract in
  `@lumibase/shared`, a `lumibase_transform_presets` table, site-scoped
  `/api/v1/transform-presets` CRUD (media-permission gated), on-the-fly
  delivery transform via `GET /media/:key?preset=|?width=&…` (302 to the
  runtime image URL; no-param path unchanged), and an SDK `mediaUrl` builder.
- **Content-version, preset, and translation-memory SDK methods.** `versions`
  (list/create/get/update/delete/compare/promote), `presets`
  (getEffectivePreset/listBookmarks/saveUserView/create/update/deleteBookmark),
  and `tm` (listTm/upsertTm/updateTm/deleteTm/lookupTm/translate) matching the
  route contracts.
- **Preset resolution service.** `PresetService` with role-chain resolution
  (precedence user > role-chain > global, cycle-guarded) plus
  `GET /api/v1/presets/effective` and `/bookmarks`, with scope-ownership RBAC
  on write.
- **Flows operations registry & triggers.** `GET /api/v1/flows/operations`
  feeds the editor palette and graph validation; `validateGraph` is enforced
  on `POST`/`PATCH`; webhook trigger (`POST /:id/trigger`, constant-time
  token) with run detail (`GET /:id/runs/:runId`); and event-trigger dispatch
  matching item mutations to active event flows.
- **High-Load & Cache Readiness specification** (Phase 0–P2) added to the
  docs.

### Changed

- **Permission cache invalidation now takes effect immediately.** Compiled
  permission bundles are keyed by a per-site version pointer
  (`perm:{site}:v{n}:{principal}`); role/policy/permission/API-key/membership
  mutations bump the pointer so a revoked grant stops applying at once instead
  of lingering for the 60s TTL (which remains as a safety net). Fixes the
  previously dead `PermissionService.invalidate()`.
- **API-key `lastUsedAt` writes are debounced.** An API-key-authenticated
  request refreshes the last-used timestamp at most once per
  `LUMIBASE_APIKEY_TOUCH_INTERVAL` seconds (default 60), off the response path,
  instead of issuing an `UPDATE` on every request.
- **Setup-complete check is process-cached.** The per-request bootstrap-admin
  lookup in `requireSetupComplete` is cached (permanently once initialized,
  5s TTL while uninitialized), removing a DB round-trip from every
  authenticated request.

### Fixed

- **Marketplace Pages deploy.** Rewrote the `apps/marketplace` submodule URL
  from `git@github.com:` to `https://github.com/` so the release workflow can
  clone it on CI, and enabled submodule checkout for the Pages-apps job. This
  fixes the `ENOENT apps/marketplace/out` failure from the `v0.19.0` release
  run.

### Notes

- Added the `v1.0.0` release-criteria checklist under `.kiro/steering/`.
- Documentation index and English/Vietnamese i18n translations synced.

### Migrations

- `packages/database/drizzle/0004_transform_presets.sql` — creates the
  additive `lumibase_transform_presets` table (site-scoped, unique
  `(site_id, key)`). Backward-compatible; no data migration required.

## [0.19.0] - 2026-07-07

### Version

- `v0.19.0`

### Date

- `2026-07-07`

### Highlights

- **CWE Top 100 audit closed out.** The remaining 12 CWEs (of 78 applicable
  weaknesses) are now mitigated: credentialed CORS can no longer reflect a
  wildcard/arbitrary origin, the CDC fallback encryption key is gone (fails
  closed instead), AI-approval decide/reject is race-free, password strength
  is enforced uniformly, JWTs carry a revocable `token_version`, Cloudflare
  Access roles resolve from real site membership, a general per-principal API
  rate limiter is in place, and audit metadata redacts payload fields.
- **Visual Flow Builder triggers.** The flows engine now supports event
  (on content create/update/delete), schedule (5-field cron), and webhook
  triggers end to end, with a shared graph validator enforced on both the
  editor and the API; the Studio flow editor now persists the canonical graph
  (not raw ReactFlow shape) and drives its palette from the operation
  registry.
- **Marketplace community features.** Verified/trusted install badges,
  package download counting, idempotent upvotes, and a community submission +
  moderation flow.
- **Production routing fix.** The `v0.18.0` wildcard tenant route
  (`*.lumibase.dev/*`) was outranking Pages custom domains, breaking
  `docs.`, `studio.`, and `marketplace.lumibase.dev`; narrowed to
  `*.lumibase.dev/api/*` so Pages resolves everything else again.

### Added

- **Marketplace.** `feat(marketplace)` adds a `verified` badge (signature +
  publisher key + integrity hash, re-verified on install), download
  tracking (`GET /extensions/:slug/download`), idempotent upvoting
  (`POST`/`DELETE /extensions/:slug/vote`), and community submission +
  moderation (`POST /submit`, `GET /submissions`,
  `POST /submissions/:id/review`, gated by `extensions:configure`). The
  marketplace app has moved to a separate `lumibase-ai/marketplace` repo,
  mounted back in as a git submodule.
- **Visual Flow Builder — triggers (backend).** `feat(cms)` adds
  `GET /flows/operations` (operation registry as the palette/validation
  source of truth), a shared `validateGraph` gate on activate/patch
  (`GRAPH_DANGLING_EDGE` / `GRAPH_CYCLE` / `GRAPH_NO_ENTRY` /
  `GRAPH_UNKNOWN_OPERATION`), an event trigger fanned out from `ItemService`
  through a new `flow-events` queue, a dependency-free 5-field cron
  scheduler, and a webhook trigger authenticated by a per-flow token
  (constant-time comparison, credentials stripped from run input).
- **Visual Flow Builder — editor.** `feat(studio)` switches the flow editor
  to save/load the canonical graph shape (legacy ReactFlow graphs still
  load), drives the node palette from the operation registry (extension ops
  now appear automatically, via a new generic op node for undecorated
  operations), and surfaces `GRAPH_*` validation errors inline on the
  canvas.
- **Auto-deploy coalescing.** `feat(cms)` lets `DeploymentService.trigger`
  reuse an in-flight, same-target deployment within a configurable window
  instead of spawning one build per content event (manual triggers never
  coalesce); exposed as a `coalesceWindowMs` option on the `deploy:trigger`
  flow node.
- **Content-version SDK.** `feat(sdk)` adds
  `items(collection).versions.{list,create,get,update,delete,compare,promote}`
  with `ContentVersion`/`VersionCompare` types.
- **Dependency security gate.** Weekly Dependabot (npm + GitHub Actions,
  grouped minor/patch) and a CI `pnpm audit` job that fails the build on
  high/critical advisories.

### Changed

- **Enterprise app scaffold.** `apps/enterprise` is a standalone Hono Worker
  that depends on `@lumibase/*` packages as a one-way consumer (enterprise →
  core); it now lives in the private `lumibase-ai/enterprise-core` repo,
  mounted back in as a git submodule so its source is excluded from the
  public repo.

### Fixed

- **Production routing.** Scoped the tenant wildcard route from
  `*.lumibase.dev/*` to `*.lumibase.dev/api/*` — the broader pattern
  (shipped in v0.18.0 for free tenant subdomains) outranked every Pages
  custom domain on the zone and broke `docs.`/`studio.`/`marketplace.lumibase.dev`.
- **Security — SQL injection in materialize service (CWE-89).** Replaced
  `sql.raw()` string interpolation with Drizzle bind parameters and
  `sql.identifier()` for validated table names; the PL/pgSQL trigger body
  now fail-closes on embedded IDs that don't match a URL-safe pattern.
- **Security — observability disclosure (CWE-284/668).** `/health` now
  returns only overall status to anonymous callers (per-subsystem detail
  requires a valid `METRICS_TOKEN`), and `/metrics` enforces the token in
  every environment when configured (previously bypassed outside
  production).
- **Security — CORS (CWE-942).** `resolveCorsOrigin` no longer returns `*`
  or reflects an arbitrary origin with credentials; only an explicit
  `CORS_ALLOWED_ORIGINS` allowlist (or loopback outside production) is
  honored.
- **Security — CDC encryption key (CWE-321).** Removed the in-repo fallback
  encryption key; the CDC route factory now fails closed
  (`503 ENCRYPTION_KEY_MISSING`) when `ENCRYPTION_KEY` is unset.
- **Security — AI approval race (CWE-362/367).** Approval decide/reject is
  now atomic (conditional update + `.returning()`); a lost race surfaces as
  `409` instead of silently overwriting a concurrent decision.
- **Security — password policy (CWE-521).** A shared `PasswordSchema`
  (minimum 12 characters + complexity) is enforced uniformly at register,
  setup, and recovery, replacing an inconsistent `min(6)` at register.
- **Security — token revocation & Access roles (CWE-613/620/302).** JWTs now
  embed `token_version`; stale-versioned tokens are rejected, and the
  version bumps on password change/reset. Cloudflare Access identities now
  resolve to a real user + site-membership role instead of a hardcoded
  `admin` role.
- **Security — API rate limiting (CWE-400).** Added a general
  per-principal (user/API-key) or per-IP rate limiter on top of the
  existing auth/recovery limiters, configurable via `LUMIBASE_RATE_LIMIT_*`.
- **Security — audit log redaction (CWE-359).** The audit masker now
  redacts raw payload/content/body fields and truncates long free-form
  strings so item PII cannot land verbatim in the audit trail.
- **Security — dependency (GHSA-96hv-2xvq-fx4p).** Pinned `ws` to `>=8.21.0`
  via `pnpm.overrides` to close a high-severity DoS (memory exhaustion from
  tiny fragments), caught by the new audit gate on its first run.

### Notes

- A design spec for a Directus-style **Collection Preview** (iframe in the
  record editor, origin-allowlisted) was added under
  `.kiro/specs/` — no code shipped yet in this release.
- Routine dependency bumps: `react-dom`/`@types/react-dom`, `vitest` 3→4,
  `jsdom` 25→29, `tailwindcss` 3→4, `next` 15→16, `react-markdown` 9→10,
  `vite` 7→8, `@hono/node-server` 1→2, `eslint` 8→10, and several
  `actions/*` GitHub Actions version bumps.

### Migrations

- `0002_add_user_token_version.sql` — adds `lumibase_users.token_version`
  (default `0`, not null) for JWT revocation. Additive, idempotent.
- `0003_marketplace_votes_downloads.sql` — adds `lumibase_extension_votes`
  and three columns on `lumibase_extensions`
  (`download_count`/`submission_status`/`submitted_by`). Additive,
  idempotent; no RLS on the votes table by design (global, not site-scoped).

## [0.18.0] - 2026-07-06

### Version

- `v0.18.0`

### Date

- `2026-07-06`

### Highlights

- **Custom domains.** Sites can now provision their own custom domain via
  Cloudflare for SaaS — a new `site_domains` table, `client.domains` SDK
  resource, and a Studio Settings → Domains page cover request/verify/status
  end to end.
- **Translation Memory (TM).** The Studio content editor gains a translation
  mode with a TM suggest popover, backed by a new `tm.*` SDK namespace
  (`TmEntry`/`TmSuggestion`) for reusing prior translations across items.
- **Upload allowlist hardening.** Uploads are now governed by an
  admin-configurable, DB-backed allowlist with a picker UI, and the upload
  policy was extended to `/media` with tightened image/SVG validation.

### Added

- **Custom domain provisioning.** `feat(database)` adds `site_domains`;
  `feat(cms)` adds Cloudflare for SaaS-backed provisioning; `feat(shared,sdk)`
  adds domain schemas and the `client.domains` resource; `feat(studio)` adds
  the Domains settings page. Registered in the Setup Impact Registry (row 29).
- **Translation Memory UI.** `feat(sdk)` adds the `tm.*` namespace
  (`TmEntry`/`TmSuggestion` types); `feat(studio)` adds the suggest popover,
  translation mode, and a TM manager to the content editor.
- **AI crawler discoverability for docs.** Prerendered docs pages are now
  discoverable by AI crawlers.

### Changed

- **`/release` runbook.** Added Step 0 preflight & resume detection so a
  partially-completed release (version bumped but untagged, tag pushed but
  workflow incomplete, etc.) can be resumed from the correct step instead of
  re-run from scratch; the tag step now pins to the resolved release commit
  rather than assuming `HEAD`.

### Fixed

- **Docs hard-navigation.** Prerendered docs pages are now served directly on
  hard navigation instead of falling through the SPA catch-all rewrite.
- **Upload security.** Extended the upload policy to `/media` and hardened
  image/SVG upload validation.
- **Landing page.** Fixed a black square artifact around the section-header
  planet graphic on mobile.

### Migrations

- `0001_site_custom_domains.sql` — adds the `site_domains` table (additive,
  no breaking changes).

## [0.17.0] - 2026-07-03

### Version

- `v0.17.0`

### Date

- `2026-07-03`

### Highlights

- **`lumibase_` table namespace (breaking, fresh-install only).** Every system
  table is physically renamed to `lumibase_<name>` and the whole migration
  history is squashed into a single `0000_lumibase_init` — any table without
  the prefix is unambiguously user-created. The migrate runner refuses to run
  on a database carrying the pre-squash history, and collection names starting
  with `lumibase_`/`mat_` are rejected at the API.
- **Content Releases, external JWT auth, FK dependent-records, JSON field
  search, configurable save action** — the v0.14–v0.16 feature train lands on
  the new schema (their tables are prefixed and folded into the init).

### Changed

- **All system tables now carry a `lumibase_` prefix.** Every built-in table is
  named `lumibase_<name>` (e.g. `lumibase_users`, `lumibase_agent_runs`,
  `lumibase_releases`, `lumibase_push_subscriptions`) so the `lumibase_` namespace
  is reserved for the platform and any table without it is unambiguously
  user-created. Drizzle ORM code is unaffected (table `const` exports keep their
  names). See [ADR-010](docs/en/architecture/decisions/adr-010-lumibase-table-prefix.md).
- **Migration history squashed.** All legacy migrations (including the v0.14–v0.16
  additions: push subscriptions, content releases, save-default-preference,
  external-auth issuers) were collapsed into a single `0000_lumibase_init`
  generated from the schema; the schema now fully expresses the `shares` CHECK
  constraints and the `agent_approvals_veto_due_idx` partial index, and the
  Drizzle snapshots were regenerated clean (no drift).

### Fixed

- `rls-policies.sql`: fixed a pre-existing nested `$$` dollar-quote bug in the RLS
  `DO` block (the inner `CREATE POLICY` string now uses a `$pol$` tag) so the script
  applies via `psql` without a syntax error.

### Added

- **Content Releases.** Collate specific item revisions across collections into
  a named **Release** and publish them all at once — manually or scheduled for a
  date/time (à la Directus Releases). New `releases` + `release_items` tables and
  a `ReleaseService` exposed at `/api/v1/releases` (create / list / detail /
  patch / `:id/publish` / delete). Publish delegates to the item update path, so
  the editorial gate, validation, permissions and hooks all apply.
  `atomicityMode` is `all_or_nothing` (pre-flight all items, publish none if any
  is blocked) or `best_effort` (per-item outcomes). Scheduled releases publish
  via the shared `content-scheduler` tick (`sweepDueReleases`) — idempotent and
  `maintenanceWindow`-aware. Each `release_item` can pin a specific revision.
- **Configurable default save action.** The Studio content editor's post-save
  behavior is now configurable — `stay` (remain on the form), `return` (back to
  the list), or `create_new` — as a **per-user preference**
  (`users.preferences.saveAction`, set via the editor's split-button or
  `PATCH /api/v1/me/preferences`) that overrides a **site-wide default**
  (`sites.default_save_action`, set in Settings → Site). The hardcoded fallback
  is `stay`, matching the editor's previous behavior, so existing instances are
  unchanged until someone opts into another action.

- **External JWT authentication.** A site can trust JWTs issued by an external
  IdP (Okta, Entra, Auth0, Logto, Keycloak, Cloudflare Access…), verified against
  the issuer's public JWKS. New `auth_external_issuers` table + admin CRUD at
  `/api/v1/admin/auth/issuers`. The auth chain matches the token's `iss` to a
  trusted issuer for the site, verifies the signature + standard claims with the
  issuer's asymmetric-only algorithm allowlist, maps role claims to LumiBase
  roles (**default-deny** — never implicit admin), enforces a `siteId`-claim ==
  request-site gate, and optionally JIT-provisions the user. Fail-closed once an
  issuer matches; a token for an unknown issuer falls through to internal auth.

- **Foreign-key dependent-records handling.** Deleting an item that other records
  still reference (via a `restrict` relation) is now blocked with a structured
  **409 `DEPENDENT_RECORDS_EXIST`** instead of orphaning references. New
  `GET /api/v1/items/:collection/:id/dependents` (what references this item) and
  `POST …/resolve-dependents` (batch `set_null` / `delete` / `reassign`,
  transactional). The Studio editor shows a dialog to resolve each dependency
  group, then retries the delete. References live in JSONB so `onDelete` is
  enforced in the application layer — only `restrict` blocks; `set null`/`cascade`
  are never auto-applied on soft-delete. No schema migration (reuses `relations`).

- **Search inside JSON fields.** Item filters can now query **into** nested
  JSON/JSONB content. A dotted field key (`metadata.author.country`) addresses a
  nested path (compiled to `data #>> '{…}'`), and new operators `_json_contains`
  (`@>`), `_has_key`, `_has_any_keys`, `_has_all_keys` test JSON containment /
  key existence against the existing GIN index. Path segments are allow-listed
  (`[A-Za-z0-9_]`) and parameter-bound (injection-safe), with depth/clause
  limits. Purely additive — top-level keys and structural fields are unchanged;
  no schema migration. SDK `ItemFilterOp` exposes the new operators.

### Migrations

- **Breaking, fresh-install only — no upgrade path from a pre-prefix database.**
  The whole migration history — including this release's additions
  (`lumibase_releases` + `lumibase_release_items`, `lumibase_push_subscriptions`,
  `sites.default_save_action`, `lumibase_auth_external_issuers`) — is consolidated
  into the single `0000_lumibase_init`. Create the schema from scratch:
  `pnpm -F @lumibase/database migrate`, then apply
  `packages/database/migrations/rls-policies.sql`. An existing pre-prefix database
  must be dropped and recreated; for the Docker dev stack destroy the `pgdata`
  volume first:
  `docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d`.
  The migrate runner detects a database carrying the pre-squash migration history
  and refuses to apply (bypass with `FORCE_MIGRATE=true` at your own risk;
  `SKIP_MIGRATIONS=true` skips the boot-time migrate in Docker).

### Security

- **External JWT hardening:** see
  [docs/en/security/external-jwt-auth.md](docs/en/security/external-jwt-auth.md)
  for the threat model. `HS*`/`none` algorithms are rejected for external issuers
  (alg-confusion); raw tokens are never logged.

## [0.16.0] - 2026-07-03

### Version

- `v0.16.0`

### Date

- `2026-07-03`

### Highlights

- **Code-First Configuration (Config Manifest).** A site's schema configuration — collections, fields, relations, settings and webhooks — can now be exported, diffed and applied as a single declarative, version-controllable JSON manifest (`lumibase.config@v1`), enabling CI/CD and environment sync.
- **Auto-deploy from Flows.** New flow operations `deploy:trigger` and `deploy:status` complete the auto-deploy-on-content-change path promised by deployment integrations: an `event`-triggered Flow can deploy a target and branch on its status, with full provenance.
- **Security hardening.** Tenant membership is now enforced by middleware for user principals, dynamic extension dispatch is admin-gated again, `POST /auth/register` is fixed and fail-closed, and `/api/v1/flows` joins the control-plane backstop — all locked by a source-level tripwire suite.

### Breaking changes

- None. Collection names starting with `lumibase_` are now reserved (see Added), which only affects new create/rename attempts.

### Added

- **CMS / deployments:** Flow operations `deploy:trigger` and `deploy:status`,
  completing the auto-deploy-on-content-change path promised by deployment
  integrations (Req 5). A Flow with an `event` trigger can now deploy a target
  via `deploy:trigger` (`triggerSource='auto'`, linked to the flow run for
  provenance) and branch on `deploy:status`. Both reuse the shared
  `DeploymentService` — same encrypted-token, SSRF and audit guards as the
  manual API — and receive `db`/`siteId`/`keys`/`runId` from the flow run
  environment.
- **Code-First Configuration (Config Manifest).** Export / diff / apply a site's
  schema configuration — collections, fields, relations, settings and webhooks —
  as a single declarative, version-controllable JSON manifest
  (`lumibase.config@v1`) for CI/CD and environment sync. New admin-only endpoints
  `GET /api/v1/config/export` and `POST /api/v1/config/import` (with `dryRun`,
  `mode=merge|replace-managed|replace-all`, and an `allowDestructive` guard), plus
  a reworked `pnpm --filter @lumibase/cms config export|diff|apply` CLI (`diff`
  exits 1 when changes are pending, for use as a PR gate). Apply is transactional
  (all-or-nothing) and delegates schema mutation to the existing `SchemaService`;
  merge never deletes, replace-all is a full sync. Manifests carry no
  id/siteId/timestamps/secrets and round-trip losslessly. No schema migration —
  reuses existing tables. See
  [`docs/en/contributing/code-first-config.md`](docs/en/contributing/code-first-config.md).
- **CMS / schema:** the `lumibase_` collection name prefix is reserved for
  platform-owned tables (CDC/Firebase sync, internal config). Creating or
  renaming a collection to a `lumibase_*` name is rejected with `RESERVED_NAME`
  (HTTP 422). The guard lives in `SchemaService.ensureName`, so it applies
  uniformly to the schema builder routes and the AI harness `createCollection`
  skill; the collections route also validates early via Zod for client feedback.

### Changed

- **Definition of Done gains section 6 (DoD evolution):** a mandatory
  retrospective step — a bug fix must ask whether it should lock the whole error
  *class* with a tripwire, and a feature must ask whether it opens a new
  failure-mode/attack-surface warranting a new DoD rule; DoD changes land in the
  same PR. Makes the "learn from a bug, add a guard" loop (which produced 2b/2c)
  explicit instead of relying on reviewer memory.

### Security

- **Tenant membership enforcement** (ports open PR #184): new `withSiteMembership` middleware between `withAuth` and route handlers — a user principal must hold a `user_sites` membership for the site selected via `X-Lumi-Site`, closing cross-tenant access for authenticated principals. API keys stay site-matched by `withAuth`; local dev tokens, bootstrap users, and the Cloudflare Access admin flow keep their existing carve-outs.
- **Dynamic extension dispatch is admin-gated again** (ports open PR #152): restores the `adminOnly` guard on `extensionsRouter.all('/:name/*')` that a refactor had dropped, so non-admin principals can no longer execute endpoint extension bundles.
- **`POST /auth/register` fixed and fail-closed** (bug portion of open PR #130): the path was on the `withAuth` bypass list while the handler read the principal, so the route always crashed with 500; it now runs through the full auth chain, requires an admin principal (403 otherwise, even with no principal), and binds new users to the site's seeded `member` role id instead of the invalid literal `'member'` (an FK violation).
- **Flows are control-plane again:** `/api/v1/flows` is now in `CONTROL_PLANE_PATHS`
  so the admin-only backstop runs even if a flows route forgets its own guard —
  the same gap class as the historical `/api/v1/agent` omission, now that flow
  operations (`deploy:trigger`/`deploy:status`) mutate external deploy state. A
  tripwire assertion in `security-guards.wiring.test.ts` locks it.
- **Recurrence prevention:** source-level tripwire suite `apps/cms/src/__tests__/security-guards.wiring.test.ts` locks the guard-chain wiring, bypass lists, extension admin gate, and control-plane path coverage; new guide `docs/en/security/route-guards.md`; Definition of Done gains section 2c (route-guard security checklist).

### Notes

- **CI:** the Docker workflow now uses `env.NODE_VERSION` for `setup-node`, keeping the Node version consistent across CI workflows.

### Migrations

- None

## [0.15.0] - 2026-07-02

### Version

- `v0.15.0`

### Date

- `2026-07-02`

### Highlights

- **Realtime audience plane.** Realtime is now split into two planes: the existing admin/Studio plane and a new **audience plane** for end-user frontends. Frontends connect with short-lived audience tickets over a plane-aware WebSocket upgrade, subscribe to subject/channel addresses, and receive targeted fan-out from a plane-aware `SiteRoom`. A per-subject connection cap and audience shard resolver keep tenants isolated under load. A new `@lumibase/sdk` `AudienceClient` gives frontend apps a typed entry point, and a Node WebSocket hub backs the audience plane under the Docker dual deployment.
- **Cosmic design system.** The landing, marketplace, and docs surfaces adopt a shared cosmic design system — an orbital hero and product sections on landing, refreshed browse/detail pages on marketplace, and a cosmic dark theme for the docs viewer.
- **Security hardening.** `ItemService` construction is now funnelled through an RBAC-explicit factory so no call site can bypass permission context, and schema-admin routes are guarded against missing permission checks.

### Breaking changes

- None. All capabilities are additive.

### Added

- **Realtime / audience plane:** shared `audience-channels` protocol; runtime realtime provider abstraction (ADR-002); plane-aware `SiteRoom` with targeted fan-out; audience tickets + plane-aware WS upgrade; targeted publish via provider + notification inbox; Node WebSocket hub for the Docker dual deployment; per-subject connection cap + audience shard resolver.
- **SDK:** `AudienceClient` for frontend end-user realtime.
- **CMS:** admin backstop for control-plane skills on the MCP endpoint.

### Changed

- **Landing / marketplace / docs:** applied the cosmic design system — orbital hero and product sections (landing), browse and detail pages (marketplace), cosmic dark theme (docs viewer).
- **CMS:** `ItemService` construction routed through an RBAC-explicit factory.

### Fixed

- **CMS:** schema-admin routes now guarded against a missing permission check (regression test added).
- **Marketplace:** removed a no-op SEO self-replacement in `categoryLabel`.
- **SDK:** fixed strict-null handling in the `AudienceClient` test helper.

### Notes

- **Docs:** documented the audience plane and logged it in the Setup Impact registry; added English + Vietnamese runtime security guards reference docs (EN/VI parity); logged the `ItemService` RBAC guard as reviewed (n/a) in the Setup Impact registry.

### Migrations

- None

## [0.14.0] - 2026-07-02

### Version

- `v0.14.0`

### Date

- `2026-07-02`

### Highlights

- **Push notifications.** Operational agent events (HITL approvals, L3 veto-window stagings, agent incidents, run/goal status changes) now reach Studio operators over two transports: in-app realtime via the per-site `SiteRoom` Durable Object, and Web Push (VAPID, RFC 8291/8292) so operators are reached even with the tab closed. Both are best-effort and non-blocking; the Mission Control inbox poll remains the fallback. Includes a Settings → Notifications page (status, per-browser enable/disable, send-test) and a CLI connection tester.
- **Docs version badge.** The docs site header now shows the current release version, linking to that release's GitHub notes.
- **Path-traversal hardening.** Extends the prior items/collections/fields path-segment validation to every MCP tool that interpolates a dynamic segment into an API path — closing the same path-traversal / confused-deputy class across the shared CRUD factory, users/teams, API keys, access, agent, admin, relations, extensions, and settings tools.

### Breaking changes

- None. All capabilities are additive.

### Added

- **CMS / push notifications:** runtime-agnostic Web Push crypto (Web Crypto, no Node-only `web-push` dep); central `agent-notifications` broadcaster (in-app DO + Web Push fanout, prunes 404/410 endpoints); `SiteRoom` `notification` frame + publish path; `GET /api/v1/push/vapid-public-key`, `POST`/`DELETE /api/v1/push/subscriptions`, `GET /api/v1/push/status`, `POST /api/v1/push/test`; `push_subscriptions` table (migration `0039`) with RLS.
- **Studio:** push service worker + enrollment lib; notifications panel with realtime updates and enable/disable toggle; Settings → Notifications page (server status, per-browser controls, connect guide, send-test).
- **Tooling:** `apps/cms/scripts/push-test.mjs` CLI to verify a tenant's push connectivity without opening Studio; VAPID key generator script.
- **Docs:** version badge in the docs header (`__APP_VERSION__` build-time define); `features/push-notifications.md` guide with a Multi-tenancy section; `definition-of-done.md` gained a mandatory multi-tenant isolation checklist for new features.

### Changed

- **MCP server:** `registerCrud` and explicit endpoints across users-teams, api-keys, access, agent, admin, relations, extensions, and settings tools now validate ids/keys with `idPathSegmentSchema` and encode path segments; added `mediaKeySchema`/`encodeMediaKey` for multi-segment storage keys.

### Fixed

- **Security / mcp-server:** hardened tool path parameters and extended path hardening from items/collections/fields to all CRUD and explicit-endpoint tools (path-traversal / confused-deputy).
- **Security / mcp-server:** settings tools (`get_setting`, `upsert_setting`, `delete_setting`) switched from `encodeURIComponent` to `idPathSegmentSchema`, closing a residual traversal gap where `.`/`..` were not neutralized.

### Migrations

- **1 new schema migration (additive, idempotent):** `0039_push_subscriptions.sql` adds the site-isolated `push_subscriptions` table, guarded with `CREATE TABLE IF NOT EXISTS` so it re-runs safely and leaves existing installs untouched. RLS is applied via `packages/database/migrations/rls-policies.sql`. No data migration.
- Apply with `pnpm -F @lumibase/database db:migrate`.

## [0.13.0] - 2026-06-30

### Version

- `v0.13.0`

### Date

- `2026-06-30`

### Highlights

- **Deployment integrations.** Connect a site to Vercel, Netlify, or any HTTP deploy hook, then trigger and monitor deploys from Studio. Provider tokens are stored encrypted via the runtime `KeyProvider` (never plaintext), deploy targets and deployments are site-isolated with RLS, and incoming provider webhooks are signature-verified. Reuses the Flows/queue infrastructure with a status poller for in-flight deploys.
- **Cross-collection search.** Search now spans collections in a single query, with a reindex CLI, an SDK `search()` command (`SearchHit` / `SearchResponse` types), and a Vietnamese-aware analyzer. Studio gains a global command palette (Cmd/Ctrl+K).
- **Bracket-form filter params.** The items list route accepts bracket-form filter query params (e.g. `filter[field][_eq]=...`) end-to-end.

### Breaking changes

- None. All capabilities are additive.

### Added

- **CMS / deployments:** deployment-integrations service with Vercel, Netlify, and HTTP providers; encrypted token vault; status poller; webhook signature verification; two site-isolated tables with RLS.
- **CMS / search:** cross-collection search and a reindex CLI.
- **CMS / items:** accept bracket-form filter query params on the items list route.
- **SDK:** `search()` command plus `SearchHit` / `SearchResponse` types.
- **Studio:** Deployments settings page and a global command palette (Cmd/Ctrl+K) search.
- **AI skills:** deployment skills registered in the skill registry.
- **Docs:** deployment endpoints added to the OpenAPI spec; deployment-integrations feature guide; Next.js quickstart tutorial; EN/VI i18n CI workflow, contributing guide, and translation via Claude.

### Changed

- **Docs i18n:** translate with Claude instead of a third-party MT engine; sync EN/VI sources with version front matter.

### Fixed

- **Security / deployments:** verify provider webhook signatures and enable RLS on deployment tables.
- **Security / CMS:** guard agent-harness control-plane endpoints.
- **Security / Studio:** assert the studio client signal on agent API calls.

### Migrations

- **1 new schema migration (additive, idempotent):** `0038_deployment_integrations.sql` adds two site-isolated tables — `deployment_targets` and `deployments` — guarded with `CREATE TABLE IF NOT EXISTS` so it re-runs safely and leaves existing installs untouched. RLS for both tables is applied via `packages/database/migrations/rls-policies.sql`. No data migration. Back up your database before upgrading as a precaution.
- Apply with `pnpm -F @lumibase/database db:migrate`.

## [0.12.0] - 2026-06-28

### Version

- `v0.12.0`

### Date

- `2026-06-28`

### Highlights

- **Privacy & compliance suite.** A new data-rights toolkit covering consent management (GDPR Art. 7 / PDPD), a CCPA "Do-Not-Sell" `sale_share` consent type, personal-data export (GDPR Art. 15/20), account erasure / right-to-be-forgotten (GDPR Art. 17), data-retention pruning, restriction of processing (GDPR Art. 18), field-level data classification + redaction, and automated-decision transparency (GDPR Art. 22).
- **Email compliance.** One-click unsubscribe + a site-scoped suppression list (CAN-SPAM / ePrivacy) so suppressed recipients never receive commercial mail.
- **Directus-style Studio interfaces.** A broad set of new field interfaces — selection, hash, API autocomplete, presentation, relational drawer (create-new / add-existing), M2A builder, collection-item, field grouping with width layout, and map + tree-view interfaces.
- **Keyboard shortcuts.** A cross-platform keyboard-shortcuts system in Studio, plus Cmd/Ctrl+S save-and-stay in the webhook, email-template, and layout editors.
- **Tenant isolation hardening.** Media storage, search, and audit logs are now strictly scoped per tenant, closing cross-tenant exposure paths.
- **RBAC & security hardening.** Hardened permission evaluator, site-scoped CDC admin access, and secured CDC compose port bindings.

### Breaking changes

- None. All capabilities are additive.

### Added

- **CMS / data-rights:** consent management, `sale_share` (CCPA Do-Not-Sell) consent type, personal-data export, account erasure, data-retention pruning, restriction of processing, field data classification + redaction, and automated-decision transparency.
- **CMS / email:** unsubscribe endpoint + suppression list.
- **Studio:** Directus-style selection/hash/API-autocomplete/presentation interfaces, relational drawer, M2A builder, collection-item, field grouping + width layout + group interfaces, map and tree-view interfaces, API keys access page, cross-platform keyboard shortcuts, and Cmd/Ctrl+S save-and-stay editors.
- **Docs:** bilingual (EN/VI) user-rights & compliance documentation; data-map, data-residency, and DPA template; EN/VI i18n sync.

### Changed

- **RBAC:** hardened permission evaluator (added access-conflict property tests).
- **CI:** SPA deep-link 404 regressions are now caught at the Pages deploy gate.

### Fixed

- **Multi-tenancy:** scope media storage, search, and audit logs by tenant (cross-tenant exposure).
- **CDC:** bind CDC admin access to the selected site; secure CDC compose port bindings.
- **Auth:** initialize lazy GeoIP lookup before availability degradation in login anomaly checks.

### Migrations

- **3 new schema migrations (additive, idempotent):** `0035_user_consents.sql` (`user_consents`), `0036_email_suppressions.sql` (`email_suppressions`), and `0037_processing_restrictions.sql` (`processing_restrictions`), plus RLS policies for the new tables. New tables only — no data migration; `CREATE TABLE IF NOT EXISTS` lets them re-run safely. Back up your database before upgrading as a precaution.
- Apply with `pnpm -F @lumibase/database db:migrate`.

### Upgrade steps

1. Review the migrations above and back up your database.
2. Apply migrations: `pnpm -F @lumibase/database db:migrate`.
3. Deploy the `v0.12.0` image or Cloudflare Worker release.
4. Verify `/health`, the new data-rights/consent endpoints, the email unsubscribe flow, and that media, search, and audit logs return only the active site's data.

## [0.11.0] - 2026-06-22

### Version

- `v0.11.0`

### Date

- `2026-06-22`

### Highlights

- **Insights dashboards.** New `dashboards` + `panels` model and `/api/v1/insights` API with a Studio UI to compose metric/query panels per site.
- **Content versioning.** Named, parallel draft branches of an item (`content_versions`) with a content-version service and Studio management UI — diff/compare and promote without touching the live record.
- **Translation Memory management.** Backend + shared schemas + Studio UI to curate TM entries (review/edit/lookup) on top of the existing `/api/v1/tm` pipeline.
- **Tenant-scoped search.** Search is now isolated per tenant (per-site index names), the indexing queue is processed by a dedicated worker, and runtime exposes an index-settings API — closing cross-tenant search leakage.
- **Visual flow builder groundwork.** Shared `flow-graph` schema for the upcoming Studio flow builder.
- **Docs i18n.** EN/VI documentation sync tooling + CI workflow and MT engine.

### Breaking changes

- None. All capabilities are additive.

### Migrations

- **2 new schema migrations (additive, idempotent):** `0033_insights_dashboards.sql` (`dashboards`, `panels`) and `0034_content_versions.sql` (`content_versions`). New tables only — no data migration; `CREATE TABLE IF NOT EXISTS` + duplicate-object guards let them re-run safely. Back up your database before upgrading as a precaution.
- Apply with `pnpm -F @lumibase/database db:migrate`.

### Added

- **CMS:** `/api/v1/insights` (dashboards + panels), insights service; content-version service; tenant-scoped search (`search-document`, `content-indexing-worker`) + index settings API in `@lumibase/runtime`.
- **Shared:** `insights`, `translation`, `flow-graph`, and `diff` Zod schemas.
- **Studio:** UI for insights dashboards, content versions, and Translation Memory management.
- **Tooling:** EN/VI docs sync (`scripts/docs-i18n/*`) + `docs-i18n-sync` workflow; npm-publish enabled for `@lumibase/mcp-server`, `@lumibase/sdk`, `@lumibase/extension-sdk`.

### Changed

- Search index names are tenant-scoped; the indexing queue is drained by a worker rather than inline.

### Upgrade steps

1. Review the migrations above and back up your database.
2. Apply migrations: `pnpm -F @lumibase/database db:migrate`.
3. Deploy the `v0.11.0` image or Cloudflare Worker release.
4. Verify `/health`, the new `/api/v1/insights` endpoint, content-version + TM Studio pages, and that search returns only the active site's results.

### Rollback notes

- Roll back the application by redeploying the previously known-good CMS image tag (`v0.10.0`).
- The new tables are additive; rolling back the app does not require dropping them. Restore from the pre-migration backup only if you must reverse the schema.

## [0.10.0] - 2026-06-22

### Version

- `v0.10.0`

### Date

- `2026-06-22`

### Highlights

- **MCP is now the base surface for every feature.** Model Context Protocol coverage was expanded from collections/fields/items to the **entire** LumiBase Content OS, across both MCP surfaces:
  - **Standalone server (`@lumibase/mcp-server`)** — the published `lumibase-mcp` stdio server now exposes ~80 tools spanning relations, RBAC (roles, policies, permissions, API keys, bulk access export/import), users & teams, content intents, flows, webhooks, presets, settings, translations + translation memory, search, media (metadata), site activity/health/metrics, backup/restore, materialized collections, extensions, and the marketplace. Every destructive tool (`delete_*`, `revoke_*`, `remove_*`, `detach_*`, `restore_backup`, `rotate_api_key`, `apply_access_import`) requires an explicit `confirm: true`.
  - **Governed endpoint (`/api/v1/mcp`)** — new HITL/autonomy-gated skills for relations, RBAC roles/policies, content intents, flows, plus identity & config (API keys, users, teams, settings/translations/webhooks, extensions), executed through the existing `AISecureHarness` (kill switch → capability → autonomy L0–L4 → veto window → approval). Writes/deletes are forced dangerous; `deleteRole`, `deletePolicy`, `deleteRelation`, `revokeApiKey`, and `removeUser` are hard-capped at L2 (never autopilot).

### Added

- **MCP (standalone):** new tool modules — `relations`, `access` (roles/policies + bulk export/import/conflict checks), `api-keys`, `users-teams`, `content-config` (presets/settings/translations), `translation-memory`, `webhooks`, `agent` (intents/flows), `search-media`, `ops`, `admin` (backup/restore + materialize), `extensions` (+ marketplace). Shared `crudModule` factory + helpers; `tools/index.ts` aggregator; client gained generic `delete<T>`, root-text (`/health`, `/metrics`) and raw NDJSON (`backup`/`restore`) helpers; vitest test suite.
- **MCP (governed):** governed skills for relations, RBAC roles/policies, content intents and flows, plus identity & config — API keys (`listApiKeys`/`createApiKey`/`rotateApiKey`/`revokeApiKey`), users (`listUsers`/`inviteUser`/`updateUser`/`removeUser`), teams (`listTeams`/`createTeam`/`deleteTeam`/`addTeamMember`/`removeTeamMember`), config (settings/translations/webhooks list+CRUD), and extensions (`listExtensions`/`installExtension`/`updateExtension`/`uninstallExtension`). New thin `AccessService`/`ConfigService`/`ExtensionsService` and an extracted `api-key-token` util (reused by the REST route); `AISecureHarness` accepts `accessService`/`intentService`/`configService`/`extensionsService`/`db`/`siteId`; per-skill `dangerous` risk flag honoured by `evaluateRisk` + `ToolRegistryService`. Skill metadata mirrored in `@lumibase/ai-skills` with a registry-sync test.

- **npm distribution:** `@lumibase/sdk`, `@lumibase/extension-sdk`, `@lumibase/mcp-server`, and `create-lumibase` are now published to the public npm registry by the release pipeline (gated by the `PUBLISH_NPM_PACKAGES` repository variable and `NPM_TOKEN`). The `lumibase-mcp` CLI ships a `#!/usr/bin/env node` shebang so it runs via `npx`.

### Changed

- `SkillDefinition` gained an optional `dangerous` flag and `service` now includes `access`/`intents`/`flows`. `IRREVERSIBLE_SKILLS` extended with `deleteRole`/`deletePolicy`/`deleteRelation`/`revokeApiKey`/`removeUser`.
- Trimmed published package tarballs: `@lumibase/mcp-server` no longer ships source maps, and `create-lumibase` no longer ships a duplicate top-level `templates/` copy (templates resolve from `dist/templates/`).

### Notes

- NDJSON backup/restore, marketplace install/publish, and binary media remain **standalone-server-only** (`@lumibase/mcp-server`) — their bespoke crypto/SSRF/NDJSON logic is not duplicated into the governed harness. They are still fully usable via the standalone surface (RBAC enforced server-side).
- No schema migrations. Builds on `v0.9.0` (regulated/sensitive content readiness) and the `v0.5.0` Content OS foundation.

## [0.9.0] - 2026-06-21

### Version

- `v0.9.0`

### Date

- `2026-06-21`

### Highlights

- **Regulated / sensitive content readiness.** A generic, opt-in capability set
  for serving regulated/sensitive content (PHI/PII) on the existing CMS —
  defaults off, so Tier 1 behavior is unchanged. Field encryption is now
  **fail-closed** with AAD-bound, key-versioned ciphertext and a resumable rewrap
  worker; optional **envelope (per-record DEK) mode** enables crypto-shredding
  for GDPR erasure; new **field data classification** masks/gates `pii`/`phi`;
  plus **content scheduling**, an **editorial review → publish** workflow, **GDPR
  erasure / retention / SAR**, and **structured SEO/AIO delivery**.
- **Cloudflare production hardening.** The production CMS Worker now binds its
  real bindings (Hyperdrive, KV, R2, Queue); health probes are corrected for
  Cloudflare KV and cold connections; and the runtime tolerates missing search
  config and flat queue bindings on CF.
- **Security dependency bumps.** `@babel/core`, `dompurify`, `undici`, and
  `form-data` are pinned/overridden to resolve published GHSA advisories.

### Breaking changes

- None. New capabilities are additive and default off.

### Migrations

- **1 new schema migration (`0031_regulated_content_readiness.sql`)**: new tables
  `encryption_keys`, `field_access_log`, `content_reviews`, `erasure_requests`;
  new columns `items.publish_at`/`unpublish_at`/`editorial_state`/`dek_wrapped`
  and `fields.classification`.
- Additive and idempotent: new columns are nullable or defaulted and the
  migration is `IF NOT EXISTS`/duplicate-object guarded, so it re-runs safely and
  needs **no backfill**. Existing ciphertext reads unchanged via the `v0` path.
- Compatible DB/schema: `v0.8.0` schema state upgraded through
  `0031_regulated_content_readiness.sql`.
- Apply with `pnpm -F @lumibase/database db:migrate`.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists: `ghcr.io/khuepm/lumibase-cms:0.9.0`.
3. Take a backup (see Backup guidance — required for this schema migration).
4. Apply migrations: `pnpm -F @lumibase/database db:migrate`.
5. Deploy the `v0.9.0` image or Cloudflare Worker release.
6. Verify `/health` and `/ready`, the new `/api/v1/admin/encryption`,
   `/api/v1/editorial`, `/api/v1/admin/erasure`, `/api/v1/admin/field-access-log`,
   and `/api/v1/admin/sar/export` endpoints, the Studio **Settings → Encryption**
   page, and critical CMS workflows after deployment.
7. Regulated-content features ship **off**. Opt in per site by setting field
   `classification`, toggling `encryption.envelope` (step-up password), and
   enabling the editorial review workflow per collection.

### Rollback notes

- Roll back the application by redeploying the previously known-good CMS image
  tag (`v0.8.0`).
- The new tables/columns are additive; rolling back the app does not require
  dropping them. Records written under envelope mode remain decryptable as long
  as the KEK is retained. If you must reverse the schema, restore from the
  pre-migration backup.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.9.0`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.9.0` schema state (migration `0031` applied).
- Minimum supported database engine/version: use the version supported by the
  target deployment environment.

### Backup guidance

- **Backup required: Yes.** This release applies 1 additive schema migration and
  introduces field encryption / crypto-shred capabilities.
- Backup scope: database.
- Reason: new regulated-content tables and columns are added; a pre-migration
  backup is the supported rollback path, and the supported recovery path for
  envelope-mode key material.

### Added

- **Regulated / sensitive content readiness.** A generic, opt-in capability set
  for serving regulated/sensitive content (PHI/PII) on the existing CMS —
  defaults off, so Tier 1 behavior is unchanged. Spec:
  `.kiro/specs/regulated-content-readiness`.
  - **Field encryption hardening.** `decrypt` is now **fail-closed** (throws +
    audits `decryption_failed`, never a placeholder); AES-GCM ciphertext is
    AAD-bound to `siteId|collection|field|recordId`; ciphertext is key-versioned
    (`{keyId}:{body}`) with rotation + a resumable **rewrap worker**; a
    `KeyProvider`/KMS abstraction in `@lumibase/runtime` (Cloudflare Secrets/KV
    + Docker env/`*_FILE`) keeps key material out of business logic. Legacy
    unprefixed ciphertext still decrypts as `v0` (no-AAD).
  - **Envelope (per-record DEK) mode.** Optional per-record Data Encryption Key
    wrapped by the KEK (`items.dek_wrapped`), enabling **crypto-shredding** for
    GDPR erasure. Controlled by an operator **setting** (`encryption.envelope`),
    not a raw env var; changing it requires **step-up password auth** and runs a
    batched, resumable, idempotent **background migration**. Reads are
    self-describing from `dek_wrapped`, so records keep decrypting after the
    mode toggles (as long as the KEK remains).
  - **Field data classification.** New `fields.classification`
    (`none`/`internal`/`pii`/`phi`); `pii`/`phi` must be encrypted and are
    masked + gated by `read_decrypted`, with every decrypted read recorded in
    `field_access_log`.
  - **Content scheduling.** `items.publish_at`/`unpublish_at` + an idempotent
    reconcile worker; the delivery API respects the publish window.
  - **Editorial review → publish.** A human `content_reviews` workflow
    (`draft → in_review → approved → published`/`rejected`) with separate-reviewer
    sign-off, per-collection toggle, and audit — distinct from the AI veto-window.
  - **GDPR erasure / retention / SAR.** `erasure_requests` with dual-control and
    crypto-shred/hard-delete that **preserves** the tamper-evident `data_erased`
    audit (no cascade); a retention sweep; and a Subject Access Request export.
  - **Structured SEO/AIO delivery.** A `_seo` block (OpenGraph + JSON-LD), an SDK
    helper for Next.js `generateMetadata`, and a Tier 2 reference example.
  - **Studio.** Scheduling controls + a review queue, and a **Settings →
    Encryption** page to toggle envelope mode (step-up password + live migration
    status).
- New endpoints under `/api/v1/admin/encryption` (keys + envelope),
  `/api/v1/editorial`, `/api/v1/admin/erasure`, `/api/v1/admin/field-access-log`,
  and `/api/v1/admin/sar/export`. See `docs/en/api/hono-api-spec.md` §10b.

### Changed

- Envelope mode is governed by the `encryption.envelope` setting; the
  `LUMIBASE_ENVELOPE_ENCRYPTION` env var is no longer the hot-path control.
- **CMS:** wire production Cloudflare bindings (Hyperdrive, KV, R2, Queue) on the
  production Worker.
- Bumped all workspace package versions `0.8.0` → `0.9.0`.

### Fixed

- **CMS:** correct health probes for Cloudflare KV and cold connections.
- **Runtime:** tolerate missing search config and flat queue bindings on
  Cloudflare.
- **Landing:** inline CSS to remove a render-blocking stylesheet (`perf`); serve
  the static export preview via `python http.server`.

### Security

- **Dependency advisories resolved.** `@babel/core` bumped to `7.29.7`,
  `dompurify` to `>=3.4.11` (GHSA `ALLOWED_ATTR` prototype pollution), `undici`
  overridden to `^7.28.0`, and `form-data` pinned to `^4.0.6`.

### CI

- `ci(release)`: install with `--ignore-scripts` to avoid a native-build hang.

## [0.8.0] - 2026-06-18

### Version

- `v0.8.0`

### Date

- `2026-06-18`

### Highlights

- **GraphQL API surface.** New GraphQL Yoga endpoint for content items with nested m2o/o2m relation fields, subscriptions over the SiteRoom realtime channel, and production hardening (query depth limit + introspection guard).
- **Email module.** Generic `EmailService` with a render engine and template store, an email module API, a Studio settings UI, and teammate-invite emails.
- **Firebase sync module.** `lumibase-firebase-sync` mirrors item create/update/delete to Firestore + RTDB (new tables via migration `0029`).
- **Sentry error monitoring** wired into the Workers build.
- **Shared-domain environments.** New dev/staging/demo Worker environments, with branch/dispatch deploys routed to the matching env.
- **Production API reachable at `api.lumibase.dev`.** The production CMS Worker now binds the hostname via `custom_domain = true`, so `wrangler deploy --env production` creates and manages the proxied DNS record automatically — fixing the `v0.7.0` deploy that left `api.lumibase.dev` unresolvable (`NXDOMAIN`).

### Added

- **GraphQL:** Yoga surface for content items, nested m2o/o2m relations, subscriptions, depth limit + introspection guard.
- **Email:** `EmailService`, render engine, template store, module API, Studio settings UI, invite email.
- **Firebase sync:** `lumibase-firebase-sync` module + dispatch on item mutations; migration `0029`.
- **CMS:** Sentry error monitoring; dev/staging/demo shared-domain environments.
- **Studio:** auto-detect source extensions in dev; GitHub bug report template + Studio link.

### Fixed

- **CMS production routing.** Bind the production Worker to `api.lumibase.dev` via `custom_domain` so the API is served on its own origin, split from `studio.lumibase.dev`.
- **Pages custom domains** are now auto-attached by the deploy workflow.
- **GraphQL/types:** resolve TS lib-skew typecheck errors; loosen mock typing in schema-builder test.
- **Studio:** unbreak the production build of the dev-extensions vite plugin.
- **Email:** harden `htmlToText` against incomplete strip + double-unescape (char scanner instead of regex, per CodeQL).

## [0.7.0] - 2026-06-16

### Version

- `v0.7.0`

### Date

- `2026-06-16`

### Highlights

- **Site configuration surface.** Sites gain identity/branding/theme configuration end-to-end: new nullable/defaulted columns on `sites` (migration `0028`), `SiteConfig` Zod schemas, a `GET`/`PATCH /api/v1/site` endpoint, an SDK `site` namespace (`get`/`update`), and a Studio **Settings → Site** page with runtime theming.
- **Simple-setup step 2 redesign with teammate invites.** The simple-wizard step 2 replaces the 3-card role radio with a security-preset dropdown plus a docs link and a teammate-invite section; the final step gains a docs link.
- **Login-stall parity.** A `LOGIN_STALL_TIME` delay is applied to login failures, and `loginStallMs` is declared in the lockout-policy form schema (registered in the Setup Impact Registry).
- **Security hardening.** Extension execution is hardened (bundle-URL scheme validation, a 5s per-hook timeout, and render isolation via an error boundary), and Studio rich-text is sanitized to close stored/reflected XSS.

### Breaking changes

- None. New capabilities are additive.

### Migrations

- **1 new schema migration (`0028_site_configuration.sql`)** adding identity/branding/theme columns to `sites` (`display_title`, `site_url`, `descriptor`, `default_language`, `default_appearance`, `branding`, `theme_overrides`, `custom_css`, `updated_at`).
- Migration is additive and idempotent: every column is nullable or carries a default, existing rows backfill automatically, and `ADD COLUMN IF NOT EXISTS` guards let it re-run safely. No data migration is required.
- Compatible DB/schema: `v0.6.0` schema state upgraded through `0028_site_configuration.sql`.
- Apply with `pnpm -F @lumibase/database db:migrate`.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists: `ghcr.io/khuepm/lumibase-cms:0.7.0`.
3. Apply migrations: `pnpm -F @lumibase/database db:migrate`.
4. Deploy the `v0.7.0` image or Cloudflare Worker release.
5. Verify `/health` and `/ready`, the new `GET`/`PATCH /api/v1/site` endpoint, the Studio **Settings → Site** page, and critical CMS workflows after deployment.

### Rollback notes

- Roll back the application by redeploying the previously known-good CMS image tag (`v0.6.0`).
- The new `sites` columns are additive; rolling back the app does not require dropping them. If you must reverse the schema, restore from the pre-migration backup.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.7.0`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.7.0` schema state (migration `0028` applied).
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- **Backup required: Yes.** This release applies 1 additive schema migration.
- Backup scope: database.
- Reason: new columns are added to the `sites` table; a pre-migration backup is the supported rollback path if a reverse is needed.

### Added

- **Site configuration** across the stack:
  - `feat(database)`: site configuration columns on the `sites` table (migration `0028_site_configuration.sql`).
  - `feat(shared)`: `SiteConfig` Zod schemas.
  - `feat(cms)`: `GET`/`PATCH /api/v1/site` endpoint.
  - `feat(sdk)`: `site` namespace (`get`/`update`).
  - `feat(studio)`: **Settings → Site** page with runtime theming.
- **Simple-setup teammate invites.** `POST /api/v1/setup/complete` accepts an optional `invites[]` field (`{ email, role: 'admin' | 'member' }`, max 20) and returns `invitedCount`. Each invite becomes a `status='invited'` user bound to the default site via `user_sites` in the same transaction as the bootstrap admin (an invite failure rolls back the admin too). The RBAC Member role (`systemKey='member'`) is seeded idempotently only when a member invite is present, and each invite emits a best-effort `user_invited` audit event post-commit. Existing instances are unaffected.
- **Login-stall parity.** `LOGIN_STALL_TIME` delay applied to login failures, with `loginStallMs` declared in the Studio lockout-policy form schema.

### Security

- **Extension execution hardened** (`fix(extensions)`). The extensions route constrains `type` to a fixed enum and validates `bundleUrl` schemes (https/http/`data:text/javascript` only, rejecting `javascript:`/`file:`/`blob:`) at the API boundary; the hook dispatcher caps each handler at a 5s wall-clock budget (a before-hook timeout aborts the mutation; an after-hook timeout is logged); and the Studio extension loader wraps components in an error boundary so a crashing or hostile extension cannot take down the admin shell. The runtime `EXTENSION_BUNDLE_ORIGINS` allowlist remains the authoritative SSRF gate.
- **Rich-text XSS closed** (`fix(studio)`). Studio rich-text HTML is sanitized to close a stored/reflected XSS path.

### Fixed

- **Standalone Studio setup gate** (`fix(studio)`). Studio reaches the CMS cross-origin so a standalone deploy passes the setup gate.
- **Docs footer scroll** (`fix(docs)`). The footer scrolls with content on long pages instead of staying pinned to the viewport.

### Changed

- Bumped all workspace package versions `0.6.0` → `0.7.0`.
- `chore(create-lumibase)`: removed the `private` flag to allow npm publish.
- `chore(ci)`: bumped GitHub Actions to Node 24 runtime majors.

## [0.6.0] - 2026-06-13

### Version

- `v0.6.0`

### Date

- `2026-06-13`

### Added

- **Mission Control phase 3** (content-os-ui Req 16–20). Five Content OS endpoints that previously had no UI are now operable from Studio: an **Agents** sub-route managing the agent role library (CRUD, enabled toggle, two-step delete); intent detail gains **Scan now** (manual reconciliation cycle), inline **Edit** and two-step **Delete**; the goal tree gains planner **Decompose**/**Settle** actions; the Artifacts tab gains an **Evaluate** action with inline verdict; the trust ledger gains a **promotion eligibility check**.
- **Studio ops surfaces** (studio-ops-ui Req 1–3). Three more backend-without-UI gaps closed: **Settings → Materialized views** (create with auto/cron/manual strategy, per-row refresh, two-step drop), **Settings → Translation memory** (entry management plus fuzzy-lookup and translate-pipeline try-out panels), and a **Publish extension** dialog on the Marketplace page.
- **Mission Control rollout switchboard** (content-os-ui Req 15). The dashboard gains a "Rollout" panel to toggle the four per-site Content OS flags (`reconciler`, `vetoWindow`, `agentReview`, `mcp`) — previously only flippable by hand-crafting a `POST /api/v1/settings` call. Enabling a subsystem takes a two-step confirm (consistent with the kill-switch freeze confirm); disabling applies on the first click. Saves merge over the existing `contentOs` settings row so non-flag keys (e.g. `agentReviewMinConfidence`) survive a toggle.
- **Setup seeds Content OS state** (Setup Impact Registry G.1–G.3, G.5). The setup transaction now additionally:
  - seeds the 7-role agent library for the default site (previously lazy-seeded on first `GET /agent/roles`);
  - materialises the `contentOs` feature-flags settings row with every flag OFF;
  - creates explicit L1 (PROPOSE) autonomy grants for every seed (role, capability), attributed to the bootstrap admin with `evidence.source = 'setup_bootstrap'`;
  - persists the lockout policy to `settings.login_security_policy` under the `__default__` site (resolves open-question-8; the login guard already reads the row by key alone);
  - seeds "Baseline Constitution v1" as a **draft** (3 schema-safe rules, all report-only) so the publish-gate feature is discoverable in Mission Control — drafts have zero runtime effect until a human activates them.

### Security

- **esbuild bumped to 0.28.1** (Dependabot alert #46, high — missing binary integrity verification enabling RCE via `NPM_CONFIG_REGISTRY`). The pnpm override moves from `^0.25.12` to `^0.28.1`; vite is unified on `^7.3.5` across the workspace (studio, docs, and a matching override for vitest's internal copy) because vite 6 cannot drive esbuild 0.28's syntax lowering.
- **Flow execution SSRF hardened** (#104). The authenticated `http` flow operation now applies the SSRF guard (private/loopback/link-local ranges blocked, redirect re-validation), closing a server-side request forgery path through user-defined flows.
- **Signed file uploads hardened** (#103). Upload endpoints now verify the request is authenticated and the uploaded bytes match the declared type via magic-byte signature checks, closing an unauthenticated/spoofed-upload path.
- **AI approval authorization** (#101, #102). Executing a staged AI approval and the AI-approval management endpoints are now restricted to admins, preventing a lower-privileged caller from executing or mutating pending approvals.
- **Setup CPU-exhaustion guard** (#100, #105). Setup completion is gated before the expensive password-hashing step, so unauthenticated callers can no longer drive CPU exhaustion against the setup route.
- **Marketplace update feed constrained** (#99). Marketplace update checks are now scoped to global extensions, preventing a tenant from probing or pulling another tenant's extension state through the update feed.
- **Policy IP-guard evaluation preserved** (#96). Legacy RBAC policy IP guards are evaluated again after the policy rewrite, restoring IP-allowlist enforcement that had regressed.
- **Tenant-isolation hardening.** Studio access is enforced on management routes, share links are constrained to the creator's read access, extension item-access capabilities are gated, dev-only auth is restricted to development runtimes, and the backup-code redemption race is closed. The TLS Docker Compose overlay keeps the CMS private (not published on the host).
- **IDOR coverage.** Added the 8 cross-tenant IDOR isolation tests asserting that one site cannot read or mutate another site's resources.

### Fixed

- **SDK typegen docs** use a workspace-scoped command instead of an unscoped `npx` invocation.

### Upgrade steps

- **No new schema migrations in this release.** `0.6.0` is additive UI/ops surfaces over the `0.5.0` Content OS schema plus security hardening; existing `0.5.0` databases need no migration.
- **Existing (already-initialized) instances need no action.** Agent roles continue to lazy-seed on first list; an absent `contentOs` row still reads as all-OFF; autonomy resolution keeps its code fallbacks (safe→L2, dangerous→L1). Baseline L1 grants are intentionally **not** backfilled — doing so would tighten safe-capability autonomy from L2 to L1 on live sites. Opt in by creating grants via the trust ledger UI/API.

## [0.5.0] - 2026-06-12

### Version

- `v0.5.0`

### Date

- `2026-06-12`

### Highlights

- **Content OS — the AI-native redefinition of LumiBase.** This release reframes LumiBase from a *Content Management System* (a tool humans operate on content) to a *Content Operating System* (a runtime where agents operate content while humans set intent, taste, and accountability). See `docs/en/ai-native-vision.md`.
- **Intent-driven operation.** Content intents (declarative SLOs) describe the desired state of content — e.g. "every published `product` has ≥1 image, a 50–200 word description, and `vi`+`en` translations" — expressed via a rule schema with a backing service and API.
- **Reconciliation control loop.** Drift detection plus a reconciler continuously compares content against its declared SLOs, raises goals on drift, and lets agents converge content toward the desired state within a write budget — the Content OS control loop.
- **Earned-autonomy trust ledger (L0–L4).** Autonomy is earned, not granted: per (site, agent, capability) levels from Shadow → Propose → Co-sign → Veto-window → Autopilot, with data-driven promotion, automatic demotion on incidents, and a human-gated promotion engine. Includes the **L3 veto window** (staged commits auto-commit after T hours unless a human vetoes) and a **four-scope kill switch** with boundary enforcement.
- **Tenant Constitution.** Versioned, hashed publish-gate evaluators (rule DSL + LLM-judge) that every agent run pins to; artifacts that fail the constitution cannot publish regardless of autonomy level.
- **Provenance-first revisions.** Every revision records the agent/run/model that produced it, references, constitution hash, evaluation result, and approver. Item provenance is exposed on the Delivery API via `?provenance=true`.
- **Multi-agent newsroom organization.** A role library with planner delegation and narrow per-role capability grants (role ∩ grant), plus **agent-as-reviewer** — gated approvals with a self-review ban.
- **Studio Mission Control.** Exception inbox, trust ledger view, and kill-switch UI; per-field pin badges with a release action in the item editor.
- **Operational hardening.** Queue-backed async agent runs with cancel/resume, load-aware autonomy (coalescing, write budgets, backpressure), the MCP server adapter, and a public `llms.txt` per site.

### Breaking changes

- None at the API envelope level. New capabilities are additive. However, this release introduces new database tables and columns (see Migrations) and new feature flags governing Content OS behavior.

### Migrations

- **9 new schema migrations (`0019`–`0027`)** introducing Content OS tables and columns:
  - `0019_content_os_provenance_pins` — revision provenance + item pinned fields.
  - `0020_content_os_intents` — content intents (SLO) tables.
  - `0021_content_os_trust_ledger` — earned-autonomy trust ledger (L0–L4).
  - `0022_content_os_drifts` — drift records for the reconciliation loop.
  - `0023_content_os_veto_window` — staged-commit veto window.
  - `0024_content_os_kill_switch` — four-scope kill switch.
  - `0025_content_os_agent_org` — multi-agent role library / org.
  - `0026_content_os_agent_reviewer` — agent-as-reviewer approvals.
  - `0027_content_os_constitutions` — versioned tenant constitution evaluators.
- Apply with `pnpm -F @lumibase/database db:migrate`.
- Migrations are additive (new tables/columns); no destructive changes to existing tables.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. **Back up your database before migrating** (this release adds schema; see Backup guidance).
3. Apply migrations: `pnpm -F @lumibase/database db:migrate`.
4. Confirm the target Docker image tag exists: `ghcr.io/khuepm/lumibase-cms:0.5.0`.
5. Deploy the `v0.5.0` image or Cloudflare Worker release.
6. Verify `/health` and `/ready` plus critical CMS workflows after deployment.
7. Content OS features ship behind flags. Roll out gradually: start agents at **L0 (Shadow)** / **L1 (Propose)** per (site, capability) and promote via the trust ledger only after evaluation data supports it.

### Rollback notes

- Roll back the application by redeploying the previously known-good CMS image tag (`v0.4.7`).
- The new tables are additive; rolling back the app does not require dropping them. If you must reverse the schema, restore from the pre-migration backup.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.5.0`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.5.0` schema state (migrations `0019`–`0027` applied).
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- **Backup required: Yes.** This release applies 9 schema migrations.
- Backup scope: full database (all tenant data).
- Reason: new Content OS tables and columns are added; a pre-migration backup is the supported rollback path if a reverse is needed.

### Added

- **Content OS schema** (`packages/database/src/schema/content-os.ts`): intents, trust ledger, drifts, veto window, kill switch, agent org/roles, agent-reviewer, and constitutions; revision provenance + item pinned columns in `cms.ts`/`ai.ts`.
- **Content intents (SLO):** rule schema, service, and API for declaring desired content state.
- **Reconciliation loop:** drift detection and a reconciler that raises goals on drift and converges content within a write budget.
- **Trust ledger (L0–L4):** earned-autonomy levels per (site, agent, capability), a human-gated promotion engine, and automatic demotion on incidents.
- **L3 veto window:** dangerous actions execute into revision staging and commit after T hours unless vetoed (human-on-the-loop).
- **Kill switch:** four-scope stop with boundary enforcement.
- **Tenant constitution:** versioned, hashed publish-gate evaluators; agent runs pin to `constitutionHash`.
- **Provenance:** agent provenance stamped on revisions written via the harness; exposed on the Delivery API via `?provenance=true`; provenance round-trip property test.
- **Multi-agent organization:** role library, planner delegation, narrow per-role capability grants (role ∩ grant), and agent-as-reviewer gated approvals with a self-review ban.
- **Studio Mission Control:** exception inbox, trust ledger, and kill-switch UI; per-field pin badge with release action in the item editor.
- **Async agent runs:** queue-backed runs with cancel and resume.
- **Load-aware autonomy:** coalescing, write budgets, and backpressure.
- **MCP server adapter** and a public `llms.txt` per site.
- **Docs:** AI-native Content OS vision (`docs/en/ai-native-vision.md`), human control plane / two-plane mapping, and Content OS requirements/design/tasks spec.
- **Content OS rollout:** feature flags, metrics, and integration flows wiring the above together.

### Changed

- Refined Law Zero enforcement: human pins block agent writes.
- Bumped all workspace package versions `0.4.7` → `0.5.0`.

### Tested

- Security & tenancy invariants for Content OS services.
- DB-backed reconciliation cycle integration tests.
- Studio component tests for Mission Control panels.
- Provenance round-trip property test for revisions.

## [0.4.7] - 2026-06-11

### Version

- `v0.4.7`

### Date

- `2026-06-11`

### Highlights

- Prerendered `docs.lumibase.dev` to static HTML (SSG) at build time so AI crawlers and search engines receive real content instead of an empty SPA shell. The full React viewer (i18n, search, link-rewriting) is preserved via client hydration; 140 HTML pages (en + vi) are emitted with per-page title, meta description, canonical URL, and `TechArticle` JSON-LD.
- Added an optional Apache SkyWalking observability stack with a Node.js tracing bootstrap, metrics normalization, and refined health/ready checks.
- Completed AIO (AI Overviews Optimization) phase 1 on the landing site: `Organization` + `SoftwareApplication` + `FAQPage` + `BreadcrumbList` JSON-LD, canonical URLs, dynamic `og:image`, and a `/llms.txt` for AI crawler discovery.
- Added an MIT `LICENSE` file so the GitHub repository correctly reports `license: MIT`.

### Breaking changes

- None.

### Migrations

- No new database schema migrations.
- Compatible DB/schema: `v0.4.4` schema state.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.7`.
3. Deploy the `v0.4.7` image or Cloudflare Worker release.
4. Verify `/health` and `/ready` plus critical CMS workflows after deployment.
5. (Optional) To enable distributed tracing, start the SkyWalking stack with
   `docker compose -f docker/docker-compose.skywalking.yml up -d` and set the
   tracing env vars documented in `docker/.env.example`.

### Rollback notes

- Roll back by redeploying the previously known-good CMS image tag (`v0.4.6`).
- No database/schema restore is required.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.7`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.4.4` schema state.
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- Backup required: No.
- Backup scope: none.
- Reason: this release adds documentation prerendering, optional observability tooling, AIO metadata, and a license file; it does not modify runtime data or schema state.

### Added

- Prerender pipeline for `apps/docs`: `scripts/prerender.mjs` emits static HTML for every doc route (en + vi), `entry-server.tsx` renders via the static router with `getAllPaths()`, and shared `routes.tsx` is consumed by both `createBrowserRouter` (client) and `createStaticHandler` (prerender).
- Client hydration in `apps/docs/src/main.tsx`: `hydrateRoot` over prerendered markup with a `createRoot` SPA fallback.
- Optional SkyWalking observability stack: `docker/docker-compose.skywalking.yml`, Node tracing bootstrap (`apps/cms/src/observability/node.ts`, `config.ts`), tracing middleware (`apps/cms/src/middleware/tracing.ts`), and related env vars in `docker/.env.example`.
- MIT `LICENSE` file at the repository root.
- AIO assets on the landing site: JSON-LD schema (`Organization`, `SoftwareApplication`, `FAQPage`, `BreadcrumbList`), canonical URLs + `metadataBase`, dynamic `opengraph-image` (1200×630), and `public/llms.txt`.
- `docs/en/aio/AIO-AUDIT-REPORT.md` and `docs/en/aio/README.md` documenting the AIO findings and roadmap.

### Changed

- Normalized CMS metrics output and refined the `/health` and `/ready` route behavior.
- Renamed GEO → AIO (AI Overviews Optimization) across the documentation.
- Updated the landing sitemap to include `/pricing` with realistic `lastmod` dates and removed an unverified social-proof claim.
- Bumped all workspace package versions `0.4.6` → `0.4.7`.

## [0.4.6] - 2026-06-10

### Version

- `v0.4.6`

### Date

- `2026-06-10`

### Highlights

- Introduced `create-lumibase` — a new publishable npm package that scaffolds a brand-new LumiBase project with a single command (`npm create lumibase@latest my-project`), the same way `create-next-app` or `create-vite` bootstrap their stacks.
- Ships two bundled, ready-to-run templates: `default` (Hono + Node.js + PostgreSQL + Redis via Docker Compose) and `cloudflare` (Hono + Cloudflare Workers + D1).
- The `default` template includes a working `posts` resource demonstrating LumiBase conventions (`nanoid()` IDs, `site_id` multi-tenancy, `{ data }` / `{ errors }` envelope, Zod validation) and a full Drizzle ORM layer with generate/migrate scripts.
- Added a Getting Started guide and a package README documenting the full scaffold flow from an empty directory to a running server.

### Breaking changes

- None.

### Migrations

- No new database schema migrations.
- Compatible DB/schema: `v0.4.4` schema state.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.6`.
3. Deploy the `v0.4.6` image or Cloudflare Worker release.
4. Verify `/health` and critical CMS workflows after deployment.
5. To scaffold a new project, run `npm create lumibase@latest <name>` (no global install required).

### Rollback notes

- Roll back by redeploying the previously known-good CMS image tag (`v0.4.5`).
- No database/schema restore is required.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.6`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.4.4` schema state.
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- Backup required: No.
- Backup scope: none.
- Reason: this release adds a standalone project scaffolder and does not modify runtime data or schema state.

### Added

- Added `create-lumibase` package (`packages/create-lumibase/`) — a Node.js ESM CLI publishable as `create-lumibase` on npm. Invoke via `npm create lumibase@latest <name>`, `npx create-lumibase@latest <name>`, or `pnpm create lumibase <name>`.
- Added an interactive prompt flow: project name (validated against npm package-name rules), deployment target, package manager, install dependencies, and git init.
- Added two bundled templates: `default` (Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml`) and `cloudflare` (Hono, Drizzle ORM, D1, `wrangler.toml`).
- Added a Handlebars-based scaffold engine that renders `.hbs` template files and applies a rename map for dotfiles (`_gitignore` → `.gitignore`, `_env.example` → `.env.example`, `_npmrc` → `.npmrc`).
- Added a Drizzle DB layer to the `default` template: `src/db/schema.ts` (a `posts` table using `nanoid()` IDs, a `site_id` column, and timestamps), `src/db/client.ts`, `src/db/migrate.ts`, and `drizzle.config.ts`.
- Added a demo `posts` resource (`GET`/`POST /posts`) to the `default` server template using the `{ data }` / `{ errors }` response format and Zod request validation.
- Added non-interactive flags for CI/scripting: `--template`, `--pm`, `--install` / `--no-install`, `--git` / `--no-git`, and `DEBUG=1` for verbose output.
- Added package-manager auto-detection from the `npm_config_user_agent` environment variable (pnpm / npm / yarn / bun), a TTY-aware spinner, and a zero-dependency argument parser.
- Added Vitest unit tests for `validateProjectName` and `parseArgs` (14 tests).
- Added `docs/en/getting-started.md` and `packages/create-lumibase/README.md` documenting the scaffold flow, templates, flags, and troubleshooting; linked both from the docs index (`docs/en/README.md`).

### Fixed

- Fixed environment loading in the `default` template: the `dev`, `start`, and `db:migrate` scripts now pass `--env-file=.env` so `tsx`/`node` load environment variables (`drizzle-kit` already auto-loads `.env`).

### Changed

- Added `packages/create-lumibase` to the npm publish allowlist (`scripts/publish-npm.mjs`) and to the CI typecheck/build steps in `.github/workflows/publish-npm.yml`.

## [0.4.5] - 2026-06-10

### Version

- `v0.4.5`

### Date

- `2026-06-10`

### Highlights

- Introduced `@lumibase/mcp-server` — a new publishable npm package that exposes 15 MCP (Model Context Protocol) tools so AI assistants (Claude Code, Cursor, Windsurf, Copilot) can create and manage collections, fields, and items directly via natural language.
- Completed the AI Copilot harness with `updateItem`, `createField`, and `deleteField` skill handlers, giving the harness full CRUD coverage for schema and content operations.
- Synced `generateAppSpec`, `generateApiDocs`, and `generateSeedData` AI skills to the `@lumibase/ai-skills` package.

### Breaking changes

- None.

### Migrations

- No new database schema migrations.
- Compatible DB/schema: `v0.4.4` schema state.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.5`.
3. Deploy the `v0.4.5` image or Cloudflare Worker release.
4. Verify `/health` and critical CMS workflows after deployment.
5. To enable MCP integration, add `@lumibase/mcp-server` to your AI assistant's MCP config (see `docs/en/agent-setup/mcp-config.json`).

### Rollback notes

- Roll back by redeploying the previously known-good CMS image tag (`v0.4.4`).
- No database/schema restore is required.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.5`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.4.4` schema state.
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- Backup required: No.
- Backup scope: none.
- Reason: this release does not modify runtime data or schema state.

### Added

- Added `@lumibase/mcp-server` package (`packages/mcp-server/`) — a Node.js stdio MCP server publishable as `@lumibase/mcp-server` on npm. Run via `npx --package @lumibase/mcp-server lumibase-mcp` with `LUMIBASE_URL`, `LUMIBASE_SITE_ID`, `LUMIBASE_TOKEN` env vars.
- Added 7 MCP collection tools: `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `diff_schema`, `apply_schema`.
- Added 3 MCP field tools: `list_fields`, `upsert_field`, `delete_field`. Field type and interface hints are embedded in tool descriptions for accurate AI code generation.
- Added 5 MCP item tools: `list_items`, `get_item`, `create_item`, `update_item`, `delete_item`. `delete_item` performs a soft-delete (sets `deleted_at`, recoverable).
- Added `updateItem` skill handler to the AI Copilot harness (`apps/cms/src/services/`).
- Synced `generateAppSpec`, `generateApiDocs`, and `generateSeedData` skill definitions to `packages/ai-skills/`.
- Added Core Skills Registry documentation table and auto-doc hook (`docs/`).

### Fixed

- Fixed missing `createField` and `deleteField` handlers in the AI Copilot harness, restoring full schema mutation coverage.

### Changed

- Updated `docs/en/agent-setup/mcp-config.json` to use the named bin `lumibase-mcp` from the published package.
- Updated README with latest project overview.

## [0.4.4] - 2026-06-10

### Version

- `v0.4.4`

### Date

- `2026-06-10`

### Highlights

- Implemented core security hardening measures, including restricting management and backup/restore APIs to site administrators, tenant isolation for materialized physical tables, and strict JWT verification algorithm enforcement.
- Hardened extension execution environments, restricted extension creation privileges, and sanitized error logs to prevent API key leaks.
- Implemented a secure short-lived ticket authentication system for WebSocket/realtime connections.
- Introduced three new standard interface extensions for Studio: SEO, Files, and AIO (All-in-One), along with `@lumibase/extension-sdk` improvements.
- Added database migration preflight checks, dry-run commands, and a Docker request pressure-limiting middleware.
- Resolved N+1 query bottlenecks in marketplace publishing and item detail share role fetching.

### Breaking changes

- None.

### Migrations

- No new schema migration is included in this change. The migration runner now reports the current Drizzle schema version, verifies database connectivity, and lists pending migrations before applying DDL.
- Migration policy now requires backward-compatible migrations for at least one release window: add nullable/defaulted fields first, backfill separately when needed, and defer destructive drops to a later cleanup release.
- Compatible DB/schema: `v0.4.3` schema state.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.4`.
3. Deploy the `v0.4.4` image or Cloudflare Worker release.
4. Verify `/health`, and critical CMS workflows after deployment.

### Rollback notes

- Roll back by redeploying the previously known-good CMS image tag (`v0.4.3`).
- No database/schema restore is required.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.4`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.4.3` schema state.
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- Backup required: No.
- Backup scope: none.
- Reason: this release does not modify runtime data or schema state.

### Added

- Added Docker request pressure-limiting middleware (`apps/cms/src/pressure-limiter.ts`) to prevent service exhaustion.
- Added CodeQL analysis workflow (`.github/workflows/codeql-analysis.yml`) for continuous security scanning.
- Introduced standard interface extensions in Studio: SEO (`apps/studio/src/modules/content/interfaces/seo.tsx`), Files (`apps/studio/src/modules/content/interfaces/files.tsx`), and AIO (`apps/studio/src/modules/content/interfaces/aio.tsx`), integrated with the new interface catalogue plumbing.
- Added the `defineInterface` helper in `@lumibase/extension-sdk` for custom UI interface development.
- Added `llms.txt` and sitemap references in `robots.txt` for AI crawler discovery.
- Added database migration preflight/dry-run checks to verify DB schema versions and connectivity before executing DDL.
- Made the setup progress indicator clickable in Studio for easier step navigation.
- Added override for admin redirection in setup.

### Changed

- Upgraded the CI/CD build environments to Node 24 and fixed script runner shell execution settings.
- Enforced a strict list of permitted signature algorithms in JWT verification (`jwtVerify`).
- Refactored landing page rewards claims to transition claim status.

### Fixed

- Fixed an XSS (Cross-Site Scripting) vulnerability in the docs app search dialog by sanitizing search snippets.
- Fixed an N+1 query performance bottleneck in the marketplace publishing route.
- Fixed an N+1 query in item details share role fetching.
- Hardened tenant isolation by securing and isolating materialized physical tables (`apps/cms/src/routes/materialize.ts`).
- Gated extension creation privileges to authorized users only.
- Gated administrative backup/restore endpoints and management APIs to site administrators only.
- Hardened sandbox execution of custom interface extensions to prevent breakouts.
- Sanitized CMS error logs to filter out potential API key leaks.
- Mitigated potential SQL injection vectors in Drizzle materialize-service triggers.
- Fixed setup redirections in production in Studio.
- Highlighted met password rules in the setup page.
- Fixed delivery section page hydration source hydration in CMS.

## Required release notes format

Every `vX.Y.Z` release must include the following sections in both this
changelog and the published GitHub Release notes:

### Version

- `vX.Y.Z`

### Date

- `YYYY-MM-DD`

### Highlights

- Summarize the most important user-facing changes.
- Include notable fixes, performance improvements, and security updates.

### Breaking changes

- List incompatible API, configuration, runtime, or behavior changes.
- Use `None` when the release has no breaking changes.

### Migrations

- State whether database or schema migrations are included.
- Document the compatible DB/schema version or migration range.
- Call out long-running, destructive, or manual migration steps.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/.../lumibase-cms:X.Y.Z`.
3. Take a backup when the backup guidance below says it is required.
4. Deploy the image tag listed in Docker image tags.
5. Run the required database/schema migrations, if any.
6. Verify health checks and critical CMS workflows.

### Rollback notes

- State whether rollback to the previous release is safe without restoring data.
- Document the previous image tag to redeploy.
- Explain when a database/schema restore is required.

### Docker image tags

- CMS: `ghcr.io/.../lumibase-cms:X.Y.Z`
- Optional immutable digest: `ghcr.io/.../lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `<schema-version-or-migration-range>`
- Minimum supported database engine/version: `<database-version>`

### Backup guidance

- Backup required: `<Yes|No>`
- Backup scope: `<database|object storage|search index|configuration|none>`
- Reason: `<why backup is or is not required>`

## [0.4.3] - 2026-06-07

### Version

- `v0.4.3`

### Date

- `2026-06-07`

### Highlights

- Added the Agent Harness Layer foundation, including agent goals, runs, plans, tool calls, approvals, artifacts, evaluations, memory, and tool registry services.
- Expanded AI provider support for LumiBase Copilot with model overrides, Gemini function calling, Claude/Anthropic aliases, OpenAI model selection, Workers AI model selection, and echo fallback tests.
- Introduced opt-in release update checks in Studio and a version footer in settings.
- Hardened CI and release workflows for pnpm setup, cache behavior, build metadata, Docker publishing, and Pages deployment.
- Added verification of uploaded extensions and file signatures.
- Scoped SCIM tenant authorization to prevent cross-tenant token vulnerabilities.
- Added comprehensive developer integration examples and machine-readable specs (OpenAPI, JSON Schemas, MCP configurations).

### Breaking changes

- None.

### Migrations

- Includes database migration `0018_agent_harness.sql`.
- The migration adds Agent Harness tables and indexes for goals, runs, plans, tool registry, permissions, tool calls, approvals, artifacts, evaluations, and memory.
- Compatible DB/schema: `v0.4.2` schema upgraded through `0018_agent_harness.sql`.
- No destructive schema changes are included.

### Upgrade steps

1. Review the breaking changes and migrations above.
2. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.3`.
3. Take a database backup before applying the Agent Harness migration.
4. Deploy the `v0.4.3` image or Cloudflare Worker release.
5. Run database migrations through `0018_agent_harness.sql`.
6. Verify `/api/v1/agent/*`, `/api/v1/ai/chat`, `/health`, Studio settings, and critical CMS workflows.

### Rollback notes

- Application rollback to `v0.4.2` is safe if the new Agent Harness tables are unused.
- If production data has been written to Agent Harness tables and must be preserved exactly, take a database backup before rollback and avoid dropping the new tables.
- No destructive rollback migration is provided for `0018_agent_harness.sql`.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.3`
- Optional immutable digest: `ghcr.io/khuepm/lumibase-cms@sha256:<digest>`

### Compatibility DB/schema

- Compatible DB/schema: `v0.4.2` plus `0018_agent_harness.sql`.
- Minimum supported database engine/version: PostgreSQL 16 or the version supported by the target deployment environment.

### Backup guidance

- Backup required: Yes.
- Backup scope: database.
- Reason: this release introduces new Agent Harness database tables and indexes.

### Added

- Added Agent Harness database schema, runtime services, Studio settings page, SDK types, OpenAPI routes, and English/Vietnamese feature documentation.
- Added Gemini provider support for AI Copilot through REST `generateContent` function declarations.
- Added provider-level model override support via `LLM_MODEL` for OpenAI, Anthropic/Claude, Gemini, and Workers AI.
- Added provider factory and tool-call parsing tests for OpenAI, Claude, Gemini, and echo fallback.
- Added developer integration examples (Next.js, Hono webhooks, and Studio extensions).
- Added machine-readable specs (OpenAPI spec `docs/openapi.yaml`, JSON Schemas, MCP configurations).
- Added opt-in release update checks in Studio settings.
- Added Studio version footer displaying build metadata.
- Added tag-driven npm publishing for the public package allowlist, with OIDC trusted publishing and provenance.
- Added deployment CI/CD workflows: CMS deployment to GHCR, Cloudflare Pages deploy for docs app, and automated release creations.
- Added verification of uploaded extensions and file signatures for security.
- Added database migration preflight checks to dry-run and verify connectivity/schema version.

### Changed

- Refined release and deploy workflow cache settings, aligned workflow Node versions to Node 24, and fixed metadata setup.
- Version synchronization script updated to automate Turborepo and package version management.

### Fixed

- Fixed SCIM tenant authorization scoping to prevent cross-tenant access.
- Fixed CI pnpm cache handling for Node setup (`actions/setup-node@v5`).

## [0.4.2] - 2026-06-07

### Version

- `v0.4.2`

### Date

- `2026-06-07`

### Highlights

- Added backup and disaster recovery validation runbooks, restore drill automation, scheduler guidance, and Cloudflare Pages deployment configuration.

### Breaking changes

- None.

### Migrations

- No application database/schema migration is introduced by this documentation and deployment-process release.
- Compatible DB/schema: existing `v0.4.2` schema state.

### Upgrade steps

1. Confirm the target Docker image tag exists:
   `ghcr.io/khuepm/lumibase-cms:0.4.2`.
2. Review the compatibility and backup guidance in these notes.
3. Deploy the `v0.4.2` image when available for the target environment.
4. Verify restore drill automation, `/health`, and critical CMS workflows after deployment.

### Rollback notes

- Roll back by redeploying the previously known-good CMS image tag.
- No database/schema restore is required for this documentation and deployment-process release.

### Docker image tags

- CMS: `ghcr.io/khuepm/lumibase-cms:0.4.2`

### Compatibility DB/schema

- Compatible DB/schema: existing `v0.4.2` schema state.
- Minimum supported database engine/version: use the version supported by the target deployment environment.

### Backup guidance

- Backup required: No.
- Backup scope: none.
- Reason: this release-process update does not modify runtime data or schema state.

### Added

- Added a backup and disaster recovery validation runbook covering restore drills, row-count verification, app health checks, media/search rebuilds, RTO/RPO evidence, and Cloudflare-specific recovery checks.
- Added restore drill automation for database restore validation, row-count checks, app health checks, media checks, reindex triggers, and search result verification.
- Added Linux, macOS, and Windows scheduler setup guidance for recurring restore drills.
- Added Cloudflare Pages deployment configuration for the docs app, including SPA deep-link fallback support for `docs.lumibase.dev`.

### Changed

- Updated restore drill scheduling docs and examples to cover systemd timers, cron, launchd, and Windows Task Scheduler.
- Updated docs deployment commands to run Wrangler from the docs app directory and to pass the Cloudflare account through `CLOUDFLARE_ACCOUNT_ID` instead of unsupported Pages config fields.
- Updated the repository remote/deploy documentation for the new GitHub repository location.

### Fixed

- Hardened restore drill reruns by resetting the Drizzle schema during restore cleanup and by supporting authenticated app, media, reindex, and search checks.
- Fixed Cloudflare Pages deploy configuration after Wrangler validation rejected `account_id` in a Pages `wrangler.toml`.

## [0.4.1] - 2026-06-06

### Added

- Added public marketplace catalog and launch documentation refinements.

### Changed

- Hardened Docker production deployment with startup validation for required
  production secrets, database TLS settings, CORS allowlists, and AES
  encryption key format.
- Added Docker secret-file support via `*_FILE` variables before migrations and
  server startup.
- Updated production Docker Compose to keep stateful services on the private
  Compose network while only publishing the CMS ingress port.
- Updated deployment docs and roadmap task tracking for Docker production
  hardening.

### Fixed

- Added timeout protection for dependency health probes.

## [0.4.0] - 2026-06-06

### Added

#### Directus Data Model Parity

- Added first-class collection metadata contract for labels, hidden/system
  flags, primary key strategy, storage mode, archive behavior, duplication
  fields, translations, and top-level Studio wizard payloads.
- Added JSONB primary key strategy handling for `nanoid`, `uuid`, and
  user-provided string IDs, with unsupported integer strategies blocked until
  materialized or physical storage support exists.
- Added schema-visible system fields in compiled schemas, Studio locked-field
  rendering, and typegen coverage for primary keys, system metadata,
  nullable/required fields, readonly/generated fields, and expanded relation
  response types.
- Added Directus-style field metadata for labels, notes, defaults, nullable,
  unique/index/search hints, numeric precision, special flags, translations,
  and advanced FieldInspector tabs.
- Added relation parity metadata for relation type, alias fields, related
  display templates, junction fields, and relation validation.
- Added M2O/O2M/M2M item relation expansion with batching and related-item
  permission masking.
- Added schema diff/apply support for collection, field, and relation changes,
  risk classification, runtime impact reporting, transactional apply,
  cache/typegen invalidation, and `schema.changed` events.
- Added complete SDK schema resources for collections, fields, relations,
  field rename/delete options, schema diff/apply, and legacy wrappers.

### Changed

- Studio collection creation now uses a multi-step Directus parity flow with
  identity, storage, system field, permission-default, and JSON review steps.
- Studio Raw JSON schema editing now previews diff risk/runtime impact before
  apply and requires confirmation for high-risk schema changes.
- Storage mode docs now explicitly position `jsonb`, `materialized`,
  `physical`, and `external` modes and describe current limitations.

### Fixed

- Fixed schema correctness checks for relation dependencies, field deletion
  dependencies, invalid relation references, schema permission enforcement, and
  destructive field mutation handling.
- Fixed populated-field deletion so destructive deletes require
  `force=true` plus `backupToRevisions=true`, preserving removed field values
  in revisions before deleting field metadata.
- Fixed Docker CI health checks by reducing Docker context noise, increasing
  Docker job timeout, adding a bounded health-check step, and always collecting
  container logs on failure.

### Documentation

- Added the Directus Data Model Parity task plan and marked the Phase POST-GA8
  roadmap complete in English and Vietnamese.
- Updated collection builder, field type/config, data model, physical
  collection architecture, OpenAPI, SDK/typegen, and Vietnamese mirror docs for
  the finalized parity contract.

## [0.3.0] - 2026-06-05

### Added

#### Advanced Permission Builder & RBAC

- Added policy-level access flags foundation for app/admin access, TFA
  enforcement, IP allow/deny guards, validity windows, and future role-flag
  migration.
- Added access conflict detection APIs, SDK methods, and Studio previews so
  role-policy attachment can surface overlapping collection/action policies
  before they silently broaden access.
- Added permission source tracing in effective-permission responses so Studio
  can explain which role/policy grants a field, collection, or action.
- Added CIDR-aware policy IP guards and extended permission DSL magic variables,
  with evaluator hardening for fail-closed access checks.
- Added share-link permission targets and grouped system/sensitive permission
  targets in Studio.

#### API Keys

- Added API key database schema, bearer-token authentication for API key
  principals, key lifecycle routes, rotation/revocation support, and audited
  create/rotate/revoke flows.
- Added role/policy attachment support for API keys and SDK client methods for
  API key CRUD, role/policy assignment, and access conflict preview.
- Added Studio API Keys management page and backend tests for revoked/expired
  keys, Studio access denial, and policy-scoped row/field access.

#### Access Import / Export

- Added access manifest export, dry-run import, apply import, idempotent import
  tests, and a CMS CLI for access manifests.
- Added typed SDK support for access import/export and a Studio access import
  dialog.
- Added baseline access policy seed data for system policies and Studio self
  access.

#### Extension Permissions

- Added extension permission targets plus enforcement for extension management,
  extension endpoint execution, and extension data access.
- Documented Lumibase extension access behavior against Directus and recorded
  product-differentiating permission controls for future marketing.

#### Admin Setup & Recovery

- Added quick admin setup as the default setup experience at `/setup/account`,
  with the full advanced wizard moved to `/setup/advance`.
- Added same-tab draft handoff between quick and advanced setup so users can
  switch modes without re-entering completed account/path/security data.
- Added editable completed setup steps before setup is submitted, allowing users
  to click previous progress markers and revise entered values.
- Added project configuration setup step, admin-login routing after setup,
  recovery-code login flow, recovery password reset flow, and polished recovery
  navigation controls.
- Added debounced admin-path validation so server/path errors clear while the
  operator edits.

#### Realtime & Tooling

- Added realtime WebSocket implementation guide and a Next.js realtime client
  tester.
- Added combined Studio/CMS dev scripts, default CMS dev port `1989`, Studio dev
  port `2026`, interactive Turbo dev tasks, and CMS proxy target override.
- Added OpenAPI coverage for access conflict checks.

### Changed

- Renamed the combined local runner to `pnpm lumibase`.
- Changed setup completion to always return `setupToken: null`.
- Updated Docker/Wrangler tooling to use Node 22 for Wrangler builds and
  preflight `process.cpuUsage` to avoid noisy local Wrangler metrics warnings.
- Scoped CDC admin access to the selected site and documented secure CDC compose
  port bindings.

### Fixed

- Fixed realtime WebSocket client-message handling.
- Fixed security setup default validation and admin access gating before setup
  completion.
- Fixed RBAC write enforcement in item create/update/delete paths, including
  field whitelist and permission validation hardening.
- Fixed RBAC typecheck regressions after conflict-target and permission-source
  changes.
- Fixed lazy GeoIP availability degradation initialization.
- Fixed audit log tenant scoping.
- Fixed Docker health smoke behavior for runtime checks.

### Documentation

- Added deep Directus/RBAC investigation notes, PermissionService composition
  audit, extension access control plan, Directus comparison table, marketing
  comparison ledger, system/sensitive collection classification, access manifest
  `lumibase.access@v1` contract, and role flag migration strategy.
- Updated access PR documentation and merge-readiness notes.

## [0.2.1] - 2026-06-02

### Documentation

- Added comprehensive deployment documentation for Cloudflare and Docker in
  English and Vietnamese.

## [0.2.0] - 2026-05-30

### Added

#### Admin Setup Wizard

- First-time configuration wizard in Studio (`/setup`) that runs only while the
  instance is `uninitialized` and returns 404 once a Bootstrap Admin exists.
- Instance state detection via `GET /api/v1/setup/state` plus an atomic
  `SetupService.complete` transaction that creates the Bootstrap Admin and stores
  the admin path together, leaving state untouched on any failure.
- One-time setup token generator with startup hook, gated by
  `LUMIBASE_REQUIRE_SETUP_TOKEN`.
- Studio wizard steps: account creation (react-hook-form + zod + zxcvbn strength
  meter), custom admin path (wordlist generator with confirm gate), recovery
  backup codes, lockout/security presets, and a done step. State persists in a
  zustand store backed by sessionStorage, with deep-link guards on all routes.
- EN + VI i18n keys for the full wizard.
- Database: `system_state` singleton, `audit_log`, `login_attempts`,
  `login_baselines`, and `admin_backup_codes` tables, with bootstrap + lockout
  fields added to `users` (migrations 0005–0008).

#### Custom Admin Path Guard

- Constant-time admin path comparison and guard middleware that returns an
  indistinguishable 404 for default/unknown paths, mounted in the global
  middleware chain.
- `GET /api/v1/me/admin-path` endpoint and an admin-path masking helper for
  audit/log lines. Build assertion ensures the admin path never leaks into the
  client bundle.

#### Login Guard — Lockout & IP Rate Limiting

- Sliding-window counter store with per-user lockout and per-IP rate limiting,
  client IP resolver with trusted-proxy support, and a precheck middleware wired
  into the login route via onFailure/onSuccess hooks.
- Admin endpoints to unlock a user and unblock an IP.
- Studio security step with preset chooser, failed-attempt thresholds, and
  notification configuration.

#### Anomaly Detection

- Geo, time, and device sub-scores (lazy MMDB GeoIP lookup, histogram-derived
  time score, User-Agent device fingerprinting) combined by a policy-gated
  aggregator with a baseline writer (cap/LRU merge).
- Integrated into the login success path with `lock` / `notify_only` / warmup
  flows and a Studio anomaly review group with GeoIP warnings.

#### Security Notifications

- Channel, event, and payload type definitions with email (nodemailer +
  MailChannels) and HMAC-SHA256-signed webhook channels.
- In-process notification dispatcher with a retry queue and rate limiting, wired
  into Login Guard security events and drained via `ctx.waitUntil` on Workers.

#### Account Recovery

- Backup-code redemption (`RecoveryService.recover`) and admin-path recovery
  (`RecoveryService.forgotPath`) with single-use, time-bound recovery tokens and
  a shared 3/IP/hour rate limiter.
- Public `/recover` and `/forgot-path` routes plus Studio recovery pages.

#### Security Audit Log

- `AuditLogger` with sensitive-field masking and a fallback write path, wired
  into all 15 security events through an audit-context middleware.
- Audit rotator with retention pruning and count-triggered throttling, scheduled
  hourly via node-cron (Node) and Cron Triggers (Workers).
- Cursor-paginated audit query API with filters, NDJSON export (streaming, 100k
  cap), mounted under authenticated `/admin/security`, and a Studio Security
  audit tab with filters, pagination, and export.

#### Tooling

- Config export/import CLI for site schema management.
- Automated code review workflow configuration.

### Fixed

- Resolved `Cannot find module 'cloudflare:workers'` crash in the Node.js build.

## [0.1.0] - Prior release

Initial tagged release.

[0.9.0]: https://github.com/khuepm/lumibase/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/khuepm/lumibase/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/khuepm/lumibase/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/khuepm/lumibase/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/khuepm/lumibase/compare/v0.4.7...v0.5.0
[0.4.7]: https://github.com/khuepm/lumibase/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/khuepm/lumibase/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/khuepm/lumibase/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/khuepm/lumibase/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/khuepm/lumibase/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/khuepm/lumibase/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/khuepm/lumibase/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/khuepm/lumibase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/khuepm/lumibase/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/khuepm/lumibase/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/khuepm/lumibase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/khuepm/lumibase/releases/tag/v0.1.0

