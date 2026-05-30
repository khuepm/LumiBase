# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase) · Website: [lumibase.dev](https://lumibase.dev)

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

[0.2.0]: https://github.com/khuepm/lumibase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/khuepm/lumibase/releases/tag/v0.1.0
