import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';
import { SetupService } from '../service';
import { STANDARD_LOCKOUT_POLICY, type LockoutPolicy } from '../policy-codec';

/**
 * #861 sub-bug 2 (setup): the default-site memberships now target
 * `(user_id, site_id)`, so a strict-site identity violation surfaces instead of
 * being dropped. It must map to a clear 409, not to the unrelated `PATH_TAKEN`.
 */

function input() {
  return {
    account: {
      email: 'admin@example.com',
      password: 'CorrectHorseBatteryStaple!42',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
    adminPath: '/lumi-7f3a9c',
    policy: { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy,
  };
}

function service(db: unknown): SetupService {
  return new SetupService({
    db: db as never,
    requireSetupToken: false,
    smtpAvailable: false,
    encryptionAvailable: true,
    audit: { write: vi.fn(async () => undefined) },
  });
}

describe('SetupService.complete — email identity conflict (#861)', () => {
  it.each(['user_sites_site_identity_unique', 'users_email_canonical_unique'])(
    'a 23505 on %s is EMAIL_IDENTITY_CONFLICT, not PATH_TAKEN',
    async (constraint) => {
      const db = {
        transaction: async () => {
          throw Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint_name: constraint } });
        },
      };
      expect(await service(db).complete(input(), {})).toEqual({ ok: false, error: { code: 'EMAIL_IDENTITY_CONFLICT' } });
    },
  );
});

type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;

describe('POST /setup/complete — EMAIL_IDENTITY_CONFLICT HTTP mapping (#861)', () => {
  beforeEach(() => {
    __resetSetupRateLimitForTests();
  });

  it('maps EMAIL_IDENTITY_CONFLICT to 409', async () => {
    const override: SetupOverride = {
      async complete() {
        return { ok: false, error: { code: 'EMAIL_IDENTITY_CONFLICT' } };
      },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', {} as never);
      c.set('setupServiceOverride', override);
      await next();
    });
    app.route('/api/v1/setup', setupRouter);

    const res = await app.request(
      '/api/v1/setup/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.201' },
        body: JSON.stringify({
          account: { email: 'admin@example.com', password: 'Sup3r$ecret!Pass', firstName: 'A', lastName: 'L' },
          adminPath: '/lumi-abc123',
        }),
      },
      {} as AppEnv['Bindings'],
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errors: [{ code: 'EMAIL_IDENTITY_CONFLICT' }] });
  });
});
