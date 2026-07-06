---
version: 4
lastUpdated: 2026-07-06T23:15:55.000Z
sourceLang: en
contentHash: 0b02fec2a9ea24df
---

# CWE Top 100 Security Audit — LumiBase

> **Status:** Living document. Re-audit after any change to auth, upload, storage, or query-building code.
> **Audit date:** 2026-07-06 · **Branch:** `lumibase/inspiring-driscoll-2c1fd8` (base `main` @ 87a82fcb)
> **Method:** Static code review of the monorepo (agent-assisted sweep + call-site verification of key claims). Not a penetration test — a "Mitigated" verdict means a correct defense exists in code with cited evidence, not a guarantee of absence of vulnerabilities.

## Scope and list composition

There is **no official "CWE Top 100."** MITRE publishes a ranked list only to rank 40:

- **Part A (ranks 1–40, official):** [2025 CWE Top 25](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html) + [2025 "On the Cusp"](https://cwe.mitre.org/top25/archive/2025/2025_onthecusp_list.html) (ranks 26–40).
- **Part B (60 additional weaknesses, unranked):** selected by the audit team from OWASP Top 10 (2021) / OWASP API Security Top 10 (2023) CWE mappings and web/API security practice, filtered for relevance to LumiBase's stack (TypeScript, Hono, Drizzle/Postgres, Cloudflare Workers + Node/Docker). This selection is editorial, not an official ranking.

## Verdict legend

| Verdict | Meaning |
|---------|---------|
| ✅ Mitigated | A correct, tested-or-verifiable defense exists at the cited location. |
| ⚠️ Partial | Defense exists but has a documented gap or inconsistency. |
| ❌ Not addressed | No defense found for an applicable weakness. |
| — N/A | Not applicable to this stack (memory-safety/native/PHP class) or no attack surface exists in the codebase. |

## Scorecard

| | Count |
|---|---|
| ✅ Mitigated | **78** |
| ⚠️ Partial | **0** |
| ❌ Not addressed | **0** |
| — N/A (memory-safety class, no surface, or no cookies) | **22** |
| **Total** | **100** |

Of the **78 applicable** weaknesses: **78 mitigated (100%)**, 0 partial, 0 not addressed.

> **Changelog — 2026-07-06:**
> - First pass fixed the two ⚠️ items in the official top 20 (CWE-89 SQL Injection, CWE-284 Improper Access Control) plus the related CWE-668.
> - Second pass closed every remaining Partial/Not-addressed item: CWE-521/203 (register password policy + validation), CWE-620/613 (change-password endpoint + `token_version` revocation), CWE-302 (Cloudflare Access role now mapped from DB), CWE-362/367 (atomic guarded approval decide), CWE-942 (no arbitrary-origin credentialed CORS), CWE-321 (removed in-repo CDC fallback key, fail-closed), CWE-400 (general API rate limiter), CWE-359 (audit-log payload redaction + string caps), CWE-1104 (dependabot + `pnpm audit` CI gate).
> All applicable weaknesses are now Mitigated. As always, "Mitigated" means a verified defense exists — not a guarantee; a penetration test remains the way to confirm.

---

## Part A — MITRE 2025 official ranking (1–40)

| # | CWE | Weakness | Verdict | Evidence / note |
|---|-----|----------|---------|-----------------|
| 1 | 79 | Cross-site Scripting | ✅ | Central DOMPurify allowlist `apps/studio/src/lib/sanitize-html.ts`; markdown escaped then sanitized; CSP `script-src 'self'` in `apps/cms/src/middleware/security-headers.ts`; SVG active-content scan on upload. |
| 2 | 89 | SQL Injection | ✅ | **Fixed 2026-07-06.** `materialize-service.ts` now uses Drizzle bind parameters for all values and `sql.identifier()` for the validated physical-table name; the one spot where bind params are impossible (the PL/pgSQL trigger body) validates ids fail-closed against `/^[A-Za-z0-9_-]+$/` instead of escaping. Elsewhere Drizzle is parameterized throughout. Covered by `materialize-sql-injection.test.ts` + `materialize-service.test.ts`. |
| 3 | 352 | CSRF | ✅ | Auth is bearer-header only on this branch — no cookies are issued, so no ambient credentials exist for CSRF to ride on. CORS origins validated (`apps/cms/src/config/cors.ts`). Re-verify if cookie-based refresh lands (exists on a feature branch, commits 807d0fbd / 4469c36c — not merged here). |
| 4 | 862 | Missing Authorization | ✅ | `withAuth()` on the whole `/api/v1` stack (`apps/cms/src/index.ts`); only intentional bypasses: login, setup wizard (state-gated), recovery (rate-limited), realtime ticket exchange. |
| 5 | 787 | Out-of-bounds Write | — | Memory-safety class; no native code. |
| 6 | 22 | Path Traversal | ✅ | `isInvalidKey()` rejects `..`/leading `/` (`apps/cms/src/routes/media.ts:22`); all storage keys tenant-prefixed `sites/{siteId}/media/`. |
| 7 | 416 | Use After Free | — | Memory-safety class. |
| 8 | 125 | Out-of-bounds Read | — | Memory-safety class. |
| 9 | 78 | OS Command Injection | — | No user input reaches shell execution; only build-time `execFileSync('git', [...])` with a fixed argv. |
| 10 | 94 | Code Injection | ✅ | Extension bundles only from `EXTENSION_BUNDLE_ORIGINS` allowlist + SSRF guard + timeout (`apps/cms/src/extensions/sandbox.ts`); AI skills are declarative schemas, no eval of user strings. |
| 11 | 120 | Classic Buffer Overflow | — | Memory-safety class. |
| 12 | 434 | Dangerous File Upload | ✅ | 5 layers in `apps/cms/src/middleware/file-upload-policy.ts`: real body size, DB-backed MIME allowlist, extension↔MIME cross-check, magic-byte sniffing (rejects MZ/ELF/Mach-O), SVG script/XXE scan. Served with `Content-Disposition: attachment` + nosniff. |
| 13 | 476 | NULL Pointer Dereference | — | Memory-safety class (a JS `TypeError` is an exception, not memory corruption). |
| 14 | 121 | Stack Buffer Overflow | — | Memory-safety class. |
| 15 | 502 | Unsafe Deserialization | ✅ | Config import via strict Zod schemas before any processing (`apps/cms/src/services/config-import-service.ts:79`); no yaml.load/vm/unserialize. |
| 16 | 122 | Heap Buffer Overflow | — | Memory-safety class. |
| 17 | 863 | Incorrect Authorization | ✅ | Postgres RLS on 25+ tables with transaction-scoped `SET LOCAL app.site_id` (`packages/database/migrations/rls-policies.sql`); app-level `siteId` scoping in services; field-level masking in `permission-service.ts`. |
| 18 | 20 | Improper Input Validation | ✅ | Zod `safeParse()` consistently on all route inputs (shared schemas in `packages/shared/src/schemas`). |
| 19 | 284 | Improper Access Control | ✅ | **Fixed 2026-07-06.** Route surfaces (flows, ai, cdc, uploads, shares) enforce admin/permission checks. `/health` now returns only overall `status` to anonymous callers (per-subsystem detail requires the observability token); `/metrics` enforces `METRICS_TOKEN` in **all** environments when configured (previously non-prod bypass). See CWE-668. |
| 20 | 200 | Sensitive Info Exposure | ✅ | `formatSafeError()` strips request/response objects; clients get generic error codes; stack traces log server-side only (`apps/cms/src/index.ts:328`). |
| 21 | 306 | Missing AuthN for Critical Function | ✅ | Setup wizard 404s once `system_state = initialized`; recovery is intentionally public but 3/IP/hour; metrics token-gated in prod. |
| 22 | 918 | SSRF | ✅ | `validateOutboundUrl()` blocks RFC1918, loopback, link-local, cloud metadata endpoints, IPv6 ULA/link-local (`apps/cms/src/services/ssrf-guard.ts:33`), with tests. |
| 23 | 77 | Command Injection | — | Same as CWE-78: no surface. |
| 24 | 639 | AuthZ Bypass via User-Controlled Key (IDOR) | ✅ | Every item/revision query filters `scopeSite(items.siteId, deps.siteId)` (`apps/cms/src/services/item-service.ts:558`); integration tests `idor-tenant-isolation.integration.test.ts`; guidelines in `docs/en/security/idor-testing.md`; nanoid IDs are non-guessable. |
| 25 | 770 | Resource Allocation Without Limits | ✅ | Pagination `limit ≤ 200`, filter clauses ≤ 100, filter path depth ≤ 8 (`item-service.ts:227`), upload size caps, event-loop pressure limiter returning 503. See CWE-400 for the remaining rate-limit gap. |
| 26 | 266 | Incorrect Privilege Assignment | ✅ | Bootstrap admin role explicit (`modules/setup/service.ts:935`); invited members default to `roleId: null`, member role has `adminAccess: false`. |
| 27 | 276 | Incorrect Default Permissions | ✅ | Docker runs as non-root `lumibase` user (`docker/Dockerfile`); upload policy fails safe to restrictive defaults; no public-read default policies. |
| 28 | 98 | PHP File Inclusion | — | Not a PHP codebase. |
| 29 | 269 | Improper Privilege Management | ✅ | Control-plane routes admin-only (`middleware/control-plane-access-guard.ts`); users cannot change their own role (`requireSiteAdmin()` on `/users`); HITL `ai_approvals` for `schema:write`/`delete` skills. |
| 30 | 190 | Integer Overflow | — | JS 64-bit floats; no unsafe size arithmetic with user input found. |
| 31 | 287 | Improper Authentication | ✅ | PBKDF2-SHA256 100k iterations + 16-byte salt, constant-time compare (`services/auth/password.ts`); JWT HS256 24h; API keys SHA-256-hashed; lockout + per-IP window + 500ms stall + dummy-hash anti-enumeration. |
| 32 | 400 | Uncontrolled Resource Consumption | ✅ | **Fixed 2026-07-06.** Added `withRateLimit()` to the authenticated API chain (`apps/cms/src/middleware/rate-limit.ts`): a per-principal (userId/API-key) or per-IP fixed-window throttle over the runtime cache, on top of the existing auth/recovery limiters and event-loop backpressure. Emits `X-RateLimit-*` + `Retry-After`; configurable via `LUMIBASE_RATE_LIMIT_*`. |
| 33 | 288 | AuthN Bypass via Alternate Path | ✅ | GraphQL inherits the same `withAuth`/`withRls` chain; realtime uses 1-minute signed tickets; SCIM uses its own hashed-token store with expiry; MCP inherits bearer auth. |
| 34 | 427 | Uncontrolled Search Path | — | No child-process execution in app code. |
| 35 | 798 | Hard-coded Credentials | ✅ | Secrets via env/`*_FILE`; production startup rejects known dev-default values (`apps/cms/src/config/production.ts:25`); dev-auth bypass triple-gated to development. |
| 36 | 362 | Race Condition | ✅ | **Fixed 2026-07-06.** The AI approval commit/reject UPDATEs are now guarded by `WHERE status = 'pending'` and use `.returning()`; a zero-row result means a concurrent decision already won, and the caller gets a conflict instead of silently overwriting (`services/ai-harness.ts`). Recovery tokens remain single-use via atomic consume. |
| 37 | 401 | Memory Leak | — | Memory-safety class. |
| 38 | 732 | Permissions on Critical Resource | ✅ | `FORCE ROW LEVEL SECURITY` prevents table-owner bypass; migration mandates a non-superuser app role (`rls-policies.sql:12,59`). |
| 39 | 119 | Memory Buffer Bounds | — | Memory-safety class. |
| 40 | 601 | Open Redirect | — | No `returnTo`/redirect-by-user-URL mechanism found in auth routes; external-JWT issuers are configured server-side. No surface today; add a centralized redirect validator if login redirects are ever introduced. |

---

## Part B — 60 additional weaknesses (OWASP-mapped selection, unranked)

### B1. Cryptography & key management (12)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 327 | Broken crypto algorithm | ✅ | AES-GCM via WebCrypto (`services/crypto-service.ts:91`); no MD5/SHA1/DES/RC4/ECB/`createCipher`. |
| 328 | Weak hash | ✅ | SHA-256 for token hashing; PBKDF2-SHA256 for passwords. |
| 326 | Inadequate encryption strength | ✅ | AES-256 DEKs (`services/crypto/envelope-encryption.ts:21`); key-size validation at startup. |
| 330 | Insufficient randomness | ✅ | `crypto.getRandomValues()` for API-key seeds, setup tokens, backup codes (rejection-sampled); `Math.random()` only in non-security fallbacks. |
| 338 | Weak PRNG | ✅ | Same as CWE-330; recovery timing jitter explicitly uses CSPRNG. |
| 311 | Missing encryption of sensitive data | ✅ | Deployment tokens stored as AES-GCM envelope ciphertext + key id (`packages/database/src/schema/deployments.ts:47`). |
| 312 | Cleartext storage of secrets | ✅ | API keys/share tokens stored as SHA-256 hashes; plaintext returned exactly once at creation. |
| 319 | Cleartext transmission | ✅ | Production requires `sslmode=require+` for Postgres (`config/production.ts:107`); external issuers must be HTTPS. |
| 321 | Hard-coded crypto key | ✅ | **Fixed 2026-07-06.** The in-repo CDC fallback key is removed; `encrypt`/`decrypt` now require a key and throw otherwise, and the CDC route factory fails closed with a 503 `ENCRYPTION_KEY_MISSING` when `ENCRYPTION_KEY` is unset (`modules/cdc/registry/encryption.ts`, `modules/cdc/routes.ts`). |
| 347 | Improper signature verification | ✅ | `jose` with explicit algorithm allowlists (HS256 custom / RS256 CF Access); external-JWT verifier **forbids** `none`/HS* (`modules/external-auth/verifier.ts:72`); Vercel/Netlify inbound webhooks verified with constant-time compares. |
| 916 | Weak password hash | ✅ | PBKDF2-SHA256 100k everywhere a password/backup code is stored; no weaker path (setup, SCIM checked). |
| 295 | Improper certificate validation | ✅ | No `rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED` anywhere; JWKS via `createRemoteJWKSet`. |

### B2. Secrets handling (2)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 522 | Insufficiently protected credentials | ✅ | One-time plaintext return for API keys/share tokens; setup token printed once, hash persisted. |
| 526 | Exposure via environment | ✅ | No env dumps; error paths use `formatSafeError()`; prod config validation fails closed. |

### B3. Session & account management (12)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 384 | Session fixation | ✅ | Fresh JWT per login; no session identifier carried across authentication. |
| 613 | Insufficient session expiration | ✅ | **Fixed 2026-07-06.** Added a `users.token_version` column (migration `0002_add_user_token_version.sql`) embedded in every JWT and checked on verify (`middleware/auth.ts`). A password change or reset bumps it, instantly invalidating all outstanding tokens for that user. |
| 307 | Excessive auth attempts | ✅ | Login lockout (`users.lockedUntil`) + per-IP sliding window (423/429); recovery 3/IP/h; setup state endpoint 60/min/IP. |
| 521 | Weak password requirements | ✅ | **Fixed 2026-07-06.** Introduced a shared `PasswordSchema` (min 12 + complexity) in `packages/shared/src/schemas/password.ts`, now used by register, setup, and recovery so the policy is uniform and can't drift. |
| 620 | Unverified password change | ✅ | **Fixed 2026-07-06.** Added `POST /api/v1/me/change-password` which requires the current password (constant-time verify) and bumps `token_version` to revoke other sessions, returning a fresh token for the caller (`routes/auth.ts`). |
| 640 | Weak password recovery | ✅ | 32-byte CSPRNG tokens, 15/30-min TTL, single-use atomic consume, uniform 200–500ms delay, generic responses (`modules/recovery/service.ts`). |
| 203 | Observable discrepancy (user enumeration) | ✅ | Login and recovery are uniform (dummy hash, generic messages). Register is **admin-only** (an authenticated admin provisioning users for their site), so its `EMAIL_ALREADY_EXISTS` reply is not an anonymous-enumeration vector; the endpoint now also validates input with a 400 before any lookup. |
| 208 | Timing discrepancy | ✅ | Constant-time byte compare for password and admin-path matching; 500ms login stall; CSPRNG jitter in recovery. |
| 302 | AuthN bypass via assumed-immutable data | ✅ | **Fixed 2026-07-06.** `withSiteMembership` already binds the `X-Lumi-Site` tenant to a verified membership before RLS. The remaining gap — Cloudflare Access principals hardcoded to `['admin']` — is closed: the Access identity is now resolved to a real active user + site-membership role from the DB, denying non-provisioned/non-member users (`middleware/auth.ts`). |
| 614 | Cookie without Secure flag | — | No cookies issued on this branch (bearer-only). |
| 1004 | Cookie without HttpOnly | — | Same. |
| 1275 | Cookie SameSite | — | Same. Re-audit all three if cookie-based refresh merges. |

### B4. Web platform (12)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 611 | XXE | ✅ | No XML parser in the pipeline; SVG screened by regex token scan (blocks `<!DOCTYPE`, `<!ENTITY`) — no entity expansion possible. |
| 776 | XML entity expansion | ✅ | Same as CWE-611. |
| 1021 | Clickjacking | ✅ | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (`middleware/security-headers.ts`). |
| 942 | Permissive CORS | ✅ | **Fixed 2026-07-06.** `resolveCorsOrigin` never returns `*` and never reflects an arbitrary internet origin: an explicit allowlist wins in every env, and with no allowlist only loopback origins are reflected (dev only). Credentialed CORS can no longer be abused by a third-party site (`config/cors.ts`). |
| 444 | Request smuggling | — | No custom proxy/header-forwarding code; framework/infra concern. |
| 113 | Response splitting | ✅ | `sanitizeDownloadFilename` strips control chars/quotes/backslash before Content-Disposition (`routes/media.ts:44`). |
| 93 | CRLF injection | ✅ | Same sanitizer; no other user input reaches headers. |
| 116 | Improper output encoding | ✅ | API is JSON-only via `c.json()`. |
| 117 | Log injection | ✅ | Structured `JSON.stringify` logging (`middleware/logger.ts`) — control characters cannot forge log lines. |
| 1336 | SSTI | ✅ | Email templates use a micro-engine with HTML-escaped `{{var}}` substitution only (`services/email/render.ts:49`); no Handlebars/EJS/Liquid. |
| 425 | Forced browsing | ✅ | Admin path guard returns indistinguishable 404s (`middleware/admin-path-guard.ts`); backup/restore require admin bundle. |
| 602 | Client-side-only enforcement | ✅ | Spot-checked: admin backup/restore and role routes enforce `requireSiteAdmin`/PermissionService server-side, independent of Studio UI state. |

### B5. JavaScript / API specific (12)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 1321 | Prototype pollution | ✅ | No recursive user-JSON merges; explicit field mapping on upserts; strict Zod objects. |
| 915 | Mass assignment | ✅ | No `...req.body` into DB writes; Zod-whitelisted fields only (`routes/items.ts:35`, `routes/webhooks.ts:11`). |
| 1333 | ReDoS | ✅ | User-supplied regex in permission DSL wrapped in try/catch and bounded (`services/permission-dsl.ts:384`); filter recursion bounded. |
| 407 | Algorithmic complexity | ✅ | Filter clauses ≤ 100, path depth ≤ 8 (`item-service.ts:227`). |
| 674 | Uncontrolled recursion | ✅ | Relation expansion is single-pass; no unbounded recursion on user data. |
| 799 | Interaction frequency | ✅ | Bulk operations bounded; pagination capped. (Per-user API rate limiting tracked under CWE-400.) |
| 73 | External control of file path | ✅ | Storage keys validated and tenant-prefixed; export filenames derived server-side. |
| 59 | Symlink following | — | Filesystem reads limited to env-configured secret paths; object storage is key-based. |
| 552 | Exposed files/directories | ✅ | No static serving of project dirs; media behind permission checks; MinIO bucket not public. |
| 494 | Code download without integrity check | ✅ | Extension bundles restricted to HTTPS allowlist origins + SSRF guard; pnpm lockfile integrity for dependencies. Consider adding SRI hashes per bundle as hardening. |
| 829 | Inclusion from untrusted sphere | ✅ | Studio `index.html` loads only local modules; no CDN scripts. |
| 345 | Data authenticity | ✅ | Outbound webhooks signed HMAC-SHA256 with timestamp (`modules/notifications/webhook-channel.ts:144`); inbound deployment webhooks verified per provider with constant-time compare. |

### B6. Authorization & operations (10)

| CWE | Weakness | Verdict | Evidence / note |
|-----|----------|---------|-----------------|
| 285 | Improper authorization (broad) | ✅ | Flows/AI/CDC/uploads/shares routes each enforce admin or PermissionService checks at middleware level. |
| 565 | Reliance on cookies without validation | — | No cookies. |
| 367 | TOCTOU | ✅ | **Fixed 2026-07-06.** Same fix as CWE-362 — the approval decide/reject is now an atomic guarded UPDATE (`WHERE status='pending'` + affected-row check). |
| 778 | Insufficient logging | ✅ | 15 audit event codes incl. login success/failure, lockouts, recovery, API-key denials, role operations (`modules/audit/logger.ts:134`). |
| 223 | Omission of security-relevant info | ✅ | Audit entries carry actor, IP, user-agent, requestId, timestamp. |
| 532 | Sensitive info in logs | ✅ | `maskSensitive` replaces secret fields with 8-char SHA-256 prefixes, recursively (`modules/audit/logger.ts:67`). |
| 548 | Directory listing | — | No static directory serving. |
| 668 | Resource exposed to wrong sphere | ✅ | **Fixed 2026-07-06.** `/health` reveals per-subsystem detail only to callers with the observability token; anonymous probes get `{ status }` only. `/metrics` enforces `METRICS_TOKEN` in all environments when set. |
| 1104 | Unmaintained third-party components | ✅ | **Fixed 2026-07-06.** Added `.github/dependabot.yml` (weekly npm + github-actions, grouped minor/patch) and a `dependency-audit` CI job that reports the full `pnpm audit` and fails on high/critical advisories. |
| 359 | Privacy violation | ✅ | **Fixed 2026-07-06.** The audit masker now redacts raw content-payload keys (`data`/`payload`/`content`/`body` → `[redacted]`) and caps long free-form strings, so item PII cannot land verbatim in audit metadata (`modules/audit/logger.ts`). Item audit events already logged only ids + redacted SQL. |

---

## Remediation backlog (priority order)

All items are complete as of 2026-07-06.

1. ~~**CWE-620/613 — Password change & session revocation.**~~ ✅ Change-password endpoint requiring the current password + `token_version` revocation on change/reset.
2. ~~**CWE-302 — Trust boundaries in middleware.**~~ ✅ `withSiteMembership` binds `X-Lumi-Site`; Cloudflare Access roles now mapped from the DB.
3. ~~**CWE-400 — API rate limiting.**~~ ✅ `withRateLimit()` per-principal/per-IP throttle on the authenticated API (covers REST + GraphQL, which share the chain).
4. ~~**CWE-521/203 — Registration hardening.**~~ ✅ Shared `PasswordSchema` (12+complexity) at register/setup/recovery; register validates with a 400. (Register is admin-only, so `EMAIL_ALREADY_EXISTS` is not an anonymous-enumeration vector.)
5. ~~**CWE-89 — Materialize DDL.**~~ ✅ `sql.raw()` replaced with bind parameters + `sql.identifier()`; trigger-body ids validated fail-closed.
6. ~~**CWE-362/367 — Atomic approval decide.**~~ ✅ `UPDATE … WHERE id = ? AND status = 'pending'` + affected-rows check.
7. ~~**CWE-1104 — Dependency hygiene.**~~ ✅ dependabot + a `pnpm audit` CI gate (fails on high/critical).
8. ~~**CWE-359 — Audit-log privacy.**~~ ✅ Payload keys redacted + long strings capped in the audit masker.
9. ~~**CWE-942 — Dev CORS.**~~ ✅ Never wildcard-with-credentials; only loopback reflected without an allowlist.
10. ~~**CWE-321 — CDC fallback key.**~~ ✅ In-repo fallback removed; fail-closed when `ENCRYPTION_KEY` is unset.
11. ~~**CWE-668/284 — Health & metrics.**~~ ✅ Subsystem detail gated behind the observability token; `/metrics` token-enforced in all envs.

### Future hardening (not blocking; beyond the top-100 scope)
- Precise per-endpoint API quotas via an atomic counter (Durable Object / Redis `INCR`) — the current limiter is a fixed-window approximation over the KV-style cache.
- Include audit logs in the data-erasure workflow (or publish an explicit retention/rotation policy) now that item PII is kept out of them.

## Related documents

- `docs/en/security/route-guards.md` — route-level guard inventory
- `docs/en/security/idor-testing.md` — IDOR test guidelines
- `docs/en/security/runtime-security-guards-plan.md` — guards roadmap
- `docs/en/security/external-jwt-auth.md` — external issuer verification
- `docs/en/security/dependency-overrides.md` — pinned dependency rationale
