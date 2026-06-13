import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';

import {
  RecoveryService,
  InMemoryUnlockTokenStore,
  InMemoryRecoveryTokenStore,
  type RecoveryEmailSender,
} from '../service';
import { hashPassword } from '../../../services/auth/password';
import type { AuditLogger, AuditLogWriteInput } from '../../audit/logger';

/**
 * Unit tests for the task 11.2 audit wiring in the RecoveryService —
 * `recovery_completed` + `backup_code_used` (recover success) and
 * `recovery_initiated` (forgot-path match).
 *
 * A spy AuditLogger records every `write(entry)` so we can assert the
 * exact `event` codes the success / match paths emit. Crucially we also
 * assert the FAILURE / no-match branches write NOTHING (anti-enumeration
 * — the audit trail must not leak which emails exist, Req 14.4 / 14.5).
 * Backward-compat: a service constructed WITHOUT an `audit` dep behaves
 * identically and never writes (the large `service.test.ts` suite relies
 * on that).
 *
 * The fake Drizzle client mirrors `service.test.ts`: canned rows keyed
 * by table name + recorded UPDATE/DELETE calls, no Postgres.
 *
 * **Validates: Requirements 15.1, 15.2**
 */

// ── fake Drizzle client (mirrors service.test.ts) ───────────────────────

interface FakeDbOptions {
  readonly userRows?: ReadonlyArray<Record<string, unknown>>;
  readonly stateRows?: ReadonlyArray<Record<string, unknown>>;
  readonly codeRows?: ReadonlyArray<Record<string, unknown>>;
  readonly backupCodeUpdateRows?: ReadonlyArray<Record<string, unknown>>;
}

function makeFakeDb(opts: FakeDbOptions = {}) {
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
            limit() {
              return resolve();
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
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
        set() {
          return {
            where() {
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
      void getTableName(table as never);
      return {
        async where() {
          /* no-op */
        },
      };
    },
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

  return db as never;
}

function makeSpyAudit(): { audit: AuditLogger; calls: AuditLogWriteInput[] } {
  const calls: AuditLogWriteInput[] = [];
  const audit = {
    async write(entry: AuditLogWriteInput) {
      calls.push(entry);
    },
  } as unknown as AuditLogger;
  return { audit, calls };
}

class CapturingEmailSender implements RecoveryEmailSender {
  readonly calls: Array<{ to: string; recoveryToken: string }> = [];
  async sendRecoveryEmail(args: {
    to: string;
    recoveryToken: string;
  }): Promise<void> {
    this.calls.push({ to: args.to, recoveryToken: args.recoveryToken });
  }
}

const PLAINTEXT_CODE = 'ABCD-2345';
const ADMIN_PATH = '/lumi-7f3a9c';
const IP = '203.0.113.7';
const BOOT_EMAIL = 'boot@example.com';
const instantSleep = () => Promise.resolve();

async function bootstrapCodeRows(plain: string) {
  const codeHash = await hashPassword(plain);
  return [{ id: 'bkc_1', codeHash }];
}

// ── recover → recovery_completed + backup_code_used ─────────────────────

describe('RecoveryService.recover → audit (Req 15.1)', () => {
  it('writes backup_code_used + recovery_completed on success', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({
      db,
      tokenStore: new InMemoryUnlockTokenStore(),
      sleep: instantSleep,
      audit,
    });

    const result = await svc.recover(BOOT_EMAIL, PLAINTEXT_CODE, IP);
    expect(result).not.toBeNull();

    const events = calls.map((c) => c.event);
    expect(events).toContain('backup_code_used');
    expect(events).toContain('recovery_completed');

    const used = calls.find((c) => c.event === 'backup_code_used')!;
    expect(used).toMatchObject({
      event: 'backup_code_used',
      actorEmail: BOOT_EMAIL,
      targetEmail: BOOT_EMAIL,
      ip: IP,
    });
    // Records the redeemed code's id — NOT the code itself.
    expect(used.metadata).toMatchObject({ backupCodeId: 'bkc_1' });

    const completed = calls.find((c) => c.event === 'recovery_completed')!;
    expect(completed.metadata).toMatchObject({ method: 'backup_code' });
  });

  it('writes NOTHING on a failure branch (unknown email) — anti-enumeration', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({ userRows: [] });
    const svc = new RecoveryService({ db, sleep: instantSleep, audit });

    const result = await svc.recover('nobody@example.com', PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('writes NOTHING when the backup code does not match — anti-enumeration', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows('WXYZ-9876'), // a DIFFERENT code
    });
    const svc = new RecoveryService({ db, sleep: instantSleep, audit });

    const result = await svc.recover(BOOT_EMAIL, PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('writes NOTHING when the guarded backup-code update spends zero rows', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
      backupCodeUpdateRows: [],
    });
    const svc = new RecoveryService({ db, sleep: instantSleep, audit });

    const result = await svc.recover(BOOT_EMAIL, PLAINTEXT_CODE, IP);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is a no-op (no throw) when no audit logger is injected (backward compatibility)', async () => {
    const db = makeFakeDb({
      userRows: [{ id: 'usr_boot', isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
      codeRows: await bootstrapCodeRows(PLAINTEXT_CODE),
    });
    const svc = new RecoveryService({
      db,
      tokenStore: new InMemoryUnlockTokenStore(),
      sleep: instantSleep,
    });
    const result = await svc.recover(BOOT_EMAIL, PLAINTEXT_CODE, IP);
    expect(result).not.toBeNull();
  });
});

// ── forgotPath → recovery_initiated ─────────────────────────────────────

describe('RecoveryService.forgotPath → audit (Req 15.1)', () => {
  it('writes recovery_initiated on the match path', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      userRows: [{ id: 'usr_boot', email: BOOT_EMAIL, isBootstrap: true }],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: new InMemoryRecoveryTokenStore(),
      recoveryEmailSender: new CapturingEmailSender(),
      sleep: instantSleep,
      audit,
    });

    await svc.forgotPath('Boot@Example.COM', IP);

    const initiated = calls.filter((c) => c.event === 'recovery_initiated');
    expect(initiated).toHaveLength(1);
    expect(initiated[0]).toMatchObject({
      event: 'recovery_initiated',
      actorEmail: BOOT_EMAIL,
      targetEmail: BOOT_EMAIL,
      ip: IP,
    });
    expect(initiated[0]!.metadata).toMatchObject({ method: 'forgot_path' });
  });

  it('writes NOTHING for an unknown email — anti-enumeration', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({ userRows: [] });
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: new InMemoryRecoveryTokenStore(),
      recoveryEmailSender: new CapturingEmailSender(),
      sleep: instantSleep,
      audit,
    });

    await svc.forgotPath('nobody@example.com', IP);
    expect(calls).toHaveLength(0);
  });

  it('writes NOTHING for a non-bootstrap match — anti-enumeration', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      userRows: [
        { id: 'usr_member', email: 'member@example.com', isBootstrap: false },
      ],
      stateRows: [{ adminPath: ADMIN_PATH }],
    });
    const svc = new RecoveryService({
      db,
      recoveryTokenStore: new InMemoryRecoveryTokenStore(),
      recoveryEmailSender: new CapturingEmailSender(),
      sleep: instantSleep,
      audit,
    });

    await svc.forgotPath('member@example.com', IP);
    expect(calls).toHaveLength(0);
  });
});
