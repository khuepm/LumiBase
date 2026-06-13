import { describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

import {
  RecoveryService,
  InMemoryUnlockTokenStore,
  InMemoryRecoveryTokenStore,
  NoopRecoveryEmailSender,
  randomDelayMs,
  type UnlockTokenStore,
  type RecoveryEmailSender,
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
  readonly backupCodeUpdateRows?: ReadonlyArray<Record<string, unknown>>;
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
            where() {
              updates.push({ table: name, values });
              return {
                returning() {
                  return Promise.resolve(
                    name === 'admin_backup_codes'
                      ? (opts.backupCodeUpdateRows ?? [{ id: 'bkc_1' }])
                      : [],
                  );
                },
              };
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

  it('returns null and saves no token when the guarded backup-code update spends zero rows', async () => {
    const { db, updates, deletes } = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
      backupCodeUpdateRows: [],
    });
    const store = new InMemoryUnlockTokenStore();
    const sleep = vi.fn(instantSleep);
    const svc = new RecoveryService({ db, tokenStore: store, sleep });

    const result = await svc.recover('boot@example.com', PLAINTEXT_CODE, IP);

    expect(result).toBeNull();
    expect(store.size).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe('admin_backup_codes');
    expect(deletes).toHaveLength(0);
    expect(sleep).toHaveBeenCalledTimes(1);
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

// ── forgotPath: minting + sending + anti-enumeration ────────────────────

/**
 * Unit tests for `forgotPath`, `validateRecoveryToken`, and the
 * separation of the unlock-token vs recovery-token stores
 * (admin-setup-wizard task 10.5).
 *
 * Coverage:
 *   - a known bootstrap admin → the injected sender is called with the
 *     user's email + a plaintext token, and the recovery-token store
 *     holds exactly one entry;
 *   - an unknown email → sender NOT called, store empty, still returns
 *     void (no throw);
 *   - a non-bootstrap user → sender NOT called, store empty;
 *   - a sender that throws is swallowed (resolves to void, doesn't
 *     reject) and the token is still stored;
 *   - the random anti-timing delay (sleep) is applied on EVERY path;
 *   - `validateRecoveryToken` is single-use + 30-minute TTL (mirrors
 *     the unlock-token tests);
 *   - a recovery token is NOT redeemable via `validateUnlockToken`, and
 *     an unlock token is NOT redeemable via `validateRecoveryToken`
 *     (the two stores are separate).
 *
 * **Validates: Requirements 14.5, 14.6, 14.7**
 */

const BOOT_EMAIL = 'boot@example.com';

/** Capturing {@link RecoveryEmailSender} for assertions. */
class CapturingEmailSender implements RecoveryEmailSender {
  readonly calls: Array<{
    to: string;
    recoveryToken: string;
    recoveryUrl?: string;
  }> = [];

  async sendRecoveryEmail(args: {
    to: string;
    recoveryToken: string;
    recoveryUrl?: string;
  }): Promise<void> {
    this.calls.push({ ...args });
  }
}

/** A sender that always rejects — exercises the swallow path. */
class ThrowingEmailSender implements RecoveryEmailSender {
  async sendRecoveryEmail(): Promise<void> {
    throw new Error('smtp exploded');
  }
}

describe('RecoveryService.forgotPath — match path (Req 14.5, 14.6)', () => {
  it('sends + stores a recovery token for a known bootstrap admin', async () => {
    const { db } = makeFakeDb({
      userRows: [
        { id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true },
      ],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const sleep = vi.fn(instantSleep);
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep,
    });

    // Mixed-case input must still match the lower-cased lookup.
    await expect(
      svc.forgotPath('Boot@Example.COM', IP),
    ).resolves.toBeUndefined();

    // Sender called once with the user's stored email + a plaintext token.
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.to).toBe(BOOT_EMAIL);
    expect(typeof sender.calls[0]!.recoveryToken).toBe('string');
    expect(sender.calls[0]!.recoveryToken.length).toBeGreaterThan(0);

    // Exactly one recovery token persisted (only the hash is stored).
    expect(recoveryStore.size).toBe(1);

    // Anti-timing delay applied.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returned token's sha256 hash is what validateRecoveryToken accepts", async () => {
    const { db } = makeFakeDb({
      userRows: [
        { id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true },
      ],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep: instantSleep,
    });

    await svc.forgotPath(BOOT_EMAIL, IP);
    const token = sender.calls[0]!.recoveryToken;

    expect(await svc.validateRecoveryToken(token)).toEqual({
      userId: 'usr_boot',
    });
  });
});

describe('RecoveryService.forgotPath — no-op branches (Req 14.5)', () => {
  it('unknown email → does not send, store empty, returns void (no throw)', async () => {
    const { db } = makeFakeDb({ userRows: [] });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const sleep = vi.fn(instantSleep);
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep,
    });

    await expect(
      svc.forgotPath('nobody@example.com', IP),
    ).resolves.toBeUndefined();
    expect(sender.calls).toHaveLength(0);
    expect(recoveryStore.size).toBe(0);
    // Delay still applied on the no-match path (anti-timing).
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('non-bootstrap user → does not send, store empty', async () => {
    const { db } = makeFakeDb({
      userRows: [
        { id: 'usr_member', email: 'member@example.com', isBootstrap: false },
      ],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep: instantSleep,
    });

    await svc.forgotPath('member@example.com', IP);
    expect(sender.calls).toHaveLength(0);
    expect(recoveryStore.size).toBe(0);
  });

  it('empty email → no-op, no send', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
    });
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      recoveryEmailSender: sender,
      sleep: instantSleep,
    });

    await expect(svc.forgotPath('', IP)).resolves.toBeUndefined();
    expect(sender.calls).toHaveLength(0);
  });

  it('missing adminPath (inconsistent state) → no-op, no send', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: null }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep: instantSleep,
    });

    await svc.forgotPath(BOOT_EMAIL, IP);
    expect(sender.calls).toHaveLength(0);
    expect(recoveryStore.size).toBe(0);
  });
});

describe('RecoveryService.forgotPath — best-effort delivery (Req 14.5)', () => {
  it('swallows a sender that throws → resolves to void, token still stored', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: new ThrowingEmailSender(),
      sleep: instantSleep,
    });

    // The throwing sender must NOT reject the call.
    await expect(svc.forgotPath(BOOT_EMAIL, IP)).resolves.toBeUndefined();
    // The token write happens before the (failing) send, so it persists.
    expect(recoveryStore.size).toBe(1);
  });

  it('default (no sender injected) is a log-only no-op that still returns void + stores the token', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const recoveryStore = new InMemoryRecoveryTokenStore();
    // No recoveryEmailSender → defaults to NoopRecoveryEmailSender.
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: recoveryStore,
      sleep: instantSleep,
    });

    await expect(svc.forgotPath(BOOT_EMAIL, IP)).resolves.toBeUndefined();
    expect(recoveryStore.size).toBe(1);
  });
});

// ── validateRecoveryToken: single-use + TTL ─────────────────────────────

describe('RecoveryService.validateRecoveryToken (Req 14.6, 14.7)', () => {
  async function forgotToken(
    store: InMemoryRecoveryTokenStore,
    now: () => Date,
    recoveryTokenTtlMs?: number,
  ) {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: store,
      recoveryEmailSender: sender,
      sleep: instantSleep,
      now,
      recoveryTokenTtlMs,
    });
    await svc.forgotPath(BOOT_EMAIL, IP);
    return { svc, token: sender.calls[0]!.recoveryToken };
  }

  it('is single-use — the second consume of the same token returns null', async () => {
    const store = new InMemoryRecoveryTokenStore();
    const { svc, token } = await forgotToken(store, () => new Date());

    expect(await svc.validateRecoveryToken(token)).toEqual({
      userId: 'usr_boot',
    });
    expect(await svc.validateRecoveryToken(token)).toBeNull();
  });

  it('rejects an expired token (30-minute TTL)', async () => {
    const base = new Date('2024-06-15T12:00:00.000Z');
    let currentNow = base;
    const store = new InMemoryRecoveryTokenStore();
    const { svc, token } = await forgotToken(
      store,
      () => currentNow,
      1000, // 1 second TTL for the test
    );

    // Advance past the TTL → validation rejects + evicts.
    currentNow = new Date(base.getTime() + 2000);
    expect(await svc.validateRecoveryToken(token)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('returns null for an unknown / empty token', async () => {
    const { db } = makeFakeDb();
    const svc = new RecoveryService({ db, sleep: instantSleep });
    expect(await svc.validateRecoveryToken('not-a-real-token')).toBeNull();
    expect(await svc.validateRecoveryToken('')).toBeNull();
  });

  it('defaults to a 30-minute TTL when recoveryTokenTtlMs is not supplied', async () => {
    const base = new Date('2024-06-15T12:00:00.000Z');
    let currentNow = base;
    const store = new InMemoryRecoveryTokenStore();
    // No recoveryTokenTtlMs → default 30 minutes.
    const { svc, token } = await forgotToken(store, () => currentNow);

    // Just before 30 minutes → still valid.
    currentNow = new Date(base.getTime() + 30 * 60 * 1000 - 1);
    expect(await svc.validateRecoveryToken(token)).toEqual({
      userId: 'usr_boot',
    });
  });
});

// ── store separation: unlock vs recovery tokens never cross-redeem ──────

describe('unlock-token and recovery-token stores are separate (design §6.3)', () => {
  it('a recovery token is NOT redeemable via validateUnlockToken', async () => {
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const unlockStore = new InMemoryUnlockTokenStore();
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const sender = new CapturingEmailSender();
    const svc = new RecoveryService({
      db,
      tokenStore: unlockStore,
      recoveryTokenStore: recoveryStore,
      recoveryEmailSender: sender,
      sleep: instantSleep,
    });

    await svc.forgotPath(BOOT_EMAIL, IP);
    const recoveryToken = sender.calls[0]!.recoveryToken;

    // Wrong validator → null; the recovery token survives in its store.
    expect(await svc.validateUnlockToken(recoveryToken)).toBeNull();
    expect(recoveryStore.size).toBe(1);
    // Correct validator still works.
    expect(await svc.validateRecoveryToken(recoveryToken)).toEqual({
      userId: 'usr_boot',
    });
  });

  it('an unlock token is NOT redeemable via validateRecoveryToken', async () => {
    const unlockStore = new InMemoryUnlockTokenStore();
    const recoveryStore = new InMemoryRecoveryTokenStore();
    const { db } = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({
      db,
      tokenStore: unlockStore,
      recoveryTokenStore: recoveryStore,
      sleep: instantSleep,
    });

    const result = await svc.recover(BOOT_EMAIL, PLAINTEXT_CODE, IP);
    expect(result).not.toBeNull();
    const unlockToken = result!.oneTimeUnlockToken;

    // Wrong validator → null; the unlock token survives in its store.
    expect(await svc.validateRecoveryToken(unlockToken)).toBeNull();
    expect(unlockStore.size).toBe(1);
    // Correct validator still works.
    expect(await svc.validateUnlockToken(unlockToken)).toEqual({
      userId: 'usr_boot',
    });
  });
});

// ── NoopRecoveryEmailSender ─────────────────────────────────────────────

describe('NoopRecoveryEmailSender', () => {
  it('resolves without throwing (models "email not configured")', async () => {
    const sender = new NoopRecoveryEmailSender();
    await expect(
      sender.sendRecoveryEmail({ to: BOOT_EMAIL, recoveryToken: 'tok' }),
    ).resolves.toBeUndefined();
  });
});
