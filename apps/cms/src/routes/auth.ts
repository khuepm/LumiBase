import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { roles, systemState, users, userSites } from '@lumibase/database';
import type { AppEnv } from '../env';
import { hashPassword, verifyPassword } from '../services/auth/password';
import { ensureSubscriberRole } from '../services/auth/frontend-role';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import {
  signVerificationToken,
  verifyVerificationToken,
} from '../services/auth/email-verification';
import {
  signPasswordResetToken,
  verifyPasswordResetToken,
} from '../services/auth/password-reset';
import { sendVerificationEmail } from '../modules/email/verify-email';
import { sendPasswordResetEmail } from '../modules/email/password-reset';
import {
  checkRegistrationRate,
  checkIpRateLimit,
  DEFAULT_REGISTRATION_RATE_LIMIT,
} from '../modules/auth/registration-guard';
import {
  loginGuardMiddleware,
  loadLockoutPolicyFromSettings,
} from '../modules/login-guard/middleware';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import {
  createCounterStore,
} from '../modules/login-guard/counter';
import { normalizeEmail } from '../modules/login-guard/email-normalize';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';
import {
  recordLoginFailure,
  recordLoginSuccess,
  recordAnomalyBlock,
} from '../modules/login-guard/hooks';
import {
  runDetectors,
} from '../modules/anomaly/detector';
import { createGeoSubscore } from '../modules/anomaly/geo';
import { createTimeSubscore } from '../modules/anomaly/time';
import { createDeviceSubscore } from '../modules/anomaly/device';
import type { LoginAttemptDraft } from '../modules/anomaly/types';
import { getSecurityNotificationDispatcher, scheduleWorkersDrain } from '../modules/notifications/security-dispatcher';
import type { NotificationDeps } from '../modules/login-guard/hooks';
import { AuditLogger } from '../modules/audit/logger';
import { formatSafeError } from '@lumibase/shared/utils';

export const authRouter = new Hono<AppEnv>();

/**
 * `meRouter` — current-user surface for things that don't fit naturally
 * under `/auth/*`. Mounted at `/api/v1/me` from `index.ts` (see
 * `app.route('/api/v1', api)` and `api.route('/me', meRouter)` for the
 * mount; the `withAuth` middleware on the `api` Hono instance already
 * enforces authentication).
 *
 * Co-located here on purpose: the admin-setup-wizard task 4.4 (Req 4.7;
 * design §7.3) calls out this file as the home for the endpoint, and
 * keeping the bootstrap-admin secret-handling routes in one place makes
 * it easier to spot-check that none of them accidentally leak the
 * Admin_Path. The router is mounted at `/api/v1/me` (not under `/auth`)
 * to honour the URL contract specified in design §7.3 — the Studio
 * calls `GET /api/v1/me/admin-path` post-login to render the bookmark
 * that lets an operator return to the custom path on a fresh browser.
 */
export const meRouter = new Hono<AppEnv>();

/**
 * `GET /api/v1/me/admin-path` — return the configured Admin_Path so the
 * authenticated Studio can show a "save this bookmark" reminder.
 *
 * Design notes (admin-setup-wizard Req 4.7; design §7.3):
 *
 *   - The Admin_Path is treated as a secret. Per design §7.3 it MUST
 *     never be embedded in the Studio bundle (Vite assertion in task
 *     4.8) or in any unauthenticated response — the only legitimate
 *     way for a Studio session to learn the path is via this endpoint
 *     after the user has authenticated.
 *
 *   - Authentication is enforced upstream by the `withAuth` middleware
 *     applied to the `api` Hono instance in `index.ts`. We deliberately
 *     do not re-check `c.get('auth')` here: a missing principal would
 *     mean `withAuth` is misconfigured, which is a deployment bug, not
 *     a runtime branch we want to silently paper over by issuing a
 *     second 401.
 *
 *   - We return the path inside the project's standard `{ data: { ... } }`
 *     envelope (matching `/auth/me` and the rest of the surface) rather
 *     than a bare `{ adminPath }` so callers that already understand
 *     the envelope don't need a one-off serializer. The task brief
 *     literally says "return `{ adminPath }`" — semantically the same
 *     payload, just wrapped to stay idiomatic.
 *
 *   - When the instance is still `uninitialized` (or the row predates a
 *     migration), `system_state.admin_path` is `NULL`. That's not an
 *     "auth failed" case so we return 404 `ADMIN_PATH_UNAVAILABLE`
 *     rather than 401/500, which lets the Studio render a clearer
 *     "instance not yet bootstrapped" empty state.
 */
meRouter.get('/admin-path', async (c) => {
  const db = c.get('db');

  const rows = await db
    .select({ adminPath: systemState.adminPath })
    .from(systemState)
    .where(eq(systemState.id, 'singleton'))
    .limit(1);

  const adminPath = rows[0]?.adminPath ?? null;
  if (!adminPath) {
    return c.json(
      {
        errors: [
          {
            code: 'ADMIN_PATH_UNAVAILABLE',
            message: 'Admin path is not configured for this instance.',
          },
        ],
      },
      404,
    );
  }

  return c.json({ data: { adminPath } });
});

// Helper to sign Custom JWT (HS256).
//
// The `audience` (`aud` claim) pins which realm the session token belongs
// to — `studio` for staff with Studio access, `frontend` for self-service
// subscribers. `withStudioAccess` rejects `frontend` tokens outright, so a
// subscriber token can never be replayed against the management surface
// even if a policy were misconfigured (defense-in-depth). See
// `services/auth/token-audience.ts`.
async function signCustomJwt(
  payload: any,
  secret: string,
  audience: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secretKey);
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resendVerificationSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

/**
 * Public self-service registration for FRONTEND end-users (the people who
 * sign up on the consumer Next.js site to read content). This is a
 * separate realm from staff onboarding: staff are created invite-only via
 * `POST /api/v1/users/invite` (admin-gated, `member`/`administrator`
 * roles with Studio access). This endpoint is intentionally
 * unauthenticated and is bypassed by `withAuth` / `withStudioAccess` like
 * `/login`.
 *
 * Guardrails (see ADR 0001 — user-management realms):
 *   1. Least-privilege role is resolved SERVER-SIDE
 *      ({@link ensureSubscriberRole}) — the request body can never choose
 *      a role, so a self-registered visitor can never get Studio/admin.
 *   2. The account starts `status: 'invited'` (inactive) and must verify
 *      its email before `/login` will issue a token (login already gates
 *      on `status === 'active'`).
 *   3. Per-IP rate limit brakes scripted mass-registration.
 *   4. Anti-enumeration: the response is an identical generic 202 whether
 *      or not the email already exists. We only create + email on a new,
 *      valid email.
 */
authRouter.post('/register', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  // (3) Best-effort per-IP abuse brake. Runs before body parse / hashing
  // so a flood is cheap to reject.
  const rate = await checkRegistrationRate(c.get('runtime').cache, siteId, ip);
  if (!rate.allowed) {
    return c.json(
      {
        errors: [
          {
            code: 'RATE_LIMITED',
            message: 'Too many registration attempts. Please try again later.',
            retryAfterSeconds: rate.retryAfterSeconds,
          },
        ],
      },
      429,
    );
  }

  const body = await c.req.json();
  const input = registerSchema.parse(body);
  const emailLower = normalizeEmail(input.email);

  const audit = new AuditLogger({ db, siteId });

  // (4) Anti-enumeration: look the user up but DON'T branch the response on
  // it. Only a brand-new email triggers the create + verification email;
  // an existing email silently falls through to the same generic 202.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);

  if (!existing) {
    const passwordHash = await hashPassword(input.password);
    // (1) Server-resolved least-privilege role. Never from the body.
    const subscriberRoleId = await ensureSubscriberRole(db, siteId);

    const [newUser] = await db
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        // (2) Inactive until email verification flips it to 'active'.
        status: 'invited',
      })
      .returning({ id: users.id, email: users.email });

    if (newUser) {
      await db
        .insert(userSites)
        .values({ userId: newUser.id, siteId, roleId: subscriberRoleId })
        .onConflictDoNothing();

      // Stateless verification token (no DB row); emailed inside the link.
      const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
      if (jwtSecret) {
        const token = await signVerificationToken(
          { userId: newUser.id, siteId },
          jwtSecret,
        );
        // Best-effort, fire-and-forget AFTER the row is committed so a mail
        // failure can't roll the registration back.
        const sendMail = sendVerificationEmail({
          db,
          siteId,
          env: c.env,
          email: input.email,
          token,
        });
        if (c.executionCtx?.waitUntil) {
          c.executionCtx.waitUntil(sendMail);
        } else {
          void sendMail;
        }
      }

      await audit.write({
        event: 'user_registered',
        actorEmail: input.email,
        ip,
        userAgent,
        requestId: c.get('requestId') ?? null,
        metadata: {
          userId: newUser.id,
          siteId,
          roleId: subscriberRoleId,
          selfService: true,
        },
      });
    }
  }

  return c.json(
    {
      data: {
        status: 'pending_verification',
        message:
          'If this email is eligible, a verification link has been sent. ' +
          'Confirm it to activate your account.',
      },
    },
    202,
  );
});

/**
 * Public email-verification endpoint. Completes self-service
 * registration by flipping the user from `invited` → `active`.
 *
 * The token is a stateless HS256 JWT minted at registration
 * ({@link signVerificationToken}); single-use is enforced by the state
 * transition (an already-`active` account returns `already_verified`).
 * Bypassed by `withAuth` / `withStudioAccess` like `/login` + `/register`.
 */
authRouter.post('/verify-email', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500,
    );
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const token =
    typeof body?.token === 'string' && body.token.length > 0
      ? body.token
      : c.req.query('token') ?? '';

  const claims = token ? await verifyVerificationToken(token, jwtSecret) : null;
  // The token is bound to the site it was issued for; reject expired,
  // tampered, wrong-audience, or cross-tenant tokens with one generic code.
  if (!claims || claims.siteId !== siteId) {
    return c.json(
      { errors: [{ code: 'INVALID_TOKEN', message: 'Verification link is invalid or has expired.' }] },
      400,
    );
  }

  const [user] = await db
    .select({ id: users.id, status: users.status, email: users.email })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);

  if (!user) {
    return c.json(
      { errors: [{ code: 'INVALID_TOKEN', message: 'Verification link is invalid or has expired.' }] },
      400,
    );
  }

  if (user.status === 'active') {
    return c.json({ data: { status: 'already_verified' } });
  }
  if (user.status === 'suspended') {
    return c.json(
      { errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] },
      403,
    );
  }

  await db
    .update(users)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await new AuditLogger({ db, siteId }).write({
    event: 'email_verified',
    actorEmail: user.email,
    ip,
    userAgent,
    requestId: c.get('requestId') ?? null,
    metadata: { userId: user.id, siteId, selfService: true },
  });

  return c.json({ data: { status: 'verified' } });
});

/**
 * Public "resend verification" endpoint — re-issues the activation email
 * when the original was lost. Same guardrails as forgot-password:
 * per-IP rate-limited and a generic `202` regardless of outcome (no
 * enumeration). Only an existing, NOT-yet-active, password-based account
 * (i.e. a self-service registrant still at `invited`) is re-emailed; an
 * already-active or non-password (SSO/staff-invite) account silently falls
 * through. Bypassed by `withAuth` / `withStudioAccess` like the other
 * public auth routes.
 */
authRouter.post('/resend-verification', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  const rate = await checkIpRateLimit(
    c.get('runtime').cache,
    'resend-rate',
    siteId,
    ip,
    DEFAULT_REGISTRATION_RATE_LIMIT,
  );
  if (!rate.allowed) {
    return c.json(
      {
        errors: [
          {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please try again later.',
            retryAfterSeconds: rate.retryAfterSeconds,
          },
        ],
      },
      429,
    );
  }

  const body = await c.req.json();
  const input = resendVerificationSchema.parse(body);
  const emailLower = normalizeEmail(input.email);

  const [user] = await db
    .select({ id: users.id, status: users.status, passwordHash: users.passwordHash, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);

  // Eligible = exists, not yet activated, and password-based (a self-service
  // registrant). Active accounts have nothing to verify; passwordless
  // accounts (SSO / staff invite) use a different onboarding path.
  if (user && user.status !== 'active' && user.passwordHash) {
    const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
    if (jwtSecret) {
      const token = await signVerificationToken({ userId: user.id, siteId }, jwtSecret);
      const sendMail = sendVerificationEmail({
        db,
        siteId,
        env: c.env,
        email: user.email,
        token,
      });
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(sendMail);
      } else {
        void sendMail;
      }
      await new AuditLogger({ db, siteId }).write({
        event: 'verification_resent',
        actorEmail: user.email,
        ip,
        userAgent,
        requestId: c.get('requestId') ?? null,
        metadata: { userId: user.id, siteId },
      });
    }
  }

  return c.json(
    {
      data: {
        status: 'verification_resent',
        message: 'If this email needs verification, a new link has been sent.',
      },
    },
    202,
  );
});

/**
 * Public "forgot password" endpoint for self-service end-users.
 *
 * Anti-enumeration: always returns the same generic `202` regardless of
 * whether the email exists or is eligible. Only an existing, active,
 * password-based account actually gets a reset email. Per-IP rate-limited.
 * Bypassed by `withAuth` / `withStudioAccess` like the other public auth
 * routes.
 */
authRouter.post('/forgot-password', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  const rate = await checkIpRateLimit(
    c.get('runtime').cache,
    'forgot-rate',
    siteId,
    ip,
    DEFAULT_REGISTRATION_RATE_LIMIT,
  );
  if (!rate.allowed) {
    return c.json(
      {
        errors: [
          {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please try again later.',
            retryAfterSeconds: rate.retryAfterSeconds,
          },
        ],
      },
      429,
    );
  }

  const body = await c.req.json();
  const input = forgotPasswordSchema.parse(body);
  const emailLower = normalizeEmail(input.email);

  const [user] = await db
    .select({ id: users.id, status: users.status, passwordHash: users.passwordHash, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);

  // Only mint + email for an eligible account. A non-existent, inactive, or
  // passwordless (SSO/CF Access) account silently falls through to the same
  // generic response — no enumeration, no reset for accounts that don't use
  // password auth.
  if (user && user.status === 'active' && user.passwordHash) {
    const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
    if (jwtSecret) {
      const token = await signPasswordResetToken({ userId: user.id, siteId }, jwtSecret);
      const sendMail = sendPasswordResetEmail({
        db,
        siteId,
        env: c.env,
        email: user.email,
        token,
      });
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(sendMail);
      } else {
        void sendMail;
      }
      await new AuditLogger({ db, siteId }).write({
        event: 'password_reset_requested',
        actorEmail: user.email,
        ip,
        userAgent,
        requestId: c.get('requestId') ?? null,
        metadata: { userId: user.id, siteId },
      });
    }
  }

  return c.json(
    {
      data: {
        status: 'reset_requested',
        message: 'If an account exists for this email, a reset link has been sent.',
      },
    },
    202,
  );
});

/**
 * Public "reset password" endpoint. Consumes a stateless `password-reset`
 * token ({@link signPasswordResetToken}) and sets the new password hash.
 * Bypassed by `withAuth` / `withStudioAccess` like the other public auth
 * routes.
 */
authRouter.post('/reset-password', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500,
    );
  }

  const body = await c.req.json();
  const input = resetPasswordSchema.parse(body);

  const claims = await verifyPasswordResetToken(input.token, jwtSecret);
  // Reject expired / tampered / wrong-audience / cross-tenant tokens with
  // one generic code.
  if (!claims || claims.siteId !== siteId) {
    return c.json(
      { errors: [{ code: 'INVALID_TOKEN', message: 'Reset link is invalid or has expired.' }] },
      400,
    );
  }

  const [user] = await db
    .select({ id: users.id, status: users.status, email: users.email })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);

  if (!user) {
    return c.json(
      { errors: [{ code: 'INVALID_TOKEN', message: 'Reset link is invalid or has expired.' }] },
      400,
    );
  }
  if (user.status === 'suspended') {
    return c.json(
      { errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] },
      403,
    );
  }

  const passwordHash = await hashPassword(input.password);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await new AuditLogger({ db, siteId }).write({
    event: 'password_reset_completed',
    actorEmail: user.email,
    ip,
    userAgent,
    requestId: c.get('requestId') ?? null,
    metadata: { userId: user.id, siteId },
  });

  return c.json({ data: { status: 'reset' } });
});

// Login Guard middleware (admin-setup-wizard task 6.1; Req 7.3, 8.3;
// design §6.2). Mounted on `/login` only — the rate-limit and account
// lockout checks are scoped to this single route. The middleware
// reads `c.req.json()` to peek at the email; Hono caches the parsed
// body so the handler below re-reads the same payload without an
// extra parse.
authRouter.use('/login', loginGuardMiddleware());

/**
 * Lazily-built dummy PBKDF2 hash, computed once per process.
 *
 * Used for the no-such-user branch of `/login` so the response time
 * profile matches the password-verify branch (Req 7.5 — no user
 * enumeration). Without this, an attacker could distinguish "email
 * exists" from "email doesn't exist" by timing the response: the
 * existing-email branch spends ~100ms on PBKDF2 while the missing-
 * email branch returns immediately.
 *
 * The hash is over a string the user can never type in (a random
 * 32-byte value), so {@link verifyPassword} always returns `false`.
 * The dummy hash is computed lazily on the first failed login so the
 * cold-start cost doesn't pad the first successful login.
 */
let DUMMY_PASSWORD_HASH: string | null = null;
async function getDummyPasswordHash(): Promise<string> {
  if (DUMMY_PASSWORD_HASH) return DUMMY_PASSWORD_HASH;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedStr = Array.from(seed)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  DUMMY_PASSWORD_HASH = await hashPassword(seedStr);
  return DUMMY_PASSWORD_HASH;
}

/**
 * Artificial login-failure stall (Directus parity: `LOGIN_STALL_TIME`).
 *
 * Distinct from the dummy-hash timing parity above: that one makes the
 * "no such user" and "wrong password" branches take the *same* time so
 * an attacker can't enumerate accounts. This one floors *both* failure
 * branches at a fixed wall clock (`policy.loginStallMs`, default 500ms)
 * so each credential guess is deliberately slow — a brute-force speed
 * brake layered on top of the rate-limit / lockout guard.
 *
 * We resolve a plain `setTimeout` promise and `await` it before the
 * route returns the 401. This is intentionally a wall-clock delay, not
 * busy work: on Node it parks the request, and on Cloudflare Workers it
 * holds the response without consuming CPU budget (idle time inside a
 * fetch handler isn't billed as CPU). `0` skips the timer entirely so a
 * disabled stall adds no overhead and no extra microtask tick.
 */
export async function stallLoginFailure(stallMs: number): Promise<void> {
  if (!Number.isFinite(stallMs) || stallMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, stallMs));
}

// Custom Login (for Frontend Users)
authRouter.post('/login', async (c) => {
  const db = c.get('db');
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500
    );
  }

  // Hono caches the parsed body, so this re-read doesn't re-parse the
  // stream that the LoginGuard middleware consumed.
  const body = await c.req.json();
  const input = loginSchema.parse(body);

  // Email normalisation (admin-setup-wizard Req 7.1, design §6.5):
  // delegate to the shared `normalizeEmail` helper so the
  // sliding-window counter (`loginAttempts.emailLower`), the
  // no-enumeration `users` SELECT, and the LoginGuard middleware all
  // key on the exact same canonical form. Drift across these call
  // sites would silently break lockout transitions.
  const emailLower = normalizeEmail(input.email);
  const ip = extractClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  // Resolve the policy + counter once per request. Both are cheap to
  // construct (the counter is just a wrapper around `db`), and we
  // want the failure hook and the IP/threshold checks to use the
  // exact same instance.
  const policy = await loadLockoutPolicyFromSettings(db).catch(
    () => freshStandardPolicy(),
  );
  const counter = createCounterStore(db, readCounterEnv(c.env));

  // Notification wiring (task 9.5; Req 13.1; design §6.3). Resolve the
  // process-level dispatcher and register the email + webhook channels
  // from the current env + policy. The `notify` bundle is threaded
  // into the LoginGuard hooks so the four security events
  // (`user_locked`, `ip_blocked`, `anomaly_triggered`, `anomaly_lock`)
  // reach `policy.notifyChannels`. Dispatch is best-effort and
  // non-blocking — the hooks swallow any delivery error so a failed
  // notification can never fail the login (Req 13.4). The dispatcher
  // singleton owns its own background drain on Node; the Workers drain
  // path (`ctx.waitUntil`) is task 9.6.
  const dispatcher = getSecurityNotificationDispatcher(c.env, policy);
  // Audit wiring (task 11.2; Req 15.1, 15.2; design §10.1). Construct
  // one AuditLogger per request bound to the per-request Drizzle client
  // and thread it into the LoginGuard hooks via the same `notify`
  // bundle that carries the dispatcher. `AuditLogger.write` is
  // best-effort + never-throws, so the audit entries the hooks emit
  // (`login_failed`, `login_success`, `user_locked`, `ip_blocked`,
  // `anomaly_triggered`) can never break the login flow. `requestId` is
  // resolved from the context (populated by the `audit-context`
  // middleware) so each audit row carries its correlation id.
  const audit = new AuditLogger({ db, siteId: c.get('siteId') });
  const notify: NotificationDeps = {
    dispatcher,
    notifyChannels: policy.notifyChannels,
    audit,
    requestId: c.get('requestId'),
  };

  // Look the user up case-insensitively so a `Foo@Example.com` row
  // matches a `foo@example.com` request body. This matches the
  // future `users_email_lower_unique` index from design §3.1.
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);

  if (!user || !user.passwordHash) {
    // Run a PBKDF2 verify against the dummy hash so the
    // missing-user branch matches the existing-user branch in CPU
    // time (Req 7.5). The verify always returns false, but we don't
    // even check the result — the only point is the wall clock.
    await verifyPassword(input.password, await getDummyPasswordHash());

    await recordLoginFailure(
      db,
      counter,
      policy,
      {
        email: emailLower,
        ip,
        reason: 'invalid_credentials',
        userAgent,
        userId: null,
      },
      new Date(),
      notify,
    );

    // Workers runtime: keep any queued notifications alive past the
    // response via ctx.waitUntil (task 9.6). No-op on Node / tests.
    scheduleWorkersDrain(c, dispatcher, c.env);

    // Brute-force speed brake (Directus `LOGIN_STALL_TIME` parity). The
    // audit/counter writes above already happened; we only delay the
    // 401 the client sees. Runs after `scheduleWorkersDrain` so the
    // background notification drain isn't held behind the stall.
    await stallLoginFailure(policy.loginStallMs);

    return c.json(
      { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }] },
      401
    );
  }

  const isValid = await verifyPassword(input.password, user.passwordHash);
  if (!isValid) {
    await recordLoginFailure(
      db,
      counter,
      policy,
      {
        email: emailLower,
        ip,
        reason: 'invalid_credentials',
        userAgent,
        userId: user.id,
      },
      new Date(),
      notify,
    );

    // Workers runtime: drain queued notifications after the response.
    scheduleWorkersDrain(c, dispatcher, c.env);

    // Brute-force speed brake (Directus `LOGIN_STALL_TIME` parity) — see
    // the no-such-user branch above. Same fixed wall clock so the two
    // INVALID_CREDENTIALS branches stay timing-indistinguishable.
    await stallLoginFailure(policy.loginStallMs);

    return c.json(
      { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }] },
      401
    );
  }

  if (user.status !== 'active') {
    return c.json(
      { errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] },
      403,
    );
  }

  const siteId = c.get('siteId');
  const [membership] = await db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, user.id), eq(userSites.siteId, siteId)))
    .limit(1);

  if (!membership && !user.isBootstrap) {
    return c.json(
      { errors: [{ code: 'TENANT_ACCESS_DENIED', message: 'This account is not a member of the selected site.' }] },
      403,
    );
  }

  const tokenRoles = user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'];

  // Resolve the token AUDIENCE (`aud` claim) from the principal's realm.
  // The bootstrap admin and any role with `appAccess` get a `studio`
  // token; everyone else (subscribers / appAccess-less roles) gets a
  // `frontend` token that `withStudioAccess` refuses. This is computed
  // here — at sign time — so the wall holds regardless of how the policy
  // bundle is later evaluated. See `services/auth/token-audience.ts`.
  let appAccess = user.isBootstrap;
  if (!appAccess && membership?.roleId) {
    const [roleRow] = await db
      .select({ appAccess: roles.appAccess })
      .from(roles)
      .where(and(eq(roles.id, membership.roleId), eq(roles.siteId, siteId)))
      .limit(1);
    appAccess = roleRow?.appAccess ?? false;
  }
  const audience = appAccess ? TOKEN_AUDIENCE.studio : TOKEN_AUDIENCE.frontend;

  // ── Anomaly detection (task 8.1; Req 12.2-12.5; design §8.5) ───────
  //
  // The credentials are valid, but before we issue the JWT we need to
  // check whether the request looks suspicious enough that the
  // configured `anomalyAction` says we should reject it (or at least
  // record it for audit). The detectors share the same
  // `LoginAttemptDraft` so the geo/device modules can populate
  // `countryCode`, `geoLookupStatus`, `deviceFingerprint`,
  // `deviceLookupStatus` as a side effect of scoring — we then hand
  // the draft to whichever hook persists the row, ensuring a single
  // canonical `login_attempts` insert per attempt.
  //
  // `runDetectors` runs the three subscores under policy gating; an
  // axis with `*AnomalyEnabled=false` short-circuits to
  // `DISABLED_SUBSCORE` without invoking the detector function. If
  // the aggregator throws (DB pool blip during baseline read, MMDB
  // open failure mid-request), we fall back to "no anomaly": the
  // detector contract is "must never block a successful login because
  // of its own infrastructure" (design §8 final paragraph).
  const acceptLanguage = c.req.header('accept-language') ?? '';
  const attempt: LoginAttemptDraft = {};
  const geoFn = createGeoSubscore(db);
  const timeFn = createTimeSubscore(db);
  const deviceFn = createDeviceSubscore(db);

  let anomaly: { score: number; baselineWarmup: boolean };
  try {
    anomaly = await runDetectors({
      policy,
      geoSubscoreFn: () => geoFn(user.id, ip, attempt),
      timeSubscoreFn: () => timeFn(user.id, new Date()),
      deviceSubscoreFn: () =>
        deviceFn(user.id, userAgent ?? '', acceptLanguage, attempt),
    });
  } catch (err) {
    // Detector or baseline-loader failed unexpectedly. Fall through
    // to the safe "no anomaly" branch so the login succeeds, but
    // surface the failure on the warn channel so operators can
    // investigate. Phase F (task 11.2) will replace this with a
    // proper audit entry.
    // eslint-disable-next-line no-console
    console.warn('[anomaly] detector run failed; treating as no anomaly', formatSafeError(err));
    anomaly = { score: 0, baselineWarmup: false };
  }

  const triggered =
    anomaly.score >= policy.anomalyScoreThreshold && !anomaly.baselineWarmup;

  if (triggered && policy.anomalyAction === 'lock') {
    // Req 12.3 — 423 ANOMALY_LOCK + bump users.lockedUntil so the
    // next attempt for this email sees ACCOUNT_LOCKED via the
    // LoginGuard middleware. No JWT is issued; the credentials may
    // be valid but the verdict is "this is not the legitimate user".
    await recordAnomalyBlock(db, policy, {
      userId: user.id,
      email: emailLower,
      ip,
      userAgent,
      attempt,
      anomalyScore: anomaly.score,
      baselineWarmup: anomaly.baselineWarmup,
      action: 'lock',
    }, new Date(), notify);
    const retryAfterSeconds = Math.max(1, policy.userLockoutDurationSeconds);

    // Workers runtime: drain the anomaly_lock notification after the
    // response (task 9.6). No-op on Node / tests.
    scheduleWorkersDrain(c, dispatcher, c.env);

    return c.json(
      {
        errors: [
          {
            code: 'ANOMALY_LOCK',
            message:
              'Login blocked due to a suspicious pattern. Check your email for a recovery link.',
            retryAfterSeconds,
          },
        ],
      },
      423,
    );
  }

  if (triggered && policy.anomalyAction === 'require_mfa') {
    // Req 12.4 — 401 MFA_REQUIRED, no JWT issued, no lockout. MFA
    // module isn't shipped yet (the wizard's StepSecurity disables
    // this option per Req 6.3), but the route honours the policy
    // decision if it ever gets set out-of-band so the security
    // guarantee holds independently of the UI gating.
    await recordAnomalyBlock(db, policy, {
      userId: user.id,
      email: emailLower,
      ip,
      userAgent,
      attempt,
      anomalyScore: anomaly.score,
      baselineWarmup: anomaly.baselineWarmup,
      action: 'require_mfa',
    }, new Date(), notify);
    return c.json(
      {
        errors: [
          {
            code: 'MFA_REQUIRED',
            message: 'Multi-factor authentication is required to complete login.',
          },
        ],
      },
      401,
    );
  }

  // Generate JWT token. The success hook records the attempt and
  // resets the counter; we run it before issuing the JWT so the
  // counter reset + baseline update are durable even if the token
  // sign happens to fail.
  //
  // `anomalyTriggered` is `true` for the `notify_only` action path
  // (Req 12.2) — the login was allowed but the anomaly is recorded
  // for audit + notification. Task 9.5 threads the dispatcher in via
  // `options.notify` so the `anomaly_triggered` event reaches the
  // operator's channels when (and only when) `anomalyTriggered` is set.
  await recordLoginSuccess(db, {
    userId: user.id,
    email: emailLower,
    ip,
    userAgent,
    attempt,
    anomalyScore: anomaly.score,
    anomalyTriggered: triggered && policy.anomalyAction === 'notify_only',
    baselineWarmup: anomaly.baselineWarmup,
  }, { notify });

  const token = await signCustomJwt(
    {
      userId: user.id,
      email: user.email,
      roles: tokenRoles,
      siteId,
    },
    jwtSecret,
    audience,
  );

  // Workers runtime: keep any queued notification (e.g. an
  // anomaly_triggered from the notify_only path) alive past the
  // response via ctx.waitUntil (task 9.6). No-op on Node / tests.
  scheduleWorkersDrain(c, dispatcher, c.env);

  return c.json({
    data: {
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
      },
    },
  });
});

/**
 * Pluck the optional `LUMIBASE_REDIS_URL` env value into the shape
 * `createCounterStore` expects. The Cloudflare Workers `c.env` is
 * typed as a known set of bindings, but at runtime it's just an
 * object with the operator's vars; we widen it explicitly so the
 * helper doesn't accept arbitrary truthy values for an unset var.
 */
function readCounterEnv(env: unknown) {
  if (!env || typeof env !== 'object') return {};
  const url = (env as Record<string, unknown>).LUMIBASE_REDIS_URL;
  return typeof url === 'string' && url.length > 0
    ? { LUMIBASE_REDIS_URL: url }
    : {};
}

/**
 * Materialise a mutable copy of the "Standard" preset.
 *
 * `STANDARD_LOCKOUT_POLICY` is `Object.freeze`d (single source of
 * truth for the codec) and its `notifyChannels` array is
 * `readonly NotificationChannel[]`. The hooks accept a
 * {@link LockoutPolicy} whose `notifyChannels` is a mutable array, so
 * the readonly-vs-mutable mismatch needs an explicit clone of the
 * channels array. Spreading the preset alone preserves the readonly
 * marker on the resulting type, hence this helper.
 */
function freshStandardPolicy() {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
  };
}

// Profile Endpoint
authRouter.get('/me', async (c) => {
  const auth = c.get('auth');
  const siteId = c.get('siteId');

  return c.json({
    data: {
      logtoId: auth.externalId ?? auth.userId ?? 'anon', // Alias for backward compatibility
      userId: auth.userId,
      externalId: auth.externalId,
      email: auth.email,
      roles: auth.roles ?? [],
      isFrontendUser: auth.isFrontendUser ?? false,
      siteId,
      permissions: null,
    },
  });
});
