import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { systemState, users, userSites } from '@lumibase/database';
import type { AppEnv } from '../env';
import { hashPassword, verifyPassword } from '../services/auth/password';
import {
  loginGuardMiddleware,
  loadLockoutPolicyFromSettings,
} from '../modules/login-guard/middleware';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import {
  createCounterStore,
} from '../modules/login-guard/counter';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';
import {
  recordLoginFailure,
  recordLoginSuccess,
} from '../modules/login-guard/hooks';

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

// Helper to sign Custom JWT (HS256)
async function signCustomJwt(payload: any, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
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

// Custom Register (for Frontend Users)
authRouter.post('/register', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const body = await c.req.json();
  const input = registerSchema.parse(body);

  // Check if user exists by email
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existingUser) {
    return c.json(
      { errors: [{ code: 'EMAIL_ALREADY_EXISTS', message: 'Email is already registered.' }] },
      400
    );
  }

  const passwordHash = await hashPassword(input.password);

  // Insert user
  const [newUser] = await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      status: 'active',
    })
    .returning();

  if (!newUser) {
    return c.json({ errors: [{ code: 'REGISTRATION_FAILED', message: 'Failed to create user.' }] }, 500);
  }

  // Bind new user to the current site (default 'member' role)
  await db
    .insert(userSites)
    .values({
      userId: newUser.id,
      siteId,
      roleId: 'member',
    })
    .onConflictDoNothing();

  return c.json({
    data: {
      id: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
    },
  });
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
  // lower(email).trim() is the canonical key for the sliding-window
  // counter (`loginAttempts.emailLower`) and for the no-enumeration
  // SELECT. Task 6.3 will fold this normalisation into the wider
  // wizard surface; we apply it locally here so the LoginGuard hooks
  // see consistent values regardless of which task ships first.
  const emailLower = input.email.trim().toLowerCase();
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
    );

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
    );

    return c.json(
      { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }] },
      401
    );
  }

  // Generate JWT token. The success hook records the attempt and
  // resets the counter; we run it before issuing the JWT so the
  // counter reset is durable even if the token sign happens to fail.
  // (Phase D / task 8.1 will graft anomaly detection here.)
  await recordLoginSuccess(db, {
    userId: user.id,
    email: emailLower,
    ip,
    userAgent,
  });

  const token = await signCustomJwt(
    {
      userId: user.id,
      email: user.email,
      roles: ['member'],
    },
    jwtSecret
  );

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
