import { describe, it, expect } from 'vitest';

import { SetupService, type AuditLoggerLike } from '../service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../policy-codec';

/**
 * Unit tests for the invite-during-setup feature (PLAN-simple-step2-redesign,
 * tasks B1–B4). `complete()` accepts an optional `invites[]` list; each entry
 * becomes a `status: 'invited'` user bound to the default site via
 * `user_sites`, created in the same transaction as the bootstrap admin. The
 * result reports `invitedCount`, and one `user_invited` audit event is emitted
 * per teammate.
 *
 * Runs without Postgres against the same hand-rolled fake Drizzle client used
 * by `service-audit.test.ts` / `backup-codes-persister.test.ts`. The fake
 * records every insert so we can assert which tables/rows were written.
 */

interface RecordedInsert {
  table: string;
  values: unknown;
}

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

function makeFakeDb(inserts: RecordedInsert[]) {
  let userSeq = 0;
  const queryApi = {
    insert(table: { [k: string]: unknown }) {
      const tableName = getTableName(table);
      return {
        values(vals: unknown) {
          inserts.push({ table: tableName, values: vals });
          const builder = {
            async returning() {
              if (tableName === 'lumibase_roles') {
                // Distinct ids per system role so admin/member don't collide.
                const v = vals as { systemKey?: string };
                return [{ id: `role_${v.systemKey ?? 'x'}` }];
              }
              if (tableName === 'lumibase_users') {
                userSeq += 1;
                const v = vals as Record<string, unknown>;
                return [
                  {
                    id: `usr_${userSeq}`,
                    email: v.email ?? 'admin@example.com',
                    firstName: v.firstName ?? 'Ada',
                    lastName: v.lastName ?? 'Lovelace',
                  },
                ];
              }
              return [];
            },
            onConflictDoNothing() {
              return {
                async returning() {
                  if (tableName === 'lumibase_roles') {
                    const v = vals as { systemKey?: string };
                    return [{ id: `role_${v.systemKey ?? 'x'}` }];
                  }
                  return [];
                },
                then(resolve: (v: unknown) => void) {
                  resolve(undefined);
                },
              };
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
              return {
                // Existence lookup for invitee email → always "not found"
                // on a fresh instance, so the invite path inserts a new user.
                limit() {
                  return Promise.resolve([]);
                },
                for() {
                  return Promise.resolve([
                    { state: 'uninitialized', setupTokenHash: null, adminPath: null },
                  ]);
                },
                then(resolve: (v: unknown) => void) {
                  resolve([]);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return { set() { return { async where() {} } } };
    },
    async execute() {},
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

function makeInput(invites?: Array<{ email: string; role: 'admin' | 'member' }>) {
  return {
    account: {
      email: 'admin@example.com',
      password: 'CorrectHorseBatteryStaple!42',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
    adminPath: '/lumi-7f3a9c',
    policy: { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy,
    ...(invites ? { invites } : {}),
  };
}

describe('SetupService.complete() → invites', () => {
  it('reports invitedCount 0 and writes no user_invited events when omitted', async () => {
    const inserts: RecordedInsert[] = [];
    const { audit, calls } = makeSpyAudit();
    const svc = new SetupService({
      db: makeFakeDb(inserts) as never,
      requireSetupToken: false,
      smtpAvailable: false, encryptionAvailable: true,
      audit,
    });

    const outcome = await svc.complete(makeInput(), { requestId: 'req-none' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.invitedCount).toBe(0);
    expect(calls.filter((c) => c.event === 'user_invited')).toHaveLength(0);
    // No Member role seeded, no user_sites rows when there are no invites.
    expect(inserts.some((i) => i.table === 'lumibase_user_sites')).toBe(false);
    expect(
      inserts.some(
        (i) =>
          i.table === 'lumibase_roles' &&
          (i.values as { systemKey?: string }).systemKey === 'member',
      ),
    ).toBe(false);
  });

  it('creates invited users, seeds Member role, and binds via user_sites', async () => {
    const inserts: RecordedInsert[] = [];
    const { audit, calls } = makeSpyAudit();
    const svc = new SetupService({
      db: makeFakeDb(inserts) as never,
      requireSetupToken: false,
      smtpAvailable: false, encryptionAvailable: true,
      audit,
    });

    const outcome = await svc.complete(
      makeInput([
        { email: 'Owner@Example.com', role: 'admin' },
        { email: 'editor@example.com', role: 'member' },
      ]),
      { requestId: 'req-invites' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.invitedCount).toBe(2);

    // Two invited users created with status 'invited' + shadow externalId.
    const invitedUsers = inserts.filter(
      (i) =>
        i.table === 'lumibase_users' &&
        (i.values as { status?: string }).status === 'invited',
    );
    expect(invitedUsers).toHaveLength(2);
    for (const u of invitedUsers) {
      const v = u.values as { externalId?: string; email?: string };
      expect(v.externalId).toMatch(/^shadow_/);
      // Emails are lowercased by normalizeInvites.
      expect(v.email).toBe(v.email?.toLowerCase());
    }

    // Member role seeded once (admin role already exists for the admin invite).
    expect(
      inserts.filter(
        (i) =>
          i.table === 'lumibase_roles' &&
          (i.values as { systemKey?: string }).systemKey === 'member',
      ),
    ).toHaveLength(1);

    // Two user_sites bindings: admin invite → administrator role, member → member role.
    const bindings = inserts.filter((i) => i.table === 'lumibase_user_sites');
    expect(bindings).toHaveLength(2);
    const roleIds = bindings.map((b) => (b.values as { roleId?: string }).roleId);
    expect(roleIds).toContain('role_administrator');
    expect(roleIds).toContain('role_member');

    // One user_invited audit event per teammate, with the role in metadata.
    const invited = calls.filter((c) => c.event === 'user_invited');
    expect(invited).toHaveLength(2);
    expect(invited.map((c) => c.targetEmail).sort()).toEqual([
      'editor@example.com',
      'owner@example.com',
    ]);
  });

  it('rejects an invite that collides with the admin email (VALIDATION_ERROR)', async () => {
    const inserts: RecordedInsert[] = [];
    const svc = new SetupService({
      db: makeFakeDb(inserts) as never,
      requireSetupToken: false,
      smtpAvailable: false, encryptionAvailable: true,
    });

    const outcome = await svc.complete(
      makeInput([{ email: 'ADMIN@example.com', role: 'admin' }]),
      { requestId: 'req-collide' },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('VALIDATION_ERROR');
    // No user/site writes should have happened — rejected before the tx.
    expect(inserts.some((i) => i.table === 'lumibase_user_sites')).toBe(false);
  });

  it('de-duplicates repeated invite emails (case-insensitive)', async () => {
    const inserts: RecordedInsert[] = [];
    const svc = new SetupService({
      db: makeFakeDb(inserts) as never,
      requireSetupToken: false,
      smtpAvailable: false, encryptionAvailable: true,
    });

    const outcome = await svc.complete(
      makeInput([
        { email: 'dup@example.com', role: 'member' },
        { email: 'DUP@example.com', role: 'admin' },
      ]),
      { requestId: 'req-dup' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.invitedCount).toBe(1);
    expect(inserts.filter((i) => i.table === 'lumibase_user_sites')).toHaveLength(1);
  });
});
