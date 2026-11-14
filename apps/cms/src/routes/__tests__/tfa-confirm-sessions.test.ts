import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';

/**
 * #730 — confirming TOTP enrolment signs out every OTHER session (they were
 * opened with the password alone) and keeps the enrolling device signed in.
 */

const svc = vi.hoisted(() => ({
  confirmTotpSetup: vi.fn(),
  revokeOtherSessions: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../modules/mfa/totp-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/mfa/totp-service')>();
  return { ...actual, confirmTotpSetup: svc.confirmTotpSetup };
});

vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return { ...actual, revokeOtherSessions: svc.revokeOtherSessions };
});

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      svc.audit(entry);
      return Promise.resolve();
    }
  },
}));

const { tfaMeRouter } = await import('../tfa');

function buildApp(raw: Record<string, unknown>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as Database);
    c.set('siteId', 'site-a');
    c.set('runtime', { cache: {} } as never);
    c.set('auth', { userId: 'usr_1', email: 'user@example.com', roles: ['member'], raw } as never);
    await next();
  });
  app.route('/api/v1/me', tfaMeRouter);
  return app;
}

const confirm = (app: Hono<AppEnv>) =>
  app.request('/api/v1/me/tfa/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', code: '123456' }),
  });

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
  svc.confirmTotpSetup.mockResolvedValue({ enabled: true, recoveryCodes: ['a'] });
});

describe('POST /me/tfa/confirm — session revocation', () => {
  it('revokes the other sessions and keeps the enrolling one', async () => {
    svc.revokeOtherSessions.mockResolvedValue(3);
    const res = await confirm(buildApp({ sid: 'fam-current' }));
    expect(res.status).toBe(200);
    expect(svc.revokeOtherSessions).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_1', 'fam-current');
    expect(svc.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mfa_enrolled',
        metadata: expect.objectContaining({ revokedOtherSessions: 3 }),
      }),
    );
  });

  it('revokes nothing for a legacy token without sid', async () => {
    const res = await confirm(buildApp({}));
    expect(res.status).toBe(200);
    expect(svc.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it('does not revoke anything when the code is rejected', async () => {
    const { TotpError } = await import('../../modules/mfa/totp-service');
    svc.confirmTotpSetup.mockRejectedValue(new TotpError('INVALID_CODE', 'bad code'));
    const res = await confirm(buildApp({ sid: 'fam-current' }));
    expect(res.status).toBe(400);
    expect(svc.revokeOtherSessions).not.toHaveBeenCalled();
  });
});
