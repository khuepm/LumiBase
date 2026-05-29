import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  auditLog,
  createDb,
  systemState,
  users,
  type Database,
} from '@lumibase/database';
import { SetupService } from '../modules/setup/service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';

/**
 * Integration tests for the Setup Wizard atomic transaction
 * (Req 1.5, 1.7; design §6.5, §13.2; Properties 1, 3).
 *
 * Covers:
 *   - happy path: `complete()` flips state, inserts bootstrap admin,
 *     writes a `setup_completed` audit entry post-commit;
 *   - subsequent `getState()` returns `'initialized'`;
 *   - 5 concurrent `complete()` calls — exactly one wins, the others
 *     receive `ALREADY_INITIALIZED` (404) or `SETUP_IN_PROGRESS` (409).
 *
 * Uses the project's shared `DATABASE_URL` env var pattern: when the
 * variable is unset or the database isn't reachable the suite skips
 * with a warning so local-only `pnpm test` doesn't break.
 *
 * **Validates: Requirements 1.5, 1.7**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

describe('Setup flow — integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      canConnect = false;
    }
  });

  afterAll(async () => {
    // createDb returns a Drizzle wrapper; we let the underlying postgres
    // client be GC'd when the process exits. Tests do not hold long
    // connections.
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Reset every relevant table so each test starts on a clean slate.
    await db.execute(
      sql`TRUNCATE TABLE audit_log, system_state, users RESTART IDENTITY CASCADE`,
    );
  });

  function makeService() {
    return new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
    });
  }

  function makeInput(overrides?: { adminPath?: string; email?: string }) {
    return {
      account: {
        email: overrides?.email ?? 'admin@example.com',
        password: 'CorrectHorseBatteryStaple!42',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      adminPath: overrides?.adminPath ?? '/lumi-7f3a9c',
      policy: { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy,
    };
  }

  it('completes happy path and writes audit entry post-commit', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }
    const svc = makeService();

    // Pre-condition: state is uninitialized.
    const before = await svc.getState();
    expect(before.state).toBe('uninitialized');

    const outcome = await svc.complete(makeInput(), {
      requestId: 'req-happy',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.adminPath).toBe('/lumi-7f3a9c');
    expect(outcome.value.user.email).toBe('admin@example.com');
    expect(outcome.value.backupCodes).toHaveLength(8);
    // Backup codes have format XXXX-XXXX with 8+8 alphanum chars.
    for (const code of outcome.value.backupCodes) {
      expect(code).toMatch(/^[A-Z2-9]{8}-[A-Z2-9]{8}$/);
    }

    // Post-condition: state flipped, audit entry written.
    const after = await svc.getState();
    expect(after.state).toBe('initialized');

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'setup_completed'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actorEmail).toBe('admin@example.com');
    expect(auditRows[0]!.requestId).toBe('req-happy');

    // Bootstrap user marker is set on exactly one user.
    const bootstrapUsers = await db
      .select()
      .from(users)
      .where(eq(users.isBootstrap, true));
    expect(bootstrapUsers).toHaveLength(1);
    expect(bootstrapUsers[0]!.email).toBe('admin@example.com');

    // The singleton row records the chosen admin path.
    const ssRow = await db
      .select()
      .from(systemState)
      .where(eq(systemState.id, 'singleton'));
    expect(ssRow[0]!.adminPath).toBe('/lumi-7f3a9c');
    expect(ssRow[0]!.state).toBe('initialized');
    expect(ssRow[0]!.initializedAt).toBeInstanceOf(Date);
  });

  it('refuses a second setup once initialized (Req 1.4 / Property 2)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }
    const svc = makeService();
    const first = await svc.complete(makeInput(), {});
    expect(first.ok).toBe(true);

    // Second complete must be refused with ALREADY_INITIALIZED.
    const second = await svc.complete(
      makeInput({ adminPath: '/lumi-other', email: 'other@example.com' }),
      {},
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('ALREADY_INITIALIZED');
  });

  it('races: 5 concurrent setups — exactly one succeeds (Req 1.7 / Property 3)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // Each promise gets its own SetupService bound to a fresh client to
    // simulate independent connections (and therefore independent
    // transactions). Without separate clients postgres-js serializes
    // inside the same connection and the race is uninteresting.
    const N = 5;
    const services: SetupService[] = [];
    for (let i = 0; i < N; i++) {
      const d = createDb(TEST_DATABASE_URL!);
      services.push(
        new SetupService({
          db: d,
          requireSetupToken: false,
          smtpAvailable: false,
        }),
      );
    }

    const inputs = Array.from({ length: N }, (_, i) =>
      makeInput({
        adminPath: `/lumi-race-${i.toString().padStart(2, '0')}`,
        email: `admin${i}@example.com`,
      }),
    );
    const results = await Promise.all(
      services.map((s, i) => s.complete(inputs[i]!, {})),
    );

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(N - 1);

    const allowedCodes = new Set([
      'ALREADY_INITIALIZED',
      'SETUP_IN_PROGRESS',
      'PATH_TAKEN', // unique-violation surfaced if two tx land at the same time
    ]);
    for (const f of failures) {
      if (f.ok) continue;
      expect(allowedCodes.has(f.error.code)).toBe(true);
    }

    // Exactly one bootstrap admin in the table.
    const bootstrapUsers = await db
      .select()
      .from(users)
      .where(eq(users.isBootstrap, true));
    expect(bootstrapUsers).toHaveLength(1);
  });
});
