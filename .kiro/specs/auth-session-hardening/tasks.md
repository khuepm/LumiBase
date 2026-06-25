# Auth / Session Hardening — Tasks

Follow-ups after the user-management realms + refresh-token work
(branch `claude/cms-user-management-practices-u15una`). Ordered by priority.
Each task is one or more commits.

## Implemented here

- [x] **T1 — CSRF guard for cookie-based refresh/logout.** When the refresh
  token is taken from the cookie (ambient credential), require a custom
  header (`X-LumiBase-Refresh`) that a cross-site simple request cannot set.
  Body-token callers are exempt (the token isn't ambient). Closes the
  `SameSite=None` CSRF gap.
- [x] **T2 — Refresh-token pruning (scheduled).** Delete expired + long-ago
  revoked `refresh_tokens` rows on the existing hourly cron (Workers
  `scheduled` + Node `node-cron`), mirroring the audit rotator wiring.
- [x] **T3 — Authenticated change-password.** `POST /api/v1/me/change-password`
  — verify current password, set new hash, revoke all refresh tokens.
- [x] **T4 — Session management.** `GET /api/v1/me/sessions`,
  `DELETE /api/v1/me/sessions/:id`, `DELETE /api/v1/me/sessions` (revoke
  others) over the now-tracked refresh tokens.
- [x] **T5 — Refresh-flow DB integration test.** Real-Postgres test
  (skipped without `DATABASE_URL`, mirroring existing `*.db.integration`).

## Follow-ups (now also done)

- [x] **T6 — SDK auto-refresh.** `@lumibase/sdk` should call `/auth/refresh`
  on a 401 and retry. Cross-package; needs SDK API design.
- [x] **T7 — Studio/frontend wiring.** Store tokens, refresh before expiry,
  logout button (`apps/studio`). UI work, not unit-verifiable here.
- [x] **T8 — Drizzle snapshot drift.** Committed snapshots stopped at `0011`
  (48 tables) while hand-written `0012`–`0031` reached 71, so `generate`
  re-emitted ~23 existing tables. Fixed by regenerating an accurate
  full-schema snapshot carried by a no-op realignment migration
  (`0032_realign_snapshot_baseline`); `generate` now reports "No schema
  changes". Future migrations can use `generate` normally again.
