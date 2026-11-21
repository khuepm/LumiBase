import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { users, type Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { isSessionTfaVerified } from '../../middleware/studio-access';

/**
 * #987 — `/auth/refresh` must keep a session TFA-verified when the login that
 * started its refresh family proved a second factor. Before this, every
 * renewal dropped `tfaVerified`, so a policy with `enforceTfa` refused an
 * enrolled user as soon as the first access token expired.
 */

const h = vi.hoisted(() => ({ rotate: vi.fn() }));

vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return { ...actual, rotateRefreshToken: h.rotate };
});

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write() {
      return Promise.resolve();
    }
  },
}));

const { authRouter } = await import('../auth');

const JWT_SECRET = 'test-secret-for-refresh-tfa-0123456789abcdef';

function fakeDb(): Database {
  const user = { id: 'usr_1', email: 'admin@example.test', status: 'active', isBootstrap: true, tokenVersion: 2 };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(table === users ? [user] : []) }),
      }),
    }),
  } as unknown as Database;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb());
    c.set('siteId', 'site-a');
    c.set('runtime', { cache: {} } as never);
    await next();
  });
  app.route('/api/v1/auth', authRouter);
  return app;
}

async function refresh() {
  const res = await buildApp().request(
    '/api/v1/auth/refresh',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: 'rt_1' }) },
    { JWT_SECRET } as never,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { token: string } };
  return decodeJwt(body.data.token);
}

function outcome(amr: string[] | null) {
  return {
    ok: true,
    userId: 'usr_1',
    audience: 'studio',
    token: 'rt_2',
    expiresAt: new Date(Date.now() + 60_000),
    familyId: 'fam_1',
    amr,
  };
}

beforeEach(() => h.rotate.mockReset());

describe('POST /auth/refresh keeps the second factor', () => {
  it.each([
    [['pwd', 'totp']],
    [['pwd', 'webauthn']],
    [['webauthn']],
  ])('re-issues tfaVerified for a family started with %j', async (amr) => {
    h.rotate.mockResolvedValue(outcome(amr));
    const claims = await refresh();
    expect(claims).toMatchObject({ userId: 'usr_1', sid: 'fam_1', tfaVerified: true, amr });
    expect(isSessionTfaVerified({ raw: claims } as AuthPrincipal)).toBe(true);
  });

  it('does not invent a second factor for a password-only family', async () => {
    h.rotate.mockResolvedValue(outcome(['pwd']));
    const claims = await refresh();
    expect(claims.tfaVerified).toBeUndefined();
    expect(isSessionTfaVerified({ raw: claims } as AuthPrincipal)).toBe(false);
  });

  it('renews a pre-0044 family (amr NULL) exactly as before', async () => {
    h.rotate.mockResolvedValue(outcome(null));
    const claims = await refresh();
    expect(claims.tfaVerified).toBeUndefined();
    expect(claims.amr).toBeUndefined();
  });
});
