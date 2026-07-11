import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  adminBackupCodes,
  agentAutonomyGrants,
  agentRoles,
  auditLog,
  constitutions,
  createDb,
  settings,
  systemState,
  users,
  type Database,
} from '@lumibase/database';
import { ROLE_LIBRARY } from '../services/agent-role-service';
import { BASELINE_CONSTITUTION_TEMPLATE } from '../services/constitution-service';
import { CONTENT_OS_SETTINGS_KEY } from '../services/feature-flags';
import { SetupService } from '../modules/setup/service';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../modules/setup/policy-codec';
import { verifyPassword } from '../services/auth/password';

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
    // `admin_backup_codes` cascades from `users`, but list it explicitly
    // so the intent is obvious and RESTART IDENTITY covers it too.
    // `sites` cascades into `settings`, `agent_roles` and
    // `agent_autonomy_grants` (the Setup Impact seeds — task G.6).
    await db.execute(
      sql`TRUNCATE TABLE lumibase_admin_backup_codes, lumibase_audit_log, lumibase_system_state, lumibase_users, lumibase_sites RESTART IDENTITY CASCADE`,
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
    expect(outcome.value.setupToken).toBeNull();
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

    // Backup codes are persisted: exactly 8 rows for the new user,
    // each with a PBKDF2 hash and an unused (NULL) `used_at`
    // (Req 14.1, 14.2).
    const codeRows = await db
      .select()
      .from(adminBackupCodes)
      .where(eq(adminBackupCodes.userId, bootstrapUsers[0]!.id));
    expect(codeRows).toHaveLength(8);
    for (const row of codeRows) {
      expect(row.codeHash).toMatch(/^pbkdf2\$100000\$[0-9a-f]+\$[0-9a-f]+$/);
      expect(row.usedAt).toBeNull();
      expect(row.usedFromIp).toBeNull();
    }

    // Each returned plaintext code verifies against exactly one stored
    // hash — proving the response codes are the ones we persisted and
    // that no plaintext ever hit the DB.
    const storedHashes = codeRows.map((r) => r.codeHash);
    for (const plain of outcome.value.backupCodes) {
      const matches = await Promise.all(
        storedHashes.map((h) => verifyPassword(plain, h)),
      );
      expect(matches.filter(Boolean)).toHaveLength(1);
    }
  });

  it('seeds Content OS state in the setup transaction (Req 17; tasks G.1–G.3, G.5)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }
    const svc = makeService();
    const outcome = await svc.complete(makeInput(), {
      requestId: 'req-seeds',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(outcome.ok).toBe(true);

    // G.1 — agent role library: all 7 seed roles exist for the default site.
    const roleRows = await db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.siteId, '__default__'));
    expect(roleRows.map((r) => r.name).sort()).toEqual(
      ROLE_LIBRARY.map((r) => r.name).sort(),
    );

    // G.2 — Content OS flags row exists with every flag OFF.
    const [flagsRow] = await db
      .select()
      .from(settings)
      .where(
        and(
          eq(settings.siteId, '__default__'),
          eq(settings.key, CONTENT_OS_SETTINGS_KEY),
        ),
      );
    expect(flagsRow).toBeDefined();
    expect(flagsRow!.value).toEqual({
      reconciler: false,
      vetoWindow: false,
      agentReview: false,
      mcp: false,
    });

    // G.3 — one L1 grant per (role, capability), attributed to bootstrap.
    const grantRows = await db
      .select()
      .from(agentAutonomyGrants)
      .where(eq(agentAutonomyGrants.siteId, '__default__'));
    const expectedGrantCount = ROLE_LIBRARY.reduce(
      (n, r) => n + r.capabilities.length,
      0,
    );
    expect(grantRows).toHaveLength(expectedGrantCount);
    for (const grant of grantRows) {
      expect(grant.level).toBe(1);
      expect(grant.evidence).toEqual({ source: 'setup_bootstrap' });
      expect(grant.grantedBy).not.toBeNull();
    }

    // G.4 — baseline constitution seeded as a non-blocking draft.
    const constitutionRows = await db
      .select()
      .from(constitutions)
      .where(eq(constitutions.siteId, '__default__'));
    expect(constitutionRows).toHaveLength(1);
    expect(constitutionRows[0]!.status).toBe('draft');
    expect(constitutionRows[0]!.version).toBe(1);
    expect(constitutionRows[0]!.createdBy).not.toBeNull();
    const evaluators = constitutionRows[0]!.evaluators as Array<{
      id: string;
      blocking?: boolean;
    }>;
    expect(evaluators.map((e) => e.id).sort()).toEqual(
      BASELINE_CONSTITUTION_TEMPLATE.map((e) => e.id).sort(),
    );
    for (const evaluator of evaluators) {
      expect(evaluator.blocking).toBe(false);
    }

    // G.5 — lockout policy is persisted and queryable from settings.
    const [policyRow] = await db
      .select()
      .from(settings)
      .where(
        and(
          eq(settings.siteId, '__default__'),
          eq(settings.key, 'login_security_policy'),
        ),
      );
    expect(policyRow).toBeDefined();
    expect(policyRow!.value).toMatchObject({
      userMaxFailedAttempts: STANDARD_LOCKOUT_POLICY.userMaxFailedAttempts,
    });
  });

  it('rolls back backup-code rows when the setup transaction fails (Req 1.5 / 14.2)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // Inject a persister that throws *after* the bootstrap user insert
    // but inside the transaction. The whole `complete()` tx must roll
    // back, leaving zero backup-code rows and an uninitialized instance.
    const boom = new Error('persist exploded');
    const svc = new SetupService({
      db,
      requireSetupToken: false,
      smtpAvailable: false,
      backupCodesPersister: async () => {
        throw boom;
      },
    });

    const outcome = await svc.complete(makeInput(), { requestId: 'req-rollback' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('INTERNAL');

    // No backup-code rows survived the rollback.
    const codeRows = await db.select().from(adminBackupCodes);
    expect(codeRows).toHaveLength(0);

    // No bootstrap admin, state stays uninitialized — no side effects.
    const bootstrapUsers = await db
      .select()
      .from(users)
      .where(eq(users.isBootstrap, true));
    expect(bootstrapUsers).toHaveLength(0);
    expect((await svc.getState()).state).toBe('uninitialized');

    // No `setup_completed` audit entry (post-commit side effect never ran).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'setup_completed'));
    expect(auditRows).toHaveLength(0);
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
