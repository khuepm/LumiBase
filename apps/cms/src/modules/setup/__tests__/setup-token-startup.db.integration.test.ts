import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { systemState, type Database } from '@lumibase/database';

import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { SetupService } from '../service';
import { STANDARD_LOCKOUT_POLICY, type LockoutPolicy } from '../policy-codec';
import { __resetSetupTokenPrintGuardForTests, verifySetupToken } from '../setup-token';
import { CLEAR_SETUP_TOKEN_SQL, runSetupTokenStartup, type SetupTokenStartupOutcome } from '../startup';

/**
 * #470 end to end, on Postgres: the token startup prints is the token setup
 * accepts.
 *
 * The issue's reproduction was a closed loop — `/setup/state` said a token was
 * required, `/setup/complete` refused without one, and nothing ever printed
 * one. These cases close the loop through the real pieces: `runSetupTokenStartup`
 * (what `serve.ts` awaits before listening) writes the hash, and the real
 * `SetupService.complete` accepts the printed plaintext and nothing else.
 *
 * The concurrency cases need the real database: "print only if your write
 * landed" is a property of `ON CONFLICT DO NOTHING` and a conditional `UPDATE`,
 * which a fake can only restate.
 *
 * Skips without DATABASE_URL (see `__tests__/helpers/db-harness.ts`).
 */

const FLAG_ON = { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' };
const TOKEN_LINE = /^\[lumibase-cms\] SETUP_TOKEN=(?<token>[A-Za-z0-9_-]+)$/;

/**
 * Hold every replica's read of the singleton until all of them have read it.
 *
 * Without this, whether the replicas overlap depends on connection timing.
 * Measured against the pre-fix writes: the hash-less case *passed* when run on
 * its own, because the first boot reused a warm connection and finished before
 * the others' reads came back. A race test that races only sometimes proves
 * nothing, so the barrier forces the window the conditional write exists for:
 * everyone reads "no hash" before anyone writes.
 */
function withReadBarrier(target: Database, replicas: number): () => Database {
  let arrived = 0;
  let release: () => void = () => undefined;
  const allRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrive = async (): Promise<void> => {
    arrived += 1;
    if (arrived >= replicas) release();
    await allRead;
  };
  // Only the helper's one read (`select().from().where().limit()`) is gated;
  // every write goes straight to Postgres.
  return () =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop !== 'select') return Reflect.get(obj, prop, receiver);
        return () => ({
          from: (table: typeof systemState) => ({
            where: (condition: SQL | undefined) => ({
              limit: async (n: number) => {
                const rows = await obj.select().from(table).where(condition).limit(n);
                await arrive();
                return rows;
              },
            }),
          }),
        });
      },
    });
}

interface Boot {
  outcome: SetupTokenStartupOutcome;
  log: string[];
  warn: string[];
  token: string | undefined;
}

describe.skipIf(!hasDbIntegrationUrl)('setup token startup — Postgres', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('setup-token-startup');
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .execute(
        sql`TRUNCATE TABLE lumibase_admin_backup_codes, lumibase_audit_log, lumibase_system_state, lumibase_users, lumibase_sites RESTART IDENTITY CASCADE`,
      )
      .catch(() => undefined);
  });

  beforeEach(async () => {
    __resetSetupTokenPrintGuardForTests();
    await db.execute(
      sql`TRUNCATE TABLE lumibase_admin_backup_codes, lumibase_audit_log, lumibase_system_state, lumibase_users, lumibase_sites RESTART IDENTITY CASCADE`,
    );
  });

  async function boot(
    env: Record<string, string | undefined> = FLAG_ON,
    client: Database = db,
  ): Promise<Boot> {
    const log: string[] = [];
    const warn: string[] = [];
    const outcome = await runSetupTokenStartup({
      db: client,
      env,
      log: (line) => log.push(line),
      warn: (line) => warn.push(line),
    });
    const printed = log.filter((l) => l.includes('SETUP_TOKEN='));
    const token = printed.length === 1 ? TOKEN_LINE.exec(printed[0]!)?.groups?.token : undefined;
    return { outcome, log, warn, token };
  }

  async function storedRow() {
    const rows = await db.select().from(systemState).where(eq(systemState.id, 'singleton'));
    return rows[0];
  }

  function gatedService(): SetupService {
    return new SetupService({
      db,
      requireSetupToken: true,
      smtpAvailable: false,
      encryptionAvailable: true,
    });
  }

  function setupInput(setupToken?: string) {
    return {
      ...(setupToken === undefined ? {} : { setupToken }),
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

  it('the token printed at startup is the one /setup/complete accepts', async () => {
    const started = await boot();
    expect(started.outcome).toBe('minted');
    expect(started.token).toBeDefined();

    const svc = gatedService();
    expect(await svc.getState()).toEqual({ state: 'uninitialized', requiresSetupToken: true });

    // The issue's refusals, still in place — the gate itself is not weakened.
    expect(await svc.complete(setupInput(), { requestId: 'no-token' })).toEqual({
      ok: false,
      error: { code: 'SETUP_TOKEN_REQUIRED' },
    });
    expect(await svc.complete(setupInput('not-the-token'), { requestId: 'wrong' })).toEqual({
      ok: false,
      error: { code: 'SETUP_TOKEN_INVALID' },
    });

    // …and the way out that did not exist before.
    const done = await svc.complete(setupInput(started.token), { requestId: 'right' });
    expect(done.ok).toBe(true);
    expect(await svc.getState()).toEqual({ state: 'initialized', requiresSetupToken: false });

    // The hash does not outlive setup (design §7.3), and a later start is quiet.
    expect((await storedRow())?.setupTokenHash).toBeNull();
    __resetSetupTokenPrintGuardForTests();
    const after = await boot();
    expect(after.outcome).toBe('already_initialized');
    expect(after.log).toEqual([]);
    expect(after.warn).toEqual([]);
  });

  it('a restart keeps the issued token valid, prints nothing secret, and says how to reissue', async () => {
    const first = await boot();
    const issuedHash = (await storedRow())?.setupTokenHash;

    __resetSetupTokenPrintGuardForTests(); // a new process
    const second = await boot();

    expect(second.outcome).toBe('already_minted');
    expect(second.log.filter((l) => l.includes('SETUP_TOKEN='))).toEqual([]);
    expect(second.warn.join('\n')).toContain(CLEAR_SETUP_TOKEN_SQL);
    expect((await storedRow())?.setupTokenHash).toBe(issuedHash);
    expect(await verifySetupToken(first.token ?? '', issuedHash)).toBe(true);

    // The recovery statement the notice prints actually works on this schema.
    await db.execute(sql.raw(CLEAR_SETUP_TOKEN_SQL));
    __resetSetupTokenPrintGuardForTests();
    const reissued = await boot();
    expect(reissued.outcome).toBe('minted');
    expect(reissued.token).toBeDefined();
    expect(reissued.token).not.toBe(first.token);
    const done = await gatedService().complete(setupInput(reissued.token), { requestId: 'reissued' });
    expect(done.ok).toBe(true);
  });

  it.each([
    ['a fresh database (no singleton row yet)', false],
    ['a hash-less singleton left by a refused setup attempt', true],
  ])('replicas booting together on %s print exactly one token, and it is the stored one', async (_label, seedRow) => {
    if (seedRow) {
      await db.insert(systemState).values({ id: 'singleton', state: 'uninitialized' });
    }

    // Five starts stand in for five web replicas. The barrier guarantees each
    // reads "no hash" before any of them writes, so the in-process print guard
    // cannot mask the race either: nobody has printed when they all check it.
    const replica = withReadBarrier(db, 5);
    const boots = await Promise.all(Array.from({ length: 5 }, () => boot(FLAG_ON, replica())));

    const minted = boots.filter((b) => b.outcome === 'minted');
    expect(minted).toHaveLength(1);
    expect(boots.filter((b) => b.outcome === 'already_minted')).toHaveLength(4);
    expect(boots.flatMap((b) => b.log).filter((l) => l.includes('SETUP_TOKEN='))).toHaveLength(1);

    const stored = await storedRow();
    expect(await verifySetupToken(minted[0]!.token ?? '', stored?.setupTokenHash)).toBe(true);
  });

  it('with the flag off, startup writes nothing and setup needs no token', async () => {
    const started = await boot({ LUMIBASE_REQUIRE_SETUP_TOKEN: 'false' });
    expect(started.outcome).toBe('not_required');
    expect(started.log).toEqual([]);
    expect(await storedRow()).toBeUndefined();
  });

  it('with the flag on and no startup step (Cloudflare Workers), setup says the token was never issued', async () => {
    // Nothing calls runSetupTokenStartup on Workers. Before, this answered
    // SETUP_TOKEN_REQUIRED — the silent lockout. Now it names the cause.
    const outcome = await gatedService().complete(setupInput('anything'), { requestId: 'cf' });
    expect(outcome).toEqual({ ok: false, error: { code: 'SETUP_TOKEN_NOT_ISSUED' } });
    expect(await gatedService().getState()).toEqual({
      state: 'uninitialized',
      requiresSetupToken: true,
    });
  });
});
