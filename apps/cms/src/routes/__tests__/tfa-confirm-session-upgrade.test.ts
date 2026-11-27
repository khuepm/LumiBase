import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';

/**
 * #1048 — with `enforceTfa` on, a password-only session that enrolls TOTP
 * must not lock itself out. `/me/tfa/confirm` hands back a fresh token pair
 * for the SAME session (`sid`), marked TFA-verified, and that token passes the
 * real `withStudioAccess` gate on the routes the Security page calls next.
 */

const svc = vi.hoisted(() => ({
  confirmTotpSetup: vi.fn(),
  revokeOtherSessions: vi.fn(),
  stepUpSessionFamily: vi.fn(),
  loadSecondFactors: vi.fn(),
  bundle: vi.fn(),
}));

vi.mock('../../modules/mfa/totp-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/mfa/totp-service')>();
  return { ...actual, confirmTotpSetup: svc.confirmTotpSetup };
});
vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return { ...actual, revokeOtherSessions: svc.revokeOtherSessions, stepUpSessionFamily: svc.stepUpSessionFamily };
});
vi.mock('../../modules/mfa/tfa-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/mfa/tfa-state')>();
  return { ...actual, loadSecondFactors: svc.loadSecondFactors };
});
vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write() {
      return Promise.resolve();
    }
  },
}));
vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: svc.bundle };
  }),
}));

const { tfaMeRouter } = await import('../tfa');
const { withStudioAccess } = await import('../../middleware/studio-access');

const JWT_SECRET = 'test-secret-for-tfa-upgrade-0123456789abcdef';
const PASSWORD_SESSION = {
  userId: 'usr_1',
  email: 'admin@example.test',
  roles: ['admin'],
  siteId: 'site-a',
  tokenVersion: 3,
  sid: 'fam-current',
  aud: 'studio',
};

const enforceTfa: PermissionBundle = {
  admin: false,
  appAccess: true,
  tfaRequired: true,
  byKey: {},
  roles: [],
  policies: [],
};

function confirmApp(raw: Record<string, unknown>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as Database);
    c.set('siteId', 'site-a');
    c.set('runtime', { cache: {} } as never);
    c.set('auth', { userId: 'usr_1', email: 'admin@example.test', roles: ['admin'], raw } as never);
    await next();
  });
  app.route('/api/v1/me', tfaMeRouter);
  return app;
}

/** The real gate, for a user whose TOTP is now enrolled. */
function gatedApp(raw: Record<string, unknown>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'usr_1', email: 'admin@example.test', raw } as never);
    c.set('siteId', 'site-a');
    c.set('db', {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ tfa: { enabled: true, method: 'totp' } }] }) }) }),
    } as unknown as Database);
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withStudioAccess());
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

async function confirm(raw: Record<string, unknown>) {
  return confirmApp(raw).request(
    '/api/v1/me/tfa/confirm',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', code: '123456' }),
    },
    { JWT_SECRET } as never,
  );
}

type ConfirmBody = {
  data: {
    recoveryCodes: string[];
    session: { token: string; refreshToken: string; refreshTokenExpiresAt: string } | null;
  };
};

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
  svc.confirmTotpSetup.mockResolvedValue({ recoveryCodes: ['code-1', 'code-2'] });
  svc.revokeOtherSessions.mockResolvedValue(2);
  svc.loadSecondFactors.mockResolvedValue({ totp: false, passkeys: 0 });
  svc.bundle.mockResolvedValue(enforceTfa);
  svc.stepUpSessionFamily.mockResolvedValue({
    token: 'rt_stepped_up',
    expiresAt: new Date(Date.now() + 60_000),
    familyId: 'fam-current',
    audience: 'studio',
    amr: ['pwd', 'totp'],
  });
});

describe('POST /me/tfa/confirm — session upgrade (#1048)', () => {
  it('returns a TFA-verified token pair for the same session', async () => {
    const res = await confirm(PASSWORD_SESSION);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfirmBody;
    expect(body.data.recoveryCodes).toEqual(['code-1', 'code-2']);
    expect(body.data.session?.refreshToken).toBe('rt_stepped_up');

    // Rotated in the same family, after the other sessions were signed out.
    expect(svc.revokeOtherSessions).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_1', 'fam-current');
    expect(svc.stepUpSessionFamily).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: 'site-a', userId: 'usr_1', familyId: 'fam-current', priorAmr: ['pwd'], method: 'totp' }),
      expect.anything(),
    );

    const claims = decodeJwt(body.data.session!.token);
    expect(claims).toMatchObject({
      userId: 'usr_1',
      siteId: 'site-a',
      tokenVersion: 3,
      sid: 'fam-current',
      tfaVerified: true,
      amr: ['pwd', 'totp'],
      aud: 'studio',
    });
    expect(res.headers.get('set-cookie')).toContain('lumibase_refresh=rt_stepped_up');
  });

  it('the new token passes enforceTfa where the old one is refused', async () => {
    const body = (await (await confirm(PASSWORD_SESSION)).json()) as ConfirmBody;
    const upgraded = decodeJwt(body.data.session!.token) as Record<string, unknown>;
    const studio = { 'x-lumi-client': 'studio' };

    for (const [method, path] of [
      ['GET', '/api/v1/me/tfa'],
      ['POST', '/api/v1/me/passkeys/registration-options'],
      ['POST', '/api/v1/me/passkeys'],
      ['GET', '/api/v1/roles'],
    ] as const) {
      const before = await gatedApp(PASSWORD_SESSION).request(path, { method, headers: studio });
      expect(before.status).toBe(403);
      const after = await gatedApp(upgraded).request(path, { method, headers: studio });
      expect(after.status).toBe(200);
    }
  });

  it('does not upgrade a session that skipped an existing factor', async () => {
    svc.loadSecondFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    const body = (await (await confirm({ ...PASSWORD_SESSION })).json()) as ConfirmBody;
    expect(body.data.session).toBeNull();
    expect(svc.stepUpSessionFamily).not.toHaveBeenCalled();
  });

  it('leaves a legacy token without sid as it is', async () => {
    const { sid: _sid, ...legacy } = PASSWORD_SESSION;
    const body = (await (await confirm(legacy)).json()) as ConfirmBody;
    expect(body.data.session).toBeNull();
    expect(svc.stepUpSessionFamily).not.toHaveBeenCalled();
  });

  it('returns no session when the family is no longer live', async () => {
    svc.stepUpSessionFamily.mockResolvedValue(null);
    const body = (await (await confirm(PASSWORD_SESSION)).json()) as ConfirmBody;
    expect(body.data.session).toBeNull();
  });

  it('a rejected code upgrades nothing', async () => {
    const { TotpError } = await import('../../modules/mfa/totp-service');
    svc.confirmTotpSetup.mockRejectedValue(new TotpError('INVALID_CODE', 'bad code'));
    const res = await confirm(PASSWORD_SESSION);
    expect(res.status).toBe(400);
    expect(svc.stepUpSessionFamily).not.toHaveBeenCalled();
  });
});
