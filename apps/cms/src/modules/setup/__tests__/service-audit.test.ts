import { describe, it, expect, vi } from 'vitest';

import {
  SetupService,
  type AuditLoggerLike,
} from '../service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../policy-codec';

/**
 * Unit tests for the task 11.2 audit wiring in SetupService.complete().
 *
 * `complete()` now emits the five Req 15.1 setup events through the
 * injected {@link AuditLoggerLike} (defaulting to a real AuditLogger in
 * production): `setup_started` (pre-tx, after validation),
 * `bootstrap_admin_created`, `admin_path_set`, `lockout_policy_updated`,
 * and `setup_completed` (all post-commit). A spy logger records every
 * `write(entry)` so we assert the event set + that the Admin_Path is
 * recorded ONLY as a masked `adminPathHash`, never raw.
 *
 * Runs without Postgres against the same hand-rolled fake Drizzle
 * client used by `backup-codes-persister.test.ts`.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3**
 */

// ── fake DB (mirrors backup-codes-persister.test.ts) ────────────────────

function getTableName(table: { [k: string]: unknown }): string {
  for (const sym of Object.getOwnPropertySymbols(table)) {
    const desc = sym.description ?? '';
    if (desc.includes('Name')) {
      const v = (table as Record<symbol, unknown>)[sym];
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

function makeFakeDb(
  systemStateRow: {
    state: string;
    setupTokenHash: string | null;
    adminPath: string | null;
  } = { state: 'uninitialized', setupTokenHash: null, adminPath: null },
) {
  const queryApi = {
    insert(table: { [k: string]: unknown }) {
      void getTableName(table);
      return {
        values() {
          const builder = {
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
            async onConflictDoNothing() {
              /* no-op */
            },
            then(resolve: (v: unknown) => void) {
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
                  return Promise.resolve([systemStateRow]);
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

  return {
    ...queryApi,
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(queryApi);
    },
  };
}

function makeSpyAudit(): {
  audit: AuditLoggerLike;
  calls: Array<Parameters<AuditLoggerLike['write']>[0]>;
} {
  const calls: Array<Parameters<AuditLoggerLike['write']>[0]> = [];
  const audit: AuditLoggerLike = {
    async write(entry) {
      calls.push(entry);
    },
  };
  return { audit, calls };
}

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

describe('SetupService.complete() → audit events (Req 15.1)', () => {
  it('emits the five setup events through the injected AuditLogger', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb() as never;
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      audit,
    });

    const outcome = await svc.complete(makeInput(), {
      requestId: 'req-audit',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(outcome.ok).toBe(true);

    const events = calls.map((c) => c.event);
    expect(events).toContain('setup_started');
    expect(events).toContain('bootstrap_admin_created');
    expect(events).toContain('admin_path_set');
    expect(events).toContain('lockout_policy_updated');
    expect(events).toContain('setup_completed');
  });

  it('records the Admin_Path only as a masked hash, never raw (Req 15.3)', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb() as never;
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      audit,
    });

    await svc.complete(makeInput(), { requestId: 'req-audit' });

    const completed = calls.find((c) => c.event === 'setup_completed')!;
    expect(completed.metadata).toHaveProperty('adminPathHash');
    // The raw path must NOT appear anywhere in the serialized metadata.
    const serialized = JSON.stringify(calls.map((c) => c.metadata));
    expect(serialized).not.toContain('/lumi-7f3a9c');
    // adminPathHash is the 8-byte (16-hex-char) SHA-256 prefix.
    expect(completed.metadata!.adminPathHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('threads requestId / actorEmail onto setup_completed', async () => {
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb() as never;
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      audit,
    });

    await svc.complete(makeInput(), { requestId: 'req-xyz' });

    const completed = calls.find((c) => c.event === 'setup_completed')!;
    expect(completed).toMatchObject({
      actorEmail: 'admin@example.com',
      targetEmail: 'admin@example.com',
      requestId: 'req-xyz',
    });
  });

  it('rejects already-initialized setup before hashing or audit writes', async () => {
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      state: 'initialized',
      setupTokenHash: null,
      adminPath: '/existing-admin',
    }) as never;
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      audit,
    });

    try {
      const outcome = await svc.complete(makeInput(), { requestId: 'req-init' });
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'ALREADY_INITIALIZED' },
      });
      expect(deriveSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally {
      deriveSpy.mockRestore();
    }
  });

  it('rejects a missing setup token before hashing or audit writes', async () => {
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
    const { audit, calls } = makeSpyAudit();
    const db = makeFakeDb({
      state: 'uninitialized',
      setupTokenHash: 'not-a-valid-token-hash',
      adminPath: null,
    }) as never;
    const svc = new SetupService({
      db,
      requireSetupToken: true,
      smtpAvailable: false,
      audit,
    });

    try {
      const outcome = await svc.complete(makeInput(), { requestId: 'req-token' });
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'SETUP_TOKEN_REQUIRED' },
      });
      expect(deriveSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally {
      deriveSpy.mockRestore();
    }
  });

  it('completes successfully with the default AuditLogger (no spy injected)', async () => {
    // Backward-compat: with no `audit` dep, complete() falls back to a
    // real AuditLogger bound to the same db. The fake DB's audit_log
    // insert resolves as a no-op, so complete() still succeeds.
    const db = makeFakeDb() as never;
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
    });
    const outcome = await svc.complete(makeInput(), { requestId: 'req-default' });
    expect(outcome.ok).toBe(true);
  });
});
