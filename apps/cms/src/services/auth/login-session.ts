import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { roles, userSites, users } from '@lumibase/database';
import type { AppEnv } from '../../env';
import {
  TOKEN_AUDIENCE,
  sessionTtlFor,
} from './token-audience';
import {
  issueRefreshToken,
  refreshCookieSettings,
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

  const tokenRoles = options.user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'];
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  const jwtPayload: Record<string, unknown> = {
    userId: options.user.id,
    email: options.user.email,
    roles: tokenRoles,
    siteId: options.siteId,
    tokenVersion: options.user.tokenVersion ?? 0,
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
