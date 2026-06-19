# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase) · Website: [lumibase.dev](https://lumibase.dev)

## [Unreleased]

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

### Migrations

- **1 new schema migration (`0031_regulated_content_readiness.sql`)**: new tables
  `encryption_keys`, `field_access_log`, `content_reviews`, `erasure_requests`;
  new columns `items.publish_at`/`unpublish_at`/`editorial_state`/`dek_wrapped`
  and `fields.classification`.
- Additive and idempotent: new columns are nullable or defaulted and the
  migration is `IF NOT EXISTS`/duplicate-object guarded, so it re-runs safely and
  needs **no backfill**. Existing ciphertext reads unchanged via the `v0` path.

### Changed

- Envelope mode is governed by the `encryption.envelope` setting; the
  `LUMIBASE_ENVELOPE_ENCRYPTION` env var is no longer the hot-path control.

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

