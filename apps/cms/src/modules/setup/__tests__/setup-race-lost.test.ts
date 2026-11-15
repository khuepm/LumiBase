import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';
import { SetupService, classifyInitializedLock } from '../service';
import { STANDARD_LOCKOUT_POLICY, type LockoutPolicy } from '../policy-codec';

/**
 * #732 (epic #674 S03) — losers of a parallel first-admin race get 409.
 *
 * The end-to-end proof (N parallel HTTP requests, exactly one admin) is
 * `setup-complete-race.db.integration.test.ts`. These cases pin the logic
 * without Postgres:
 *   - the arrival-vs-initialization classification,
 *   - the service's lock branch and its 23505-on-`users_is_bootstrap_unique`
 *     mapping (including a driver error wrapped in `cause`),
 *   - the HTTP mapping, and that the route stamps `receivedAt` on the context.
 */

const T0 = new Date('2026-11-14T10:00:00.000Z');
const LATER = new Date('2026-11-14T10:00:02.000Z');

describe('classifyInitializedLock', () => {
  it('a request that arrived before setup finished lost a race', () => {
    expect(classifyInitializedLock(T0, LATER)).toBe('SETUP_RACE_LOST');
  });

  it('a request that arrived after setup finished sees the indistinguishable 404 code', () => {
    expect(classifyInitializedLock(LATER, T0)).toBe('ALREADY_INITIALIZED');
    expect(classifyInitializedLock(T0, T0)).toBe('ALREADY_INITIALIZED');
  });

  it('without both timestamps there is nothing to compare: the safe 404 code', () => {
    expect(classifyInitializedLock(undefined, LATER)).toBe('ALREADY_INITIALIZED');
    expect(classifyInitializedLock(T0, null)).toBe('ALREADY_INITIALIZED');
    expect(classifyInitializedLock(T0, undefined)).toBe('ALREADY_INITIALIZED');
  });
});

// ── service ─────────────────────────────────────────────────────────────

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

/** Just enough of a tx to reach the lock: the row it returns is the point. */
function lockedDb(row: { state: string; initializedAt: Date | null }) {
  const tx = {
    async execute() {
      /* set_config */
    },
    insert() {
      return { values: () => ({ onConflictDoNothing: async () => undefined }) };
    },
    select() {
      return {
        from: () => ({
          where: () => ({
            for: async () => [{ ...row, setupTokenHash: null, adminPath: null }],
          }),
        }),
      };
    },
  };
  return {
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
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

describe('SetupService.complete — race outcomes', () => {
  it('a caller that queued on the lock while another setup committed gets SETUP_RACE_LOST', async () => {
    const outcome = await service(lockedDb({ state: 'initialized', initializedAt: LATER })).complete(input(), {
      receivedAt: T0,
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'SETUP_RACE_LOST' } });
  });

  it('a caller arriving after setup gets ALREADY_INITIALIZED', async () => {
    const outcome = await service(lockedDb({ state: 'initialized', initializedAt: T0 })).complete(input(), {
      receivedAt: LATER,
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'ALREADY_INITIALIZED' } });
  });

  it.each([
    ['bare driver error', { code: '23505', constraint_name: 'users_is_bootstrap_unique' }],
    [
      'driver error wrapped by drizzle',
      Object.assign(new Error('Failed query'), {
        cause: { code: '23505', constraint_name: 'users_is_bootstrap_unique' },
      }),
    ],
  ])('a second bootstrap admin refused by the partial unique index (%s) is SETUP_RACE_LOST', async (_l, err) => {
    const db = {
      transaction: async () => {
        throw err;
      },
    };
    expect(await service(db).complete(input(), {})).toEqual({ ok: false, error: { code: 'SETUP_RACE_LOST' } });
  });

  it('any other unique violation keeps its PATH_TAKEN mapping', async () => {
    const db = {
      transaction: async () => {
        throw { code: '23505', constraint_name: 'system_state_admin_path_unique' };
      },
    };
    expect(await service(db).complete(input(), {})).toEqual({ ok: false, error: { code: 'PATH_TAKEN' } });
  });
});

// ── route ───────────────────────────────────────────────────────────────

type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;

describe('POST /setup/complete — race-lost HTTP mapping', () => {
  beforeEach(() => {
    __resetSetupRateLimitForTests();
  });

  it('maps SETUP_RACE_LOST to 409 SETUP_ALREADY_COMPLETED and stamps receivedAt before the service runs', async () => {
    let seen: Date | undefined;
    const override: SetupOverride = {
      async complete(_input, ctx) {
        seen = (ctx as { receivedAt?: Date }).receivedAt;
        return { ok: false, error: { code: 'SETUP_RACE_LOST' } };
      },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', {} as never);
      c.set('setupServiceOverride', override);
      await next();
    });
    app.route('/api/v1/setup', setupRouter);

    const before = Date.now();
    const res = await app.request(
      '/api/v1/setup/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.200' },
        body: JSON.stringify({
          account: { email: 'admin@example.com', password: 'Sup3r$ecret!Pass', firstName: 'A', lastName: 'L' },
          adminPath: '/lumi-abc123',
        }),
      },
      {} as AppEnv['Bindings'],
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      errors: [{ code: 'SETUP_ALREADY_COMPLETED', message: 'Setup was completed by a concurrent request.' }],
    });
    expect(seen).toBeInstanceOf(Date);
    expect(seen!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
