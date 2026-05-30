import { describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

import {
  RecoveryService,
  InMemoryUnlockTokenStore,
  randomDelayMs,
  type UnlockTokenStore,
} from '../service';
import { hashPassword } from '../../../services/auth/password';

/**
 * Unit tests for the RecoveryService (admin-setup-wizard task 10.4).
 *
 * These run without Postgres: a hand-rolled fake Drizzle client
 * (mirroring the `makeFakeDb` capture pattern from
 * `login-guard/__tests__/hooks-notifications.test.ts` and
 * `setup/__tests__/backup-codes-persister.test.ts`) returns canned rows
 * keyed by table name and records the UPDATE / DELETE calls the success
 * path issues. `sleep` is injected as an instant no-op so the
 * 200–500ms anti-timing delay never actually waits, and `now` is
 * injected for deterministic TTL assertions.
 *
 * Coverage:
 *   - successful recover → marks the code used, clears the user
 *     lockout, drains the IP + email failure bursts, saves the token
 *     hash, returns `adminPath` + a plaintext token;
 *   - unknown email → null;
 *   - non-bootstrap user → null;
 *   - a backup code matching no unused row → null;
 *   - an already-used code (filtered by `used_at IS NULL`) → null;
 *   - single-use unlock token (second `validateUnlockToken` → null);
 *   - token TTL expiry (`validateUnlockToken` after expiry → null);
 *   - the returned token's sha256 hash is what `validateUnlockToken`
 *     accepts;
 *   - every return path applies the random delay (sleep is called);
 *   - the pure `randomDelayMs()` helper stays within [200, 500].
 *
 * **Validates: Requirements 14.4**
 */

// ── fake Drizzle client ─────────────────────────────────────────────────

interface FakeDbOptions {
  readonly userRows?: ReadonlyArray<Record<string, unknown>>;
  readonly stateRows?: ReadonlyArray<Record<string, unknown>>;
  readonly codeRows?: ReadonlyArray<Record<string, unknown>>;
}

interface CapturedUpdate {
  table: string;
  values: Record<string, unknown>;
}

interface CapturedDelete {
  table: string;
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const updates: CapturedUpdate[] = [];
  const deletes: CapturedDelete[] = [];

  function rowsForTable(name: string): ReadonlyArray<Record<string, unknown>> {
    switch (name) {
      case 'users':
        return opts.userRows ?? [];
      case 'system_state':
        return opts.stateRows ?? [];
      case 'admin_backup_codes':
        return opts.codeRows ?? [];
      default:
        return [];
    }
  }

  const queryApi = {
    select() {
      return {
        from(table: unknown) {
          const name = getTableName(table as never);
          const resolve = () => Promise.resolve([...rowsForTable(name)]);
          const whereChain = {
            // user / system_state lookups end in `.limit(1)`.
            limit() {
              return resolve();
            },
            // admin_backup_codes scan is awaited directly (thenable).
            then(
              onF: (v: unknown) => unknown,
              onR?: (e: unknown) => unknown,
            ) {
              return resolve().then(onF, onR);
            },
          };
          return {
            where() {
              return whereChain;
            },
          };
        },
      };
    },
    update(table: unknown) {
      const name = getTableName(table as never);
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              updates.push({ table: name, values });
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const name = getTableName(table as never);
      return {
        async where() {
          deletes.push({ table: name });
        },
      };
    },
    // loadLockoutPolicyFromSettings → empty result → Standard fallback.
    async execute() {
      return [] as unknown[];
    },
  };

  const db = {
    ...queryApi,
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(queryApi);
    },
  };

  return { db: db as never, updates, deletes };
}

// ── shared fixtures ─────────────────────────────────────────────────────

const PLAINTEXT_CODE = 'ABCD-2345';
const ADMIN_PATH = '/lumi-7f3a9c';
const IP = '203.0.113.7';

const instantSleep = () => Promise.resolve();

async function bootstrapCodeRows(plain: string) {
  const codeHash = await hashPassword(plain);
  return [{ id: 'bkc_1', codeHash }];
}

// ── successful recover ──────────────────────────────────────────────────

describe('RecoveryService.recover — success (Req 14.4)', () => {
  it('marks the code used, clears user lockout, drains IP+email fails, saves the token, returns adminPath + plaintext token', async () => {
    const { db, updates, deletes } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const store = new InMemoryUnlockTokenStore();
    const sleep = vi.fn(instantSleep);
    const svc = new RecoveryService({ db, tokenStore: store, sleep });

    const result = await svc.recover(
      'Boot@Example.COM',
      PLAINTEXT_CODE,
      IP,
    );

    expect(result).not.toBeNull();
    expect(result!.adminPath).toBe(ADMIN_PATH);
    expect(typeof result!.oneTimeUnlockToken).toBe('string');
    expect(result!.oneTimeUnlockToken.length).toBeGreaterThan(0);

    // Code marked used: an UPDATE on admin_backup_codes stamping
    // usedAt + usedFromIp.
    const codeUpdate = updates.find((u) => u.table === 'admin_backup_codes');
    expect(codeUpdate).toBeDefined();
    expect(codeUpdate!.values.usedFromIp).toBe(IP);
    expect(codeUpdate!.values.usedAt).toBeInstanceOf(Date);

    // User lockout cleared.
    const userUpdate = updates.find((u) => u.table === 'users');
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.values).toMatchObject({
      lockedUntil: null,
      failedCount: 0,
      failedCountWindowStart: null,
    });

    // Two login_attempts deletes: email drain + IP drain.
    const attemptDeletes = deletes.filter((d) => d.table === 'login_attempts');
    expect(attemptDeletes).toHaveLength(2);

    // Token persisted + redeemable.
    expect(store.size).toBe(1);

    // Anti-timing delay applied even on success.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returned token's sha256 hash is what validateUnlockToken accepts", async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const store = new InMemoryUnlockTokenStore();
    const svc = new RecoveryService({ db, tokenStore: store, sleep: instantSleep });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    expect(result).not.toBeNull();

    const validated = await svc.validateUnlockToken(result!.oneTimeUnlockToken);
    expect(validated).toEqual({ userId: 'usr_boot' });
  });
});

// ── failure branches (all → null, all delayed) ──────────────────────────

describe('RecoveryService.recover — failure branches return generic null (Req 14.4)', () => {
  it('unknown email → null (after delay)', async () => {
    const { db } = makeFakeDb({ userRows: [] });
    const sleep = vi.fn(instantSleep);
    const svc = new RecoveryService({ db, sleep });

    const result = await svc.recover('nobody@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('non-bootstrap user → null', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_member', isBootstrap: false }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({ db, sleep: instantSleep });

    const result = await svc.recover('member@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
  });

  it('backup code that matches no unused row → null', async () => {
    const { db, updates } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows('WXYZ-9876'), // a DIFFERENT code
    });
    const svc = new RecoveryService({ db, sleep: instantSleep });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
    // No mutations on a non-match.
    expect(updates).toHaveLength(0);
  });

  it('an already-used code (filtered by used_at IS NULL) is not matched → null', async () => {
    // The service only selects rows WHERE used_at IS NULL, so a used
    // code is simply absent from the candidate set: simulate with an
    // empty codeRows list.
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: [],
    });
    const svc = new RecoveryService({ db, sleep: instantSleep });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
  });

  it('empty email / empty code → null without touching the DB user lookup result', async () => {
    const { db } = makeFakeDb({ userRows: [{ id: 'usr_boot', isBootstrap: true }] });
    const svc = new RecoveryService({ db, sleep: instantSleep });

    expect(await svc.recover('', PLAINTEXT_CODE, IP)).toBeNull();
    expect(await svc.recover('boot@example.com', '', IP)).toBeNull();
  });

  it('missing adminPath (inconsistent state) → null', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: null }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({ db, sleep: instantSleep });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
  });
});

// ── validateUnlockToken: single-use + TTL ───────────────────────────────

describe('RecoveryService.validateUnlockToken (Req 14.4)', () => {
  async function recoverToken(store: UnlockTokenStore, now: () => Date) {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({
      db,
      tokenStore: store,
      sleep: instantSleep,
      now,
    });
    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    return { svc, token: result!.oneTimeUnlockToken };
  }

  it('is single-use — the second consume of the same token returns null', async () => {
    const store = new InMemoryUnlockTokenStore();
    const { svc, token } = await recoverToken(store, () => new Date());

    expect(await svc.validateUnlockToken(token)).toEqual({ userId: 'usr_boot' });
    expect(await svc.validateUnlockToken(token)).toBeNull();
  });

  it('rejects an expired token (TTL)', async () => {
    const base = new Date('2024-06-15T12:00:00.000Z');
    let currentNow = base;
    const store = new InMemoryUnlockTokenStore();

    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({
      db,
      tokenStore: store,
      sleep: instantSleep,
      now: () => currentNow,
      tokenTtlMs: 1000, // 1 second TTL for the test
    });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);
    expect(result).not.toBeNull();

    // Advance the clock past the TTL → validation rejects + evicts.
    currentNow = new Date(base.getTime() + 2000);
    expect(await svc.validateUnlockToken(result!.oneTimeUnlockToken)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('returns null for an unknown / empty token', async () => {
    const { db } = makeFakeDb();
    const svc = new RecoveryService({ db, sleep: instantSleep });
    expect(await svc.validateUnlockToken('not-a-real-token')).toBeNull();
    expect(await svc.validateUnlockToken('')).toBeNull();
  });
});

// ── randomDelayMs pure helper ───────────────────────────────────────────

describe('randomDelayMs (Req 14.4 anti-timing)', () => {
  it('always produces an integer within the inclusive [200, 500] range', () => {
    for (let i = 0; i < 10_000; i++) {
      const d = randomDelayMs();
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(500);
    }
  });

  it('exercises both ends of the range over many samples', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 50_000; i++) {
      const d = randomDelayMs();
      if (d < min) min = d;
      if (d > max) max = d;
    }
    // With 50k draws across 301 buckets the extremes are hit w.h.p.
    expect(min).toBeLessThanOrEqual(205);
    expect(max).toBeGreaterThanOrEqual(495);
  });
});
