import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { roles, userSites, users } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import {
  TOKEN_AUDIENCE,
  sessionTtlFor,
} from './token-audience';
import {
  issueRefreshToken,
  newSessionId,
  refreshCookieSettings,
  stepUpSessionFamily,
} from './refresh-token';
import { refreshTtlFor, ttlToSeconds } from './token-audience';
import { setCookie } from 'hono/cookie';

const REFRESH_COOKIE = 'lumibase_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function refreshCookieBase(c: Context<AppEnv>) {
  const { sameSite, secure, domain } = refreshCookieSettings(c.env);
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: REFRESH_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  } as const;
}

function setRefreshCookie(c: Context<AppEnv>, token: string, audience: string): void {
  setCookie(c, REFRESH_COOKIE, token, {
    ...refreshCookieBase(c),
    maxAge: ttlToSeconds(refreshTtlFor(audience, c.env)),
  });
}

async function signSessionJwt(
  payload: Record<string, unknown>,
  secret: string,
  audience: string,
  ttl: string,
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretKey);
}

type UserRow = typeof users.$inferSelect;

export async function resolveLoginAudience(
  db: AppEnv['Variables']['db'],
  user: UserRow,
  siteId: string,
  membershipRoleId: string | null | undefined,
): Promise<string> {
  let appAccess = user.isBootstrap;
  if (!appAccess && membershipRoleId) {
    const [roleRow] = await db
      .select({ appAccess: roles.appAccess })
      .from(roles)
      .where(and(eq(roles.id, membershipRoleId), eq(roles.siteId, siteId)))
      .limit(1);
    appAccess = roleRow?.appAccess ?? false;
  }
  return appAccess ? TOKEN_AUDIENCE.studio : TOKEN_AUDIENCE.frontend;
}

export async function completePasswordLoginSession(
  c: Context<AppEnv>,
  options: {
    user: UserRow;
    siteId: string;
    audience: string;
    tfaVerified?: boolean;
    amr?: string[];
    /**
     * Roles already resolved by the caller (e.g. passwordless passkey login,
     * which applies the same organization-inheritance rule as `/auth/login`).
     * Defaults to the direct site membership.
     */
    tokenRoles?: string[];
  },
) {
  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] }, 500);
  }

  const db = c.get('db');
  const [membership] = await db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, options.user.id), eq(userSites.siteId, options.siteId)))
    .limit(1);

  const tokenRoles = options.tokenRoles
    ?? (options.user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member']);
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  const sessionId = newSessionId();
  const jwtPayload: Record<string, unknown> = {
    userId: options.user.id,
    email: options.user.email,
    roles: tokenRoles,
    siteId: options.siteId,
    tokenVersion: options.user.tokenVersion ?? 0,
    // Session id (= refresh-token family); revoking the session kills this
    // access token immediately (#730).
    sid: sessionId,
  };
  if (options.tfaVerified) jwtPayload.tfaVerified = true;
  if (options.amr?.length) jwtPayload.amr = options.amr;

  const token = await signSessionJwt(
    jwtPayload,
    jwtSecret,
    options.audience,
    sessionTtlFor(options.audience, c.env),
  );

  const refresh = await issueRefreshToken(
    db,
    {
      siteId: options.siteId,
      userId: options.user.id,
      audience: options.audience,
      ip,
      userAgent,
      familyId: sessionId,
      // Carried on every rotation so a renewed token stays TFA-verified (#987).
      amr: options.tfaVerified ? options.amr ?? null : null,
    },
    c.env,
  );
  setRefreshCookie(c, refresh.token, options.audience);

  return c.json({
    data: {
      token,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      user: {
        id: options.user.id,
        email: options.user.email,
        firstName: options.user.firstName,
        lastName: options.user.lastName,
        avatar: options.user.avatar,
      },
    },
  });
}

/** The tokens `upgradeSessionAfterFirstFactor` hands back to the client. */
export interface UpgradedSession {
  token: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/**
 * Mark the CURRENT session TFA-verified right after the user enrolled their
 * first second factor from it (#1048).
 *
 * Without this, a policy with `enforceTfa` refused the session the moment the
 * factor existed: it was opened with the password alone, so every request
 * (the status refresh, adding a passkey, the rest of the Studio) answered
 * `403 TFA_REQUIRED verification_required`, while the one-time recovery codes
 * were still on screen. The user has just proved the factor on this device,
 * the same proof `/auth/verify-totp` accepts, so the session is upgraded in
 * place: its refresh family is rotated with the new `amr` (same `sid`, see
 * `stepUpSessionFamily`), and a fresh access token carries `tfaVerified`.
 *
 * Returns null, leaving the session untouched, for a legacy token without
 * `sid`, a session with no live refresh row, or a server without JWT secret.
 * The client then asks the user to sign in again with the new factor.
 */
export async function upgradeSessionAfterFirstFactor(
  c: Context<AppEnv>,
  auth: AuthPrincipal,
  method: 'totp' | 'webauthn',
): Promise<UpgradedSession | null> {
  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  const raw = auth.raw ?? {};
  const sid = typeof raw.sid === 'string' ? raw.sid : null;
  if (!jwtSecret || !sid || !auth.userId) return null;

  // The family lives on the site the session was opened on, which a Studio
  // token visiting a sibling site does not share with the request.
  const sessionSiteId = typeof raw.siteId === 'string' ? raw.siteId : c.get('siteId');
  const priorAmr = Array.isArray(raw.amr)
    ? raw.amr.filter((v): v is string => typeof v === 'string')
    : ['pwd'];

  const family = await stepUpSessionFamily(
    c.get('db'),
    {
      siteId: sessionSiteId,
      userId: auth.userId,
      familyId: sid,
      priorAmr: priorAmr.length > 0 ? priorAmr : ['pwd'],
      method,
      ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    },
    c.env,
  );
  if (!family) return null;

  // Same claims as the token being replaced (the auth middleware has already
  // checked `tokenVersion` against the user row), plus the second factor.
  const payload: Record<string, unknown> = {
    userId: auth.userId,
    email: typeof raw.email === 'string' ? raw.email : auth.email,
    roles: Array.isArray(raw.roles) ? raw.roles : auth.roles,
    siteId: sessionSiteId,
    tokenVersion: typeof raw.tokenVersion === 'number' ? raw.tokenVersion : 0,
    sid,
    tfaVerified: true,
    amr: family.amr,
  };
  const token = await signSessionJwt(payload, jwtSecret, family.audience, sessionTtlFor(family.audience, c.env));
  setRefreshCookie(c, family.token, family.audience);

  return {
    token,
    refreshToken: family.token,
    refreshTokenExpiresAt: family.expiresAt.toISOString(),
  };
}
