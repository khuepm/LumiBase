import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import type { AppEnv } from '../env';
import {
  TotpConfirmSchema,
  TotpDisableSchema,
  TotpRegenerateRecoverySchema,
  TotpSetupSchema,
  TotpVerifyLoginSchema,
} from '@lumibase/contracts/schemas';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import { recordLoginSuccess } from '../modules/login-guard/hooks';
import { AuditLogger } from '../modules/audit/logger';
import {
  beginTotpSetup,
  confirmTotpSetup,
  disableUserTotp,
  getTotpStatus,
  regenerateRecoveryCodes,
  verifyStepUpPassword,
  verifyUserRecoveryCode,
  verifyUserTotpCode,
  consumeMfaChallengeJti,
  TotpError,
} from '../modules/mfa/totp-service';
import { checkTotpVerifyRateLimit } from '../modules/mfa/rate-limit';
import {
  signMfaChallengeToken,
  verifyMfaChallengeToken,
} from '../services/auth/mfa-challenge';
import { revokeAllRefreshTokens } from '../services/auth/refresh-token';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { completePasswordLoginSession } from '../services/auth/login-session';

export const tfaAuthRouter = new Hono<AppEnv>();
export const tfaMeRouter = new Hono<AppEnv>();

tfaAuthRouter.post('/verify-totp', async (c) => {
  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] }, 500);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }

  const parsed = TotpVerifyLoginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const claims = await verifyMfaChallengeToken(parsed.data.challengeToken, jwtSecret);
  if (!claims) {
    return c.json({ errors: [{ code: 'INVALID_TOKEN', message: 'Invalid or expired challenge token.' }] }, 401);
  }

  if (claims.siteId !== c.get('siteId')) {
    return c.json({ errors: [{ code: 'INVALID_TOKEN', message: 'Invalid or expired challenge token.' }] }, 401);
  }

  const cache = c.get('runtime').cache;
  const consumed = await consumeMfaChallengeJti(cache, claims.jti);
  if (!consumed) {
    return c.json({ errors: [{ code: 'INVALID_TOKEN', message: 'Invalid or expired challenge token.' }] }, 401);
  }

  const db = c.get('db');
  const ip = extractClientIp(c);
  const rate = await checkTotpVerifyRateLimit(c.get('runtime').rateLimiter, claims.userId, ip);
  if (!rate.allowed) {
    return c.json(
      {
        errors: [{
          code: 'RATE_LIMITED',
          message: 'Too many verification attempts. Try again later.',
          retryAfterSeconds: rate.retryAfterSeconds,
        }],
      },
      429,
    );
  }

  const keys = c.get('runtime').keys;
  let verified = false;
  try {
    if (parsed.data.code) {
      verified = await verifyUserTotpCode(db, keys, claims.userId, parsed.data.code);
    } else if (parsed.data.recoveryCode) {
      verified = await verifyUserRecoveryCode(db, claims.userId, parsed.data.recoveryCode, ip);
    }
  } catch (err) {
    if (err instanceof TotpError) {
      // The challenge `jti` is already consumed above, so the client must start
      // a new login either way. Say why, and point at the path that still works.
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }

  const audit = new AuditLogger({ db, siteId: claims.siteId });
  if (!verified) {
    await audit.write({
      event: 'mfa_verify_failed',
      actorEmail: null,
      metadata: { userId: claims.userId },
      requestId: c.get('requestId'),
      ip,
    });
    return c.json({ errors: [{ code: 'INVALID_CODE', message: 'Invalid verification code.' }] }, 401);
  }

  const [user] = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);
  if (!user || user.status !== 'active') {
    return c.json({ errors: [{ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' }] }, 403);
  }

  await recordLoginSuccess(db, {
    userId: claims.userId,
    email: user.email.toLowerCase(),
    ip,
    userAgent: c.req.header('user-agent') ?? null,
    attempt: {},
    anomalyScore: 0,
    anomalyTriggered: false,
    baselineWarmup: false,
  });

  // Studio-only TOTP: only issue session for studio audience challenges.
  if (claims.loginAudience !== TOKEN_AUDIENCE.studio) {
    return c.json({ errors: [{ code: 'MFA_NOT_SUPPORTED', message: 'Two-factor authentication is not enabled for this login type.' }] }, 403);
  }

  return completePasswordLoginSession(c, {
    user,
    siteId: claims.siteId,
    audience: claims.loginAudience,
    tfaVerified: true,
    amr: ['pwd', 'totp'],
  });
});

tfaMeRouter.get('/tfa', async (c) => {
  const auth = c.get('auth');
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] }, 401);
  }
  const status = await getTotpStatus(c.get('db'), userId);
  return c.json({ data: status });
});

tfaMeRouter.post('/tfa/setup', async (c) => {
  const auth = c.get('auth');
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = TotpSetupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const ok = await verifyStepUpPassword(c.get('db'), userId, parsed.data.password);
  if (!ok) {
    return c.json({ errors: [{ code: 'INVALID_CREDENTIALS', message: 'Password verification failed.' }] }, 401);
  }

  try {
    const issuer = process.env.LUMIBASE_TOTP_ISSUER || 'LumiBase';
    const result: { secret: string; otpauthUrl: string } = await beginTotpSetup(
      c.get('db'),
      c.get('runtime').cache,
      c.get('runtime').keys,
      userId,
      auth.email ?? userId,
      issuer,
    );
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof TotpError) {
      // A deployment missing its encryption key is not the caller's fault and
      // is fixable, so it reads as "unavailable", not "conflict".
      const status = err.code === 'ENCRYPTION_NOT_CONFIGURED' ? 503 : 409;
      return c.json({ errors: [{ code: err.code, message: err.message }] }, status);
    }
    throw err;
  }
});

tfaMeRouter.post('/tfa/confirm', async (c) => {
  const auth = c.get('auth');
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = TotpConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  try {
    const result = await confirmTotpSetup(
      c.get('db'),
      c.get('runtime').cache,
      userId,
      parsed.data.secret,
      parsed.data.code,
    );
    const audit = new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') });
    await audit.write({
      event: 'mfa_enrolled',
      actorEmail: auth.email ?? null,
      metadata: { userId },
      requestId: c.get('requestId'),
      ip: extractClientIp(c),
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof TotpError) {
      const status = err.code === 'SETUP_EXPIRED' ? 410 : 400;
      return c.json({ errors: [{ code: err.code, message: err.message }] }, status);
    }
    throw err;
  }
});

tfaMeRouter.post('/tfa/recovery-codes', async (c) => {
  const auth = c.get('auth');
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = TotpRegenerateRecoverySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const ok = await verifyStepUpPassword(c.get('db'), userId, parsed.data.password);
  if (!ok) {
    return c.json({ errors: [{ code: 'INVALID_CREDENTIALS', message: 'Password verification failed.' }] }, 401);
  }

  let codeOk: boolean;
  try {
    codeOk = await verifyUserTotpCode(c.get('db'), c.get('runtime').keys, userId, parsed.data.code);
  } catch (err) {
    if (err instanceof TotpError) {
      // Deliberately NOT accepting a recovery code here: minting fresh codes
      // for an enrollment that can no longer produce a valid TOTP code would
      // just extend the lockout. Disable and re-enroll instead.
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
  if (!codeOk) {
    return c.json({ errors: [{ code: 'INVALID_CODE', message: 'Invalid verification code.' }] }, 401);
  }

  try {
    const recoveryCodes = await regenerateRecoveryCodes(c.get('db'), userId);
    return c.json({ data: { recoveryCodes } });
  } catch (err) {
    if (err instanceof TotpError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
});

tfaMeRouter.delete('/tfa', async (c) => {
  const auth = c.get('auth');
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required.' }] }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = TotpDisableSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const ok = await verifyStepUpPassword(c.get('db'), userId, parsed.data.password);
  if (!ok) {
    return c.json({ errors: [{ code: 'INVALID_CREDENTIALS', message: 'Password verification failed.' }] }, 401);
  }

  // A recovery code is accepted here on purpose: when the key that wrapped this
  // seed is gone, a TOTP code can never be verified again, and refusing the
  // recovery code would leave the user unable to remove the dead factor.
  let codeOk: boolean;
  try {
    codeOk = parsed.data.recoveryCode
      ? await verifyUserRecoveryCode(
          c.get('db'),
          userId,
          parsed.data.recoveryCode,
          extractClientIp(c),
        )
      : await verifyUserTotpCode(c.get('db'), c.get('runtime').keys, userId, parsed.data.code!);
  } catch (err) {
    if (err instanceof TotpError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
  if (!codeOk) {
    return c.json({ errors: [{ code: 'INVALID_CODE', message: 'Invalid verification code.' }] }, 401);
  }

  await disableUserTotp(c.get('db'), userId);

  const [userRow] = await c.get('db')
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const nextVersion = (userRow?.tokenVersion ?? 0) + 1;
  await c.get('db')
    .update(users)
    .set({ tokenVersion: nextVersion, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await revokeAllRefreshTokens(c.get('db'), c.get('siteId'), userId);

  const audit = new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') });
  await audit.write({
    event: 'mfa_disabled',
    actorEmail: auth.email ?? null,
    metadata: { userId },
    requestId: c.get('requestId'),
    ip: extractClientIp(c),
  });

  return c.json({ data: { disabled: true } });
});
