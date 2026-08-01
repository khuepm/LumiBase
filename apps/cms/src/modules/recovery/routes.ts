/**
 * Recovery HTTP surface — PUBLIC, pre-auth account recovery for the
 * Bootstrap Admin (admin-setup-wizard task 10.7; Req 14.4, 14.5, 14.8;
 * design §4.7, §4.8).
 *
 *   POST /admin/security/recover     body `{ email, backupCode }`
 *   POST /admin/security/forgot-path body `{ email }`
 *
 * ── Why these endpoints are PUBLIC (no admin auth) ───────────────────────
 *
 * The whole point of recovery is that the operator is LOCKED OUT — they
 * can't authenticate, so these two routes must be reachable WITHOUT a
 * session and WITHOUT the `admin` role gate. That is the opposite of the
 * sibling `adminSecurityRouter` (`apps/cms/src/routes/admin-security.ts`),
 * whose `/unlock-user` + `/unblock-ip` routes are mounted UNDER the
 * authenticated `api` Hono (`withTenant` + `withAuth` + `withDb` +
 * `withRls`) and additionally require `roles` to contain `'admin'`.
 *
 * This router is therefore modelled on `setupRouter`
 * (`apps/cms/src/modules/setup/routes.ts`): it is a standalone
 * `Hono<AppEnv>` that applies ONLY `withDb()` internally (no tenant, no
 * auth) and is mounted on the TOP-LEVEL `app` in
 * `apps/cms/src/index.ts` — NOT on the authenticated `api`. `withRuntime`
 * has already run globally, so the per-request `withDb()` here resolves
 * the Drizzle client through the runtime's DatabaseProvider exactly like
 * the setup wizard does on a fresh instance.
 *
 * ── Mounting / routing-precedence decision (read before moving routes) ───
 *
 * In `index.ts` this router is mounted at `/api/v1/admin/security`
 * *before* `app.route('/api/v1', api)` (which contains the AUTHENTICATED
 * `adminSecurityRouter` mounted at `/admin/security`). Hono flattens all
 * `app.route(...)` sub-apps into a single router and matches by
 * METHOD + exact path, so registration is by leaf path, not by mount
 * prefix:
 *
 *   - `POST /api/v1/admin/security/recover`      → THIS public router.
 *   - `POST /api/v1/admin/security/forgot-path`  → THIS public router.
 *   - `POST /api/v1/admin/security/unlock-user`  → authenticated `api`.
 *   - `POST /api/v1/admin/security/unblock-ip`   → authenticated `api`.
 *
 * Because the four leaf paths are DISJOINT, mounting the public router
 * first cannot shadow the authenticated `/unlock-user` + `/unblock-ip`
 * routes: a request to those paths simply never matches a handler in
 * this router (it only registers `/recover` + `/forgot-path`), so it
 * falls through to the authenticated `api` mount and still passes
 * through `withAuth` + the `admin` gate. This is the SAME mechanism that
 * lets the public `setupRouter` (`/api/v1/setup`) coexist with the
 * authenticated `/api/v1/*` surface today. The accompanying route tests
 * (`__tests__/routes.test.ts`) pin this behaviour: `/recover` +
 * `/forgot-path` resolve publicly while an unrelated
 * `/admin/security/unlock-user` path does NOT match this router.
 *
 * (We register `before` the catch-all purely for clarity/robustness;
 * since the leaf paths are disjoint, order does not actually change the
 * match for these four paths. The disjoint-path argument — not ordering —
 * is what guarantees non-shadowing.)
 *
 * ── Rate limit FIRST, then validate, then service (Req 14.8) ─────────────
 *
 * Both endpoints share ONE 3-requests/IP/hour budget (Req 14.8 — combined
 * across `/recover` AND `/forgot-path`). The shared {@link
 * checkRecoveryRateLimit} is consulted FIRST on every request — before
 * body parsing or any DB work — so an attacker can't burn cycles or
 * probe behind a denied request, and a single IP can't double its budget
 * by splitting a brute-force burst across the two paths. A denied request
 * returns `429 { errors: [{ code: 'RATE_LIMITED' }] }` with the
 * `Retry-After` header via {@link recoveryRateLimitHeaders}.
 *
 * ── Anti-enumeration (Req 14.4, 14.5) ────────────────────────────────────
 *
 * The service owns the security-sensitive behaviour; the route just maps
 * results to HTTP:
 *
 *   - `recover` → the service applies a uniform 200–500ms random delay on
 *     EVERY branch (success and failure alike) and returns `null` for any
 *     failure. The route maps a non-null result to `200 { data: {
 *     adminPath, oneTimeUnlockToken } }` and `null` to `401 { errors: [{
 *     code: 'INVALID_BACKUP_CODE' }] }` (generic body — never reveals
 *     whether the email existed or the code was wrong).
 *   - `forgotPath` → the service returns `void` on every path (never
 *     throws, applies its own delay), so the route ALWAYS returns
 *     `200 { data: { sent: true } }`. It never reveals whether the email
 *     matched the Bootstrap Admin.
 *
 * A malformed JSON body / failed Zod parse still returns a `400
 * VALIDATION_ERROR` (matching the setup routes). That's acceptable: the
 * anti-enumeration concern is the *email-exists* signal, not the JSON
 * shape — a 400 for a structurally-broken request leaks nothing about
 * which accounts exist.
 *
 * ── Service wiring ───────────────────────────────────────────────────────
 *
 * {@link buildService} constructs a {@link RecoveryService} bound to the
 * per-request Drizzle client, honouring a test-only
 * `recoveryServiceOverride` on the context (mirrors the
 * `setupServiceOverride` convention in `setup/routes.ts`) so the handlers
 * are unit-testable without Postgres. The service defaults its unlock /
 * recovery token stores to the process-shared in-memory instances and
 * its email sender to the no-op {@link NoopRecoveryEmailSender}; per
 * design §12.3 / §4.8, `forgot-path` returns a generic 200 regardless of
 * whether a real email channel is configured, so the default no-op sender
 * is correct for now. Wiring a real sender backed by
 * `EmailChannelFactory.fromEnv(c.env)` plus a recovery-email template is
 * a follow-up (tracked with the StepRecovery / Studio recovery pages,
 * task 10.8) and does NOT change this route's observable contract.
 *
 * The client IP is resolved with {@link extractClientIp} from
 * `login-guard/ip-extract` (the Hono-context form) — deliberately the
 * SAME helper the LoginGuard uses to WRITE `login_attempts.ip`. The
 * recovery service drains those exact rows on success, so reusing this
 * extractor keeps the rate-limit key and the unblock target in the same
 * canonical IP form.
 *
 * Validates: Requirements 14.4, 14.5, 14.8 — design §4.7, §4.8.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { PasswordSchema } from '@lumibase/contracts/schemas';
import { eq, sql } from 'drizzle-orm';
import { users } from '@lumibase/database';

import type { AppEnv } from '../../env';
import { withDb } from '../../middleware/db';
import { hashPassword } from '../../services/auth/password';
import { extractClientIp } from '../login-guard/ip-extract';
import { AuditLogger } from '../audit/logger';
import { RecoveryService } from './service';
import {
  checkRecoveryRateLimit,
  recoveryRateLimitHeaders,
  RECOVERY_RATE_LIMIT_CODE,
} from './rate-limit';

// ── input schemas ────────────────────────────────────────────────────────

/**
 * `/recover` body. `email` mirrors the auth surface (RFC 5321 254-char
 * envelope cap + `z.string().email()`); `backupCode` is a non-empty
 * string capped at 64 chars — comfortably above the `XXXX-XXXX` (9-char)
 * format so a malformed request can't waste a PBKDF2 scan, while not
 * leaking the exact code shape.
 */
const recoverBodySchema = z.object({
  email: z.string().email().max(254),
  backupCode: z.string().min(1).max(64),
});

/** `/forgot-path` body — just the email, same cap as `/recover`. */
const forgotPathBodySchema = z.object({
  email: z.string().email().max(254),
});

const resetPasswordBodySchema = z.object({
  unlockToken: z.string().min(1).max(256),
  // Shared strength policy (min 12 + complexity) — single source of truth.
  password: PasswordSchema,
});

// ── service factory ───────────────────────────────────────────────────────

/**
 * Build a {@link RecoveryService} bound to the per-request Drizzle
 * client. Honours a test-only `recoveryServiceOverride` on the context
 * (set before the router runs) so suites can inject a stub with canned
 * `recover` / `forgotPath` — mirrors the `setupServiceOverride`
 * convention documented in `setup/routes.ts`.
 *
 * The default service relies on its own constructor defaults for the
 * unlock / recovery token stores (process-shared in-memory) and the
 * email sender (no-op). Wiring a real `EmailChannelFactory.fromEnv`
 * sender is a follow-up (task 10.8) and does not change the route
 * contract — `forgot-path` returns a generic 200 either way.
 */
function buildService(
  c: Context<AppEnv>,
): NonNullable<AppEnv['Variables']['recoveryServiceOverride']> {
  const override = c.get('recoveryServiceOverride');
  if (override) return override;
  // Wire the real AuditLogger (task 11.2; Req 15.1, 15.2) so the
  // service can emit `recovery_initiated` (forgot-path match) and
  // `recovery_completed` + `backup_code_used` (recover success). The
  // logger is best-effort + never-throws, so it can never break the
  // anti-enumeration / anti-timing contract of the recovery flow.
  return new RecoveryService({
    db: c.get('db'),
    audit: new AuditLogger({ db: c.get('db') }),
  });
}

// ── router ─────────────────────────────────────────────────────────────────

export const recoveryRouter = new Hono<AppEnv>();

// Public surface: only `withDb()` (no tenant, no auth) — the operator is
// locked out and can't authenticate. `withRuntime` ran globally, so this
// resolves the Drizzle client the same way `setupRouter` does.
recoveryRouter.use('*', withDb());

// ── POST /recover (Req 14.4; design §4.7) ─────────────────────────────────

recoveryRouter.post('/recover', async (c) => {
  // 1. Rate limit FIRST — before parsing or any DB work (Req 14.8). The
  //    budget is SHARED with /forgot-path via the same module-level
  //    counter keyed by IP alone.
  const ip = extractClientIp(c);
  const limit = checkRecoveryRateLimit(ip);
  if (!limit.allowed) {
    return c.json(
      { errors: [{ code: RECOVERY_RATE_LIMIT_CODE }] },
      429,
      recoveryRateLimitHeaders(limit.retryAfterSeconds ?? 0),
    );
  }

  // 2. Parse + validate the body. A malformed body yields a generic 400
  //    VALIDATION_ERROR (matches the setup routes). This leaks nothing
  //    about which emails exist — the anti-enumeration guarantee is in
  //    the service's null→401 mapping below, not the JSON-shape check.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { errors: [{ code: 'VALIDATION_ERROR', message: 'invalid JSON' }] },
      400,
    );
  }
  const parsed = recoverBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }

  // 3. Delegate to the service. It applies the 200–500ms random delay
  //    internally on BOTH success and failure, and collapses every
  //    failure branch (unknown email, non-bootstrap, no matching code,
  //    inconsistent state, internal error) to `null`. The route only
  //    maps non-null → 200 and null → 401 generic (design §4.7 error
  //    table: INVALID_BACKUP_CODE → 401).
  const svc = buildService(c);
  const result = await svc.recover(parsed.data.email, parsed.data.backupCode, ip);
  if (!result) {
    return c.json({ errors: [{ code: 'INVALID_BACKUP_CODE' }] }, 401);
  }

  return c.json(
    {
      data: {
        adminPath: result.adminPath,
        oneTimeUnlockToken: result.oneTimeUnlockToken,
      },
    },
    200,
  );
});

// ── POST /forgot-path (Req 14.5; design §4.8) ─────────────────────────────

recoveryRouter.post('/forgot-path', async (c) => {
  // 1. Rate limit FIRST — shares the SAME 3/IP/hour budget as /recover
  //    (Req 14.8). Denied → 429 + Retry-After.
  const ip = extractClientIp(c);
  const limit = checkRecoveryRateLimit(ip);
  if (!limit.allowed) {
    return c.json(
      { errors: [{ code: RECOVERY_RATE_LIMIT_CODE }] },
      429,
      recoveryRateLimitHeaders(limit.retryAfterSeconds ?? 0),
    );
  }

  // 2. Parse + validate. As with /recover, a malformed body is a generic
  //    400 — it reveals nothing about which emails exist.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { errors: [{ code: 'VALIDATION_ERROR', message: 'invalid JSON' }] },
      400,
    );
  }
  const parsed = forgotPathBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }

  // 3. Fire-and-forget the service (it never throws and applies its own
  //    delay). We ALWAYS return the same generic 200 regardless of
  //    whether the email matched the Bootstrap Admin — anti-enumeration
  //    (Req 14.5 / design §4.8). The service is a silent no-op for
  //    unknown emails, non-bootstrap matches, or a missing email channel.
  const svc = buildService(c);
  await svc.forgotPath(parsed.data.email, ip);

  return c.json({ data: { sent: true } }, 200);
});

// ── POST /reset-password ─────────────────────────────────────────────────

recoveryRouter.post('/reset-password', async (c) => {
  const ip = extractClientIp(c);
  const limit = checkRecoveryRateLimit(ip);
  if (!limit.allowed) {
    return c.json(
      { errors: [{ code: RECOVERY_RATE_LIMIT_CODE }] },
      429,
      recoveryRateLimitHeaders(limit.retryAfterSeconds ?? 0),
    );
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { errors: [{ code: 'VALIDATION_ERROR', message: 'invalid JSON' }] },
      400,
    );
  }

  const parsed = resetPasswordBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }

  const svc = buildService(c);
  const consumed = await svc.validateUnlockToken(parsed.data.unlockToken);
  if (!consumed) {
    return c.json({ errors: [{ code: 'INVALID_RECOVERY_TOKEN' }] }, 401);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await c
    .get('db')
    .update(users)
    .set({
      passwordHash,
      lockedUntil: null,
      failedCount: 0,
      failedCountWindowStart: null,
      // Revoke every outstanding token for this user on reset (CWE-613).
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, consumed.userId));

  return c.json({ data: { reset: true } }, 200);
});
