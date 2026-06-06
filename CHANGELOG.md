# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase) · Website: [lumibase.dev](https://lumibase.dev)

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

[0.4.1]: https://github.com/khuepm/lumibase/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/khuepm/lumibase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/khuepm/lumibase/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/khuepm/lumibase/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/khuepm/lumibase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/khuepm/lumibase/releases/tag/v0.1.0
