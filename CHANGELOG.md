# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase) · Website: [lumibase.dev](https://lumibase.dev)

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

[0.4.4]: https://github.com/khuepm/lumibase/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/khuepm/lumibase/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/khuepm/lumibase/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/khuepm/lumibase/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/khuepm/lumibase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/khuepm/lumibase/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/khuepm/lumibase/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/khuepm/lumibase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/khuepm/lumibase/releases/tag/v0.1.0

