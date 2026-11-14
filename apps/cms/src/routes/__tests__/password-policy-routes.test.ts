import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { settings, users, type Database } from '@lumibase/database';
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from '@lumibase/contracts/schemas';
import type { AppEnv } from '../../env';

/**
 * Every password-setting route goes through the password policy service
 * (#733) and answers a failure with
 * `{ errors: [{ code: 'PASSWORD_POLICY', message, rules: [{ rule, ok, … }] }] }`.
 *
 * The DB is a fake that answers the two reads these routes make (the
 * instance `password_policy` settings row and the `users` row); the breach
 * checker is swapped through the service's test seam, so nothing touches the
 * network.
 */

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  revokeAll: vi.fn(),
}));

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      h.audit(entry);
      return Promise.resolve();
    }
  },
}));

vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return { ...actual, revokeAllRefreshTokens: h.revokeAll };
});

vi.mock('../../modules/auth/registration-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/auth/registration-guard')>();
  return { ...actual, checkRegistrationRate: async () => ({ allowed: true }) };
});

const { authRouter, meRouter } = await import('../auth');
const { adminPasswordPolicyRouter } = await import('../admin-password-policy');
const { hashPassword } = await import('../../services/auth/password');
const { signPasswordResetToken } = await import('../../services/auth/password-reset');
const { __setBreachCheckerForTests } = await import('../../services/auth/password-policy');

const JWT_SECRET = 'test-secret-for-password-policy-routes-0123456789';
const CURRENT = 'Old-Passw0rd!xyz';

interface FakeState {
  policy: Partial<PasswordPolicy> | null;
  user: Record<string, unknown> | null;
  updates: unknown[];
  inserts: unknown[];
}

function fakeDb(state: FakeState): Database {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === settings) return state.policy ? [{ value: state.policy }] : [];
    if (table === users) return state.user ? [state.user] : [];
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(rowsFor(table)) }),
      }),
    }),
    update: () => ({
      set: (v: unknown) => {
        state.updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values: (v: unknown) => {
        state.inserts.push(v);
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  return db as unknown as Database;
}

function buildApp(state: FakeState, auth?: Record<string, unknown>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(state));
    c.set('siteId', 'site-a');
    c.set('runtime', { cache: {} } as never);
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/me', meRouter);
  app.route('/api/v1/admin/password-policy', adminPasswordPolicyRouter);
  return app;
}

const env = { JWT_SECRET } as never;

async function post(app: Hono<AppEnv>, path: string, body: unknown, method = 'POST') {
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
}

type PolicyError = { errors: Array<{ code: string; message: string; rules: Array<{ rule: string; ok: boolean }> }> };
const failedRules = (body: PolicyError) => body.errors[0]!.rules.filter((r) => !r.ok).map((r) => r.rule);

let state: FakeState;
beforeEach(async () => {
  h.audit.mockReset();
  h.revokeAll.mockReset();
  state = {
    policy: null,
    user: { id: 'usr_1', email: 'jane.doe@example.com', passwordHash: await hashPassword(CURRENT), status: 'active', passwordChangedAt: null },
    updates: [],
    inserts: [],
  };
});
afterEach(() => __setBreachCheckerForTests(null));

describe('GET /api/v1/auth/password-policy (public rule set)', () => {
  it('returns the default rule set when none is stored', async () => {
    const res = await buildApp(state).request('/api/v1/auth/password-policy');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { ...DEFAULT_PASSWORD_POLICY, maxLength: 256, specialChars: '!@#$%^&*()-_=+[]{};:,.?/' },
    });
  });

  it('reflects the stored instance policy', async () => {
    state.policy = { minLength: 16, breachCheck: true };
    const body = (await (await buildApp(state).request('/api/v1/auth/password-policy')).json()) as {
      data: PasswordPolicy;
    };
    expect(body.data).toMatchObject({ minLength: 16, breachCheck: true });
  });
});

describe('POST /api/v1/me/change-password', () => {
  const auth = { userId: 'usr_1', email: 'jane.doe@example.com', roles: ['member'], raw: {} };

  it('names each failed rule and leaves the password unchanged', async () => {
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as PolicyError;
    expect(body.errors[0]!.code).toBe('PASSWORD_POLICY');
    expect(failedRules(body)).toEqual(expect.arrayContaining(['min_length', 'uppercase', 'digit', 'special']));
    expect(body.errors[0]!.message).toMatch(/min_length/);
    expect(state.updates).toHaveLength(0);
  });

  it('rejects a password built from the account e-mail (min_strength)', async () => {
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'Jane.Doe@example.com1',
    });
    expect(res.status).toBe(400);
    expect(failedRules((await res.json()) as PolicyError)).toEqual(['min_strength']);
  });

  it('enforces a stricter stored policy', async () => {
    state.policy = { minLength: 32 };
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(400);
    expect(failedRules((await res.json()) as PolicyError)).toEqual(['min_length']);
  });

  it('accepts a compliant password', async () => {
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it('with breach check on: rejects a breached password (not_breached)', async () => {
    state.policy = { breachCheck: true };
    __setBreachCheckerForTests(async () => ({ status: 'breached', count: 3 }));
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(400);
    expect(failedRules((await res.json()) as PolicyError)).toEqual(['not_breached']);
  });

  it('with breach check on: fails open + audits when the service is unreachable', async () => {
    state.policy = { breachCheck: true };
    __setBreachCheckerForTests(async () => ({ status: 'unavailable', reason: 'network_error' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'password_breach_check_unavailable', metadata: { reason: 'network_error' } }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('breach check is off by default — the checker is never consulted', async () => {
    const checker = vi.fn(async () => ({ status: 'breached' as const, count: 1 }));
    __setBreachCheckerForTests(checker);
    const res = await post(buildApp(state, auth), '/api/v1/me/change-password', {
      currentPassword: CURRENT,
      newPassword: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(200);
    expect(checker).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/reset-password (also the invite first-password path)', () => {
  it('rejects a weak password with PASSWORD_POLICY and does not update', async () => {
    const token = await signPasswordResetToken({ userId: 'usr_1', siteId: 'site-a' }, JWT_SECRET);
    const res = await post(buildApp(state), '/api/v1/auth/reset-password', { token, password: 'alllowercaseletters' });
    expect(res.status).toBe(400);
    expect(failedRules((await res.json()) as PolicyError)).toEqual(
      expect.arrayContaining(['uppercase', 'digit', 'special']),
    );
    expect(state.updates).toHaveLength(0);
  });

  it('accepts a compliant password', async () => {
    const token = await signPasswordResetToken({ userId: 'usr_1', siteId: 'site-a' }, JWT_SECRET);
    const res = await post(buildApp(state), '/api/v1/auth/reset-password', {
      token,
      password: 'CorrectHorseBatteryStaple!42',
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });
});

describe('POST /api/v1/auth/register', () => {
  it('rejects a weak password with PASSWORD_POLICY before any account work', async () => {
    const res = await post(buildApp(state), '/api/v1/auth/register', { email: 'new@example.com', password: 'Password1234!' });
    expect(res.status).toBe(400);
    expect(failedRules((await res.json()) as PolicyError)).toEqual(['min_strength']);
    expect(state.inserts).toHaveLength(0);
  });
});

describe('/api/v1/admin/password-policy', () => {
  const admin = { userId: 'usr_1', email: 'jane.doe@example.com', roles: ['admin'], raw: {} };

  it('PUT refuses anyone but the bootstrap admin', async () => {
    state.user = { bootstrap: false };
    const res = await post(buildApp(state, admin), '/api/v1/admin/password-policy', { minLength: 14 }, 'PUT');
    expect(res.status).toBe(403);
    expect(state.inserts).toHaveLength(0);
  });

  it('PUT validates, stores under the instance site and audits the change', async () => {
    state.user = { bootstrap: true };
    const res = await post(buildApp(state, admin), '/api/v1/admin/password-policy', { minLength: 14, breachCheck: true }, 'PUT');
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      expect.objectContaining({ siteId: '__default__', key: 'password_policy', value: { ...DEFAULT_PASSWORD_POLICY, minLength: 14, breachCheck: true } }),
    ]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'password_policy_changed' }));
  });

  it('PUT rejects a policy below the NIST floor', async () => {
    state.user = { bootstrap: true };
    const res = await post(buildApp(state, admin), '/api/v1/admin/password-policy', { minLength: 4 }, 'PUT');
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });
});
