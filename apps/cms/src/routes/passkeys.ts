/**
 * Passkeys (WebAuthn) — #735.
 *
 * Public (no session yet, listed in the `withAuth` / `site-membership` /
 * `studio-access` public sets like `/auth/verify-totp`):
 *
 *   POST /auth/passkey/options  { challengeToken? }
 *   POST /auth/passkey/verify   { ceremonyId, response, challengeToken? }
 *
 * With `challengeToken` (from `POST /auth/login` → `mfa_required`) the passkey
 * is the **second factor** and the session carries `amr: ['pwd','webauthn']`.
 * Without it the ceremony is a **passwordless, usernameless** staff sign-in
 * with a discoverable credential, user verification required, and the session
 * carries `amr: ['webauthn']`. Both set `tfaVerified: true`, so an
 * `enforceTfa` policy is satisfied, and both mint the session through
 * `completePasswordLoginSession` (same `sid` / refresh family as #730).
 *
 * Authenticated (`/me/passkeys*`): list, register (password step-up, like TOTP
 * setup), rename, remove (password step-up), regenerate recovery codes.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { userSites, users } from '@lumibase/database';
import {
  PasskeyLoginOptionsSchema,
  PasskeyLoginVerifySchema,
  PasskeyRegisterSchema,
  PasskeyRegistrationOptionsSchema,
  PasskeyRenameSchema,
  PasskeyStepUpSchema,
} from '@lumibase/contracts/schemas';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AppEnv } from '../env';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import { recordLoginSuccess } from '../modules/login-guard/hooks';
import { AuditLogger } from '../modules/audit/logger';
import { consumeMfaChallengeJti, verifyStepUpPassword, replaceRecoveryCodes } from '../modules/mfa/totp-service';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  consumeCeremony,
  deletePasskey,
  finishPasskeyRegistration,
  listPasskeys,
  PasskeyError,
  renamePasskey,
  verifyPasskeyAssertion,
  type PasskeyAuthResult,
} from '../modules/mfa/passkey-service';
import { countUnusedRecoveryCodes, loadSecondFactors } from '../modules/mfa/tfa-state';
import { checkPasskeyOptionsRateLimit, checkPasskeyVerifyRateLimit } from '../modules/mfa/rate-limit';
import { resolveWebAuthnRp, webAuthnEnvFrom, type WebAuthnEnv, type WebAuthnRp } from '../modules/mfa/webauthn-config';
import { verifyMfaChallengeToken } from '../services/auth/mfa-challenge';
import { completePasswordLoginSession, resolveLoginAudience } from '../services/auth/login-session';
import { revokeAllRefreshTokens, revokeOtherSessions } from '../services/auth/refresh-token';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { systemDbFor } from '../middleware/db';
import { organizationRoleExpression, organizationRoleForSite } from '../services/organization-access';

export const passkeyAuthRouter = new Hono<AppEnv>();
export const passkeyMeRouter = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const INVALID_TOKEN = { errors: [{ code: 'INVALID_TOKEN', message: 'Invalid or expired challenge token.' }] };
const INVALID_PASSKEY = { errors: [{ code: 'INVALID_PASSKEY', message: 'Passkey verification failed.' }] };
const CEREMONY_EXPIRED = {
  errors: [{ code: 'CEREMONY_EXPIRED', message: 'This passkey request expired. Start again.' }],
};

async function parseBody<S extends z.ZodType>(
  c: Ctx,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

function rpFor(c: Ctx): WebAuthnRp | null {
  return resolveWebAuthnRp(
    webAuthnEnvFrom(c.env as Partial<WebAuthnEnv> | undefined),
    c.req.url,
    c.req.header('origin'),
  );
}

function notConfigured(c: Ctx) {
  return c.json(
    {
      errors: [{
        code: 'WEBAUTHN_NOT_CONFIGURED',
        message: 'Passkeys are not available from this origin. Set WEBAUTHN_ORIGINS / WEBAUTHN_RP_ID on the server.',
      }],
    },
    503,
  );
}

function rateLimited(c: Ctx, retryAfterSeconds: number | undefined) {
  return c.json(
    { errors: [{ code: 'RATE_LIMITED', message: 'Too many passkey attempts. Try again later.', retryAfterSeconds }] },
    429,
  );
}

function jwtSecretOf(c: Ctx): string | undefined {
  return c.env?.JWT_SECRET || process.env.JWT_SECRET;
}

/** Audit a failed assertion. Counter regression gets its own event: it is a cloned-key signal. */
async function auditAssertionFailure(
  c: Ctx,
  siteId: string,
  result: Extract<PasskeyAuthResult, { ok: false }>,
  flow: 'mfa' | 'login',
): Promise<void> {
  const audit = new AuditLogger({ db: c.get('db'), siteId });
  const ip = extractClientIp(c);
  if (result.reason === 'counter_regression') {
    await audit.write({
      event: 'passkey_counter_regression',
      actorEmail: null,
      metadata: {
        userId: result.userId ?? null,
        passkeyId: result.passkeyId ?? null,
        storedCounter: result.storedCounter ?? null,
        receivedCounter: result.receivedCounter ?? null,
        flow,
      },
      requestId: c.get('requestId'),
      ip,
    });
    return;
  }
  await audit.write({
    event: flow === 'mfa' ? 'mfa_verify_failed' : 'passkey_login_failed',
    actorEmail: null,
    metadata: { userId: result.userId ?? null, passkeyId: result.passkeyId ?? null, method: 'webauthn', reason: result.reason },
    requestId: c.get('requestId'),
    ip,
  });
}

// ── Authentication ceremonies ──────────────────────────────────────────────

passkeyAuthRouter.post('/passkey/options', async (c) => {
  const parsed = await parseBody(c, PasskeyLoginOptionsSchema);
  if (!parsed.ok) return parsed.res;

  const ip = extractClientIp(c);
  const rate = await checkPasskeyOptionsRateLimit(c.get('runtime').rateLimiter, ip);
  if (!rate.allowed) return rateLimited(c, rate.retryAfterSeconds);

  const rp = rpFor(c);
  if (!rp) return notConfigured(c);

  const siteId = c.get('siteId');
  const cache = c.get('runtime').cache;
  try {
    if (parsed.data.challengeToken) {
      const jwtSecret = jwtSecretOf(c);
      if (!jwtSecret) {
        return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] }, 500);
      }
      const claims = await verifyMfaChallengeToken(parsed.data.challengeToken, jwtSecret);
      if (!claims || claims.siteId !== siteId) return c.json(INVALID_TOKEN, 401);
      const result = await beginPasskeyAuthentication(c.get('db'), cache, {
        kind: 'mfa',
        rp,
        userId: claims.userId,
        siteId,
        jti: claims.jti,
      });
      return c.json({ data: result });
    }
    const result = await beginPasskeyAuthentication(c.get('db'), cache, { kind: 'login', rp, siteId });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PasskeyError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
});

passkeyAuthRouter.post('/passkey/verify', async (c) => {
  const parsed = await parseBody(c, PasskeyLoginVerifySchema);
  if (!parsed.ok) return parsed.res;
  const jwtSecret = jwtSecretOf(c);
  if (!jwtSecret) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] }, 500);
  }
  return parsed.data.challengeToken
    ? verifySecondFactor(c, jwtSecret, parsed.data.challengeToken, parsed.data.ceremonyId, parsed.data.response)
    : verifyPasswordless(c, parsed.data.ceremonyId, parsed.data.response);
});

type CredentialJson = z.infer<typeof PasskeyLoginVerifySchema>['response'];

async function verifySecondFactor(
  c: Ctx,
  jwtSecret: string,
  challengeToken: string,
  ceremonyId: string,
  response: CredentialJson,
) {
  const siteId = c.get('siteId');
  const claims = await verifyMfaChallengeToken(challengeToken, jwtSecret);
  if (!claims || claims.siteId !== siteId) return c.json(INVALID_TOKEN, 401);

  const ip = extractClientIp(c);
  const rate = await checkPasskeyVerifyRateLimit(c.get('runtime').rateLimiter, ip, claims.userId);
  if (!rate.allowed) return rateLimited(c, rate.retryAfterSeconds);

  const cache = c.get('runtime').cache;
  const ceremony = await consumeCeremony(cache, ceremonyId);
  if (
    !ceremony
    || ceremony.kind !== 'mfa'
    || ceremony.userId !== claims.userId
    || ceremony.jti !== claims.jti
    || ceremony.siteId !== siteId
  ) {
    return c.json(CEREMONY_EXPIRED, 401);
  }
  // One password leg, one second factor: the challenge token is spent here
  // whether or not the passkey verifies, exactly like `/auth/verify-totp`.
  if (!(await consumeMfaChallengeJti(cache, claims.jti))) return c.json(INVALID_TOKEN, 401);

  const db = c.get('db');
  const result = await verifyPasskeyAssertion(db, ceremony, response as unknown as AuthenticationResponseJSON);
  if (!result.ok) {
    await auditAssertionFailure(c, siteId, { ...result, userId: result.userId ?? claims.userId }, 'mfa');
    return c.json(INVALID_PASSKEY, 401);
  }

  const [user] = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);
  if (!user || user.status !== 'active') {
    return c.json({ errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] }, 403);
  }
  if (claims.loginAudience !== TOKEN_AUDIENCE.studio) {
    return c.json({ errors: [{ code: 'MFA_NOT_SUPPORTED', message: 'Two-factor authentication is not enabled for this login type.' }] }, 403);
  }

  await recordLoginSuccess(db, {
    userId: user.id,
    email: user.email.toLowerCase(),
    ip,
    userAgent: c.req.header('user-agent') ?? null,
    attempt: {},
    anomalyScore: 0,
    anomalyTriggered: false,
    baselineWarmup: false,
  });

  return completePasswordLoginSession(c, {
    user,
    siteId,
    audience: claims.loginAudience,
    tfaVerified: true,
    amr: ['pwd', 'webauthn'],
  });
}

async function verifyPasswordless(c: Ctx, ceremonyId: string, response: CredentialJson) {
  const siteId = c.get('siteId');
  const ip = extractClientIp(c);
  const rate = await checkPasskeyVerifyRateLimit(c.get('runtime').rateLimiter, ip);
  if (!rate.allowed) return rateLimited(c, rate.retryAfterSeconds);

  const ceremony = await consumeCeremony(c.get('runtime').cache, ceremonyId);
  if (!ceremony || ceremony.kind !== 'login' || ceremony.siteId !== siteId) {
    return c.json(CEREMONY_EXPIRED, 401);
  }

  const db = c.get('db');
  const result = await verifyPasskeyAssertion(db, ceremony, response as unknown as AuthenticationResponseJSON);
  if (!result.ok) {
    await auditAssertionFailure(c, siteId, result, 'login');
    return c.json(INVALID_PASSKEY, 401);
  }

  const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
  if (!user || user.status !== 'active') {
    return c.json({ errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] }, 403);
  }
  // A lockout set by password brute force (or an anomaly lock) is not lifted
  // by switching to a passkey — the recovery link is the way out.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return c.json({ errors: [{ code: 'ACCOUNT_LOCKED', message: 'This account is temporarily locked.' }] }, 423);
  }

  // Same tenant + realm rules as `/auth/login`.
  const [membership] = await systemDbFor(c)
    .select({ roleId: userSites.roleId, organizationRole: organizationRoleExpression(user.id, siteId) })
    .from(userSites)
    .where(and(eq(userSites.userId, user.id), eq(userSites.siteId, siteId)))
    .limit(1);
  const inherited = !user.isBootstrap && (membership?.organizationRole === 'owner' || membership?.organizationRole === 'admin'
    || (!membership && await organizationRoleForSite(systemDbFor(c), user.id, siteId)));
  if (!membership && !user.isBootstrap && !inherited) {
    return c.json(
      { errors: [{ code: 'TENANT_ACCESS_DENIED', message: 'This account is not a member of the selected site.' }] },
      403,
    );
  }
  const audience = inherited
    ? TOKEN_AUDIENCE.studio
    : await resolveLoginAudience(db, user, siteId, membership?.roleId);
  // Passkeys are a staff sign-in; subscribers keep their own login flow.
  if (audience !== TOKEN_AUDIENCE.studio) {
    return c.json(
      { errors: [{ code: 'PASSKEY_STUDIO_ONLY', message: 'Passkey sign-in is available for Studio accounts only.' }] },
      403,
    );
  }

  await recordLoginSuccess(db, {
    userId: user.id,
    email: user.email.toLowerCase(),
    ip,
    userAgent: c.req.header('user-agent') ?? null,
    attempt: {},
    anomalyScore: 0,
    anomalyTriggered: false,
    baselineWarmup: false,
  });

  return completePasswordLoginSession(c, {
    user,
    siteId,
    audience,
    tfaVerified: true,
    amr: ['webauthn'],
    tokenRoles: user.isBootstrap || inherited ? ['admin'] : [membership?.roleId ?? 'member'],
  });
}

// ── Self-service management ────────────────────────────────────────────────

function requireUser(c: Ctx): { userId: string; email: string | null; sid: string | null } | null {
  const auth = c.get('auth');
  if (!auth?.userId) return null;
  return {
    userId: auth.userId,
    email: auth.email ?? null,
    sid: typeof auth.raw?.sid === 'string' ? auth.raw.sid : null,
  };
}

const UNAUTHORIZED = { errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] };
const BAD_PASSWORD = { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Password verification failed.' }] };

passkeyMeRouter.get('/passkeys', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const db = c.get('db');
  const passkeys = await listPasskeys(db, me.userId);
  const factors = await loadSecondFactors(db, me.userId);
  const recoveryCodesRemaining = factors.totp || factors.passkeys > 0
    ? await countUnusedRecoveryCodes(db, me.userId)
    : 0;
  return c.json({
    data: {
      passkeys,
      recoveryCodesRemaining,
      totpEnabled: factors.totp,
      // So the UI can explain why the add button is missing instead of failing.
      available: rpFor(c) !== null,
    },
  });
});

passkeyMeRouter.post('/passkeys/registration-options', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const parsed = await parseBody(c, PasskeyRegistrationOptionsSchema);
  if (!parsed.ok) return parsed.res;

  const db = c.get('db');
  if (!(await verifyStepUpPassword(db, me.userId, parsed.data.password))) return c.json(BAD_PASSWORD, 401);

  const rp = rpFor(c);
  if (!rp) return notConfigured(c);

  const [user] = await db
    .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, me.userId))
    .limit(1);
  const userName = user?.email ?? me.email ?? me.userId;
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || userName;
  try {
    const result = await beginPasskeyRegistration(db, c.get('runtime').cache, {
      userId: me.userId,
      userName,
      displayName,
      rp,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PasskeyError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
});

passkeyMeRouter.post('/passkeys', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const parsed = await parseBody(c, PasskeyRegisterSchema);
  if (!parsed.ok) return parsed.res;

  const db = c.get('db');
  try {
    const result = await finishPasskeyRegistration(db, c.get('runtime').cache, {
      userId: me.userId,
      ceremonyId: parsed.data.ceremonyId,
      response: parsed.data.response as unknown as RegistrationResponseJSON,
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
    });
    // First second factor = security boundary (#730 parity with TOTP): every
    // other session was opened with the password alone and is signed out.
    const revokedSessions = result.firstFactor && me.sid
      ? await revokeOtherSessions(db, c.get('siteId'), me.userId, me.sid)
      : 0;
    const audit = new AuditLogger({ db, siteId: c.get('siteId') });
    await audit.write({
      event: 'passkey_registered',
      actorEmail: me.email,
      metadata: {
        userId: me.userId,
        passkeyId: result.passkey.id,
        backedUp: result.passkey.backedUp,
        firstFactor: result.firstFactor,
        revokedOtherSessions: revokedSessions,
      },
      requestId: c.get('requestId'),
      ip: extractClientIp(c),
    });
    return c.json({ data: { passkey: result.passkey, recoveryCodes: result.recoveryCodes } }, 201);
  } catch (err) {
    if (err instanceof PasskeyError) {
      const status = err.code === 'CEREMONY_EXPIRED' ? 410 : err.code === 'PASSKEY_EXISTS' ? 409 : 400;
      return c.json({ errors: [{ code: err.code, message: err.message }] }, status);
    }
    throw err;
  }
});

passkeyMeRouter.patch('/passkeys/:id', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const parsed = await parseBody(c, PasskeyRenameSchema);
  if (!parsed.ok) return parsed.res;
  const updated = await renamePasskey(c.get('db'), me.userId, c.req.param('id'), parsed.data.name);
  if (!updated) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Passkey not found.' }] }, 404);
  return c.json({ data: updated });
});

passkeyMeRouter.delete('/passkeys/:id', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const parsed = await parseBody(c, PasskeyStepUpSchema);
  if (!parsed.ok) return parsed.res;

  const db = c.get('db');
  if (!(await verifyStepUpPassword(db, me.userId, parsed.data.password))) return c.json(BAD_PASSWORD, 401);

  const passkeyId = c.req.param('id');
  const outcome = await deletePasskey(db, me.userId, passkeyId);
  if (!outcome.deleted) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Passkey not found.' }] }, 404);

  // Removing the last second factor is a downgrade: same treatment as
  // disabling TOTP — every session, this one included, is signed out.
  if (!outcome.anyFactorLeft) {
    const [row] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, me.userId)).limit(1);
    await db
      .update(users)
      .set({ tokenVersion: (row?.tokenVersion ?? 0) + 1, updatedAt: new Date() })
      .where(eq(users.id, me.userId));
    await revokeAllRefreshTokens(db, c.get('siteId'), me.userId);
  }

  const audit = new AuditLogger({ db, siteId: c.get('siteId') });
  await audit.write({
    event: 'passkey_removed',
    actorEmail: me.email,
    metadata: { userId: me.userId, passkeyId, lastFactor: !outcome.anyFactorLeft },
    requestId: c.get('requestId'),
    ip: extractClientIp(c),
  });
  return c.json({ data: { deleted: true, signedOut: !outcome.anyFactorLeft } });
});

/**
 * Regenerate recovery codes for a passkey user. TOTP users have
 * `POST /me/tfa/recovery-codes` (password + live code); here the live second
 * factor is the session itself — it must have been opened with a passkey.
 */
passkeyMeRouter.post('/passkeys/recovery-codes', async (c) => {
  const me = requireUser(c);
  if (!me) return c.json(UNAUTHORIZED, 401);
  const parsed = await parseBody(c, PasskeyStepUpSchema);
  if (!parsed.ok) return parsed.res;

  const amr = c.get('auth')?.raw?.amr;
  if (!Array.isArray(amr) || !amr.includes('webauthn')) {
    return c.json(
      { errors: [{ code: 'PASSKEY_SESSION_REQUIRED', message: 'Sign in with a passkey to regenerate recovery codes.' }] },
      403,
    );
  }
  const db = c.get('db');
  if (!(await verifyStepUpPassword(db, me.userId, parsed.data.password))) return c.json(BAD_PASSWORD, 401);
  const factors = await loadSecondFactors(db, me.userId);
  if (factors.passkeys === 0) {
    return c.json({ errors: [{ code: 'NO_PASSKEY', message: 'This account has no passkey.' }] }, 409);
  }
  const recoveryCodes = await replaceRecoveryCodes(db, me.userId);
  return c.json({ data: { recoveryCodes } });
});
