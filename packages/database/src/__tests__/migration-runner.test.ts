import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATION_LOCK_CLASSID,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_OBJID,
  MigrationLockTimeoutError,
  materializeMigrationsFolder,
  pendingMigrations,
  readLocalMigrations,
  selectMigrations,
  waitForNoPendingMigrations,
  withMigrationLock,
  type MigrationLockClient,
} from '../migration-runner';

/** A fake postgres.js client: records SQL, answers try-lock from a script. */
function fakeClient(tryLockAnswers: boolean[]) {
  const calls: { query: string; params: unknown[] }[] = [];
  const client: MigrationLockClient = {
    unsafe(query, params = []) {
      calls.push({ query, params });
      if (query.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ locked: tryLockAnswers.shift() ?? false }]);
      }
      return Promise.resolve([{ unlocked: true }]);
    },
  };
  return { client, calls };
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('migration lock key', () => {
  it('is "LumiBase" in ASCII as a signed 64-bit integer, split the way pg_locks shows it', () => {
    const key = BigInt(MIGRATION_LOCK_KEY);
    expect(key).toBe(BigInt('0x' + Buffer.from('LumiBase', 'ascii').toString('hex')));
    expect(key < 2n ** 63n).toBe(true);
    expect(Number(key >> 32n)).toBe(MIGRATION_LOCK_CLASSID);
    expect(Number(key & 0xffffffffn)).toBe(MIGRATION_LOCK_OBJID);
  });
});

describe('withMigrationLock', () => {
  it('takes the lock, runs the apply, then unlocks on the same client', async () => {
    const { client, calls } = fakeClient([true]);
    const order: string[] = [];
    const result = await withMigrationLock(
      client,
      async () => {
        order.push('apply');
        return 42;
      },
      { timeoutMs: 1000 },
    );
    expect(result).toBe(42);
    expect(calls.map((c) => c.query.match(/pg_\w+/)?.[0])).toEqual(['pg_try_advisory_lock', 'pg_advisory_unlock']);
    for (const call of calls) expect(call.params).toEqual([MIGRATION_LOCK_KEY]);
    expect(order).toEqual(['apply']);
  });

  it('waits while another runner holds the lock and only then applies', async () => {
    const { client, calls } = fakeClient([false, false, true]);
    const clock = fakeClock();
    const lines: string[] = [];
    let appliedAfterAttempts = -1;
    await withMigrationLock(
      client,
      async () => {
        appliedAfterAttempts = calls.filter((c) => c.query.includes('pg_try_advisory_lock')).length;
      },
      { timeoutMs: 60_000, pollMs: 500, ...clock, log: (l) => lines.push(l) },
    );
    expect(appliedAfterAttempts).toBe(3);
    expect(clock.sleeps).toEqual([500, 500]);
    // Announced once, not on every poll.
    expect(lines.filter((l) => l.includes('waiting')).length).toBe(1);
    expect(lines.at(-1)).toContain('Holding the migration lock');
  });

  it('releases the lock when the apply throws', async () => {
    const { client, calls } = fakeClient([true]);
    await expect(
      withMigrationLock(client, async () => Promise.reject(new Error('boom')), { timeoutMs: 1000 }),
    ).rejects.toThrow('boom');
    expect(calls.at(-1)?.query).toContain('pg_advisory_unlock');
  });

  it('gives up after the timeout without running the apply', async () => {
    const { client, calls } = fakeClient([]);
    const clock = fakeClock();
    let ran = false;
    await expect(
      withMigrationLock(
        client,
        async () => {
          ran = true;
        },
        { timeoutMs: 5000, pollMs: 2000, ...clock },
      ),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    expect(ran).toBe(false);
    expect(calls.some((c) => c.query.includes('pg_advisory_unlock'))).toBe(false);
  });
});

describe('waitForNoPendingMigrations', () => {
  it('resolves once nothing is pending, retrying errors with capped backoff', async () => {
    const clock = fakeClock();
    const answers: (string[] | Error)[] = [
      new Error('connect ECONNREFUSED'),
      ['0030_x'],
      ['0030_x'],
      ['0030_x'],
      ['0030_x'],
      [],
    ];
    const lines: string[] = [];
    const ok = await waitForNoPendingMigrations(
      async () => {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      { timeoutMs: 60_000, initialDelayMs: 1000, maxDelayMs: 4000, ...clock, log: (l) => lines.push(l) },
    );
    expect(ok).toBe(true);
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 4000, 4000]);
    // The same "pending" line is logged once, not on every poll.
    expect(lines.filter((l) => l.includes('0030_x')).length).toBe(1);
    expect(lines[0]).toContain('ECONNREFUSED');
    expect(lines.at(-1)).toContain('no pending migrations');
  });

  it('returns false at the timeout and never sleeps past it', async () => {
    const clock = fakeClock();
    const ok = await waitForNoPendingMigrations(async () => ['0030_x'], {
      timeoutMs: 2500,
      initialDelayMs: 1000,
      ...clock,
    });
    expect(ok).toBe(false);
    expect(clock.sleeps).toEqual([1000, 1500]);
  });
});

describe('migration target', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function folder(tags: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-mig-src-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'meta'));
    const entries = tags.map((tag, idx) => ({ idx, version: '7', when: 1000 + idx, tag, breakpoints: true }));
    fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
    for (const tag of tags) fs.writeFileSync(path.join(dir, `${tag}.sql`), `-- ${tag}\nSELECT 1;`);
    return dir;
  }

  it('cuts the history at the target and rejects an unknown tag', () => {
    const entries = readLocalMigrations(folder(['0000_a', '0001_b', '0002_c']));
    expect(selectMigrations(entries, '0001_b').map((e) => e.tag)).toEqual(['0000_a', '0001_b']);
    expect(selectMigrations(entries).length).toBe(3);
    expect(() => selectMigrations(entries, '0009_nope')).toThrow(/MIGRATE_TARGET=0009_nope/);
  });

  it('materializes a folder Drizzle can read, with the same SQL (same hashes)', () => {
    const src = folder(['0000_a', '0001_b', '0002_c']);
    expect(materializeMigrationsFolder(src, undefined, os.tmpdir())).toBe(src);
    const out = materializeMigrationsFolder(src, '0001_b', os.tmpdir());
    dirs.push(out);
    const journal = JSON.parse(fs.readFileSync(path.join(out, 'meta', '_journal.json'), 'utf8'));
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toEqual(['0000_a', '0001_b']);
    expect(fs.existsSync(path.join(out, '0002_c.sql'))).toBe(false);
    expect(readLocalMigrations(out).map((m) => m.hash)).toEqual(
      readLocalMigrations(src, '0001_b').map((m) => m.hash),
    );
  });

  it('counts as pending only what is newer than the last applied row (Drizzle semantics)', () => {
    const local = [{ when: 1 }, { when: 2 }, { when: 3 }];
    expect(pendingMigrations(local, null)).toHaveLength(3);
    expect(pendingMigrations(local, 2)).toEqual([{ when: 3 }]);
    expect(pendingMigrations(local, 5)).toEqual([]);
  });
});
