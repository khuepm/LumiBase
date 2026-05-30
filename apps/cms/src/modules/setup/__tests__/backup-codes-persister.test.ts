import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  SetupService,
  defaultBackupCodesPersister,
  type BackupCodesPersister,
} from '../service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../policy-codec';
import { verifyPassword } from '../../../services/auth/password';

/**
 * Unit tests for backup-code generation, hashing, and persistence in
 * the Setup Wizard (task 10.2).
 *
 * These run without Postgres: `defaultBackupCodesPersister` is fed a
 * fake `tx` whose `insert().values()` records the rows, and the full
 * `complete()` path is driven against a hand-rolled fake DB that
 * captures the inserted backup-code rows plus the returned plaintext.
 *
 * **Validates: Requirements 14.1, 14.2**
 */

// ── fake tx capturing insert(...).values(rows) ─────────────────────────

interface CapturedInsert {
  table: unknown;
  rows: ReadonlyArray<Record<string, unknown>>;
}

function makeRecordingTx() {
  const inserts: CapturedInsert[] = [];
  const tx = {
    insert(table: unknown) {
      return {
        async values(rows: ReadonlyArray<Record<string, unknown>>) {
          inserts.push({ table, rows });
        },
      };
    },
  };
  return { tx, inserts };
}

// ── defaultBackupCodesPersister (no DB) ────────────────────────────────

describe('defaultBackupCodesPersister (Req 14.2)', () => {
  it('inserts one row per hash with { userId, codeHash } shape', async () => {
    const { tx, inserts } = makeRecordingTx();
    const hashes = ['pbkdf2$100000$aa$bb', 'pbkdf2$100000$cc$dd'];

    await defaultBackupCodesPersister({ userId: 'usr_1', hashes }, tx);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.rows).toEqual([
      { userId: 'usr_1', codeHash: 'pbkdf2$100000$aa$bb' },
      { userId: 'usr_1', codeHash: 'pbkdf2$100000$cc$dd' },
    ]);
  });

  it('inserts exactly 8 rows for the canonical 8-code mint', async () => {
    const { tx, inserts } = makeRecordingTx();
    const hashes = Array.from({ length: 8 }, (_, i) => `pbkdf2$100000$s${i}$h${i}`);

    await defaultBackupCodesPersister({ userId: 'usr_2', hashes }, tx);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.rows).toHaveLength(8);
    for (const row of inserts[0]!.rows) {
      expect(row).toHaveProperty('userId', 'usr_2');
      expect(typeof row.codeHash).toBe('string');
      // usedAt / usedFromIp must NOT be set — they default to NULL so
      // the code is spendable until redeemed.
      expect(row).not.toHaveProperty('usedAt');
      expect(row).not.toHaveProperty('usedFromIp');
    }
  });

  it('skips the insert entirely for an empty hash list', async () => {
    const { tx, inserts } = makeRecordingTx();
    await defaultBackupCodesPersister({ userId: 'usr_3', hashes: [] }, tx);
    expect(inserts).toHaveLength(0);
  });
});

// ── full complete() path against a fake DB ─────────────────────────────

/**
 * Minimal in-memory fake of the Drizzle client surface that
 * `SetupService.complete()` touches. It returns canned rows for the
 * `system_state` lock + `users` insert, and threads a single shared
 * query API through `transaction(cb)` so the persister's `tx.insert`
 * lands in the same capture buffer.
 */
function makeFakeDb(captured: {
  backupRows: Array<Record<string, unknown>>;
  auditRows: Array<Record<string, unknown>>;
}) {
  const queryApi = {
    insert(table: { [k: string]: unknown }) {
      const tableName = getTableName(table);
      return {
        values(rows: unknown) {
          const builder = {
            // users insert uses `.returning(...)`
            async returning() {
              return [
                {
                  id: 'usr_new',
                  email: 'admin@example.com',
                  firstName: 'Ada',
                  lastName: 'Lovelace',
                },
              ];
            },
            // system_state upsert uses `.onConflictDoNothing()`
            async onConflictDoNothing() {
              /* no-op */
            },
            // bare await (admin_backup_codes / audit_log)
            then(resolve: (v: unknown) => void) {
              if (tableName === 'admin_backup_codes') {
                for (const r of rows as Array<Record<string, unknown>>) {
                  captured.backupRows.push(r);
                }
              } else if (tableName === 'audit_log') {
                captured.auditRows.push(rows as Record<string, unknown>);
              }
              resolve(undefined);
            },
          };
          return builder;
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              const chain = {
                limit() {
                  return Promise.resolve([]);
                },
                for() {
                  // the `SELECT ... FOR UPDATE` on system_state.
                  return Promise.resolve([
                    { state: 'uninitialized', setupTokenHash: null, adminPath: null },
                  ]);
                },
                then(resolve: (v: unknown) => void) {
                  resolve([]);
                },
              };
              return chain;
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            async where() {
              /* no-op */
            },
          };
        },
      };
    },
    async execute() {
      /* set_config no-op */
    },
  };

  function getTableName(table: { [k: string]: unknown }): string {
    // Drizzle tables expose their SQL name via a Symbol; fall back to a
    // best-effort scan of own-symbol descriptions.
    for (const sym of Object.getOwnPropertySymbols(table)) {
      const desc = sym.description ?? '';
      if (desc.includes('Name')) {
        const v = (table as Record<symbol, unknown>)[sym];
        if (typeof v === 'string') return v;
      }
    }
    return '';
  }

  return {
    ...queryApi,
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(queryApi);
    },
  };
}

describe('SetupService.complete() backup-code persistence (Req 14.1, 14.2)', () => {
  function makeInput() {
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

  it('returns 8 XXXX-XXXX plaintext codes and persists 8 hashed rows by default', async () => {
    const captured = {
      backupRows: [] as Array<Record<string, unknown>>,
      auditRows: [] as Array<Record<string, unknown>>,
    };
    const db = makeFakeDb(captured) as never;
    const svc = new SetupService({ db, requireSetupToken: false, smtpAvailable: false });

    const outcome = await svc.complete(makeInput(), { requestId: 'req-1' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Exactly 8 plaintext codes in XXXX-XXXX format from the [A-Z2-9] set.
    expect(outcome.value.backupCodes).toHaveLength(8);
    for (const code of outcome.value.backupCodes) {
      expect(code).toMatch(/^[A-Z2-9]{8}-[A-Z2-9]{8}$/);
    }

    // Default persister wrote 8 rows, each { userId, codeHash } with a
    // PBKDF2 hash and no usedAt.
    expect(captured.backupRows).toHaveLength(8);
    for (const row of captured.backupRows) {
      expect(row.userId).toBe('usr_new');
      expect(typeof row.codeHash).toBe('string');
      expect(row.codeHash as string).toMatch(/^pbkdf2\$100000\$[0-9a-f]+\$[0-9a-f]+$/);
      expect(row).not.toHaveProperty('usedAt');
    }
  });

  it('each returned plaintext code verifies against exactly one stored hash', async () => {
    const captured = {
      backupRows: [] as Array<Record<string, unknown>>,
      auditRows: [] as Array<Record<string, unknown>>,
    };
    const db = makeFakeDb(captured) as never;
    const svc = new SetupService({ db, requireSetupToken: false, smtpAvailable: false });

    const outcome = await svc.complete(makeInput(), {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const storedHashes = captured.backupRows.map((r) => r.codeHash as string);
    for (const plain of outcome.value.backupCodes) {
      const matches = await Promise.all(
        storedHashes.map((h) => verifyPassword(plain, h)),
      );
      expect(matches.filter(Boolean)).toHaveLength(1);
    }
  });

  it('honours an injected persister instead of the default', async () => {
    const captured = {
      backupRows: [] as Array<Record<string, unknown>>,
      auditRows: [] as Array<Record<string, unknown>>,
    };
    const db = makeFakeDb(captured) as never;

    const spyRows: Array<{ userId: string; hashes: ReadonlyArray<string> }> = [];
    const spy: BackupCodesPersister = async (args) => {
      spyRows.push({ userId: args.userId, hashes: args.hashes });
    };

    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      backupCodesPersister: spy,
    });

    const outcome = await svc.complete(makeInput(), {});
    expect(outcome.ok).toBe(true);

    // The spy ran with 8 hashes; the default did NOT write rows.
    expect(spyRows).toHaveLength(1);
    expect(spyRows[0]!.userId).toBe('usr_new');
    expect(spyRows[0]!.hashes).toHaveLength(8);
    expect(captured.backupRows).toHaveLength(0);
  });
});

// ── property: code format + alphabet over many mints ───────────────────

describe('backup code format property (Req 14.1)', () => {
  it('every minted code is XXXX-XXXX from the [A-Z2-9] alphabet (I,O,0,1,L excluded)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 0 }), async () => {
        const captured = {
          backupRows: [] as Array<Record<string, unknown>>,
          auditRows: [] as Array<Record<string, unknown>>,
        };
        const db = makeFakeDb(captured) as never;
        const svc = new SetupService({
          db,
          requireSetupToken: false,
          smtpAvailable: false,
        });
        const outcome = await svc.complete(
          {
            account: {
              email: 'admin@example.com',
              password: 'CorrectHorseBatteryStaple!42',
              firstName: 'Ada',
              lastName: 'Lovelace',
            },
            adminPath: '/lumi-7f3a9c',
            policy: { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy,
          },
          {},
        );
        if (!outcome.ok) return false;
        return outcome.value.backupCodes.every(
          (c) =>
            /^[A-Z2-9]{8}-[A-Z2-9]{8}$/.test(c) &&
            !/[IO01L]/.test(c.replace('-', '')),
        );
      }),
      { numRuns: 25 },
    );
  });
});
