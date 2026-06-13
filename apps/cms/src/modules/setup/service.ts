/**
 * SetupService — implements the three public surfaces of the Setup
 * Wizard backend (design §6.5):
 *
 *   - {@link SetupService.getState} → `GET /api/v1/setup/state`
 *     Reports `'initialized'` when a row in `users` carries
 *     `is_bootstrap=true`, `'uninitialized'` otherwise. Falls back to
 *     `system_state.state` when the singleton row is present (e.g. a
 *     wizard run that crashed mid-`initializing`). The
 *     `requiresSetupToken` flag is read from the operator-provided
 *     option so the service stays runtime-agnostic.
 *
 *   - {@link SetupService.getCapabilities} → `GET /api/v1/setup/capabilities`
 *     Probes for the GeoIP MMDB file (filesystem `existsSync` check) and
 *     SMTP env var. Both probes are optional and cheap so the wizard's
 *     conditional UI can update without a follow-up request.
 *
 *   - {@link SetupService.complete} → `POST /api/v1/setup/complete`
 *     Performs the atomic setup transaction: row-locks `system_state`
 *     for the `'singleton'` row, validates input, hashes the password
 *     and 8 backup codes, inserts the bootstrap admin, writes the
 *     lockout policy into `settings`, and flips `system_state.state` to
 *     `'initialized'` — all in a single Drizzle transaction. The audit
 *     log entry is emitted *after* commit (Req 1.5: no side-effects
 *     leak when rollback happens).
 *
 * The service does not own HTTP responses — the route handlers in
 * `routes.ts` translate `SetupServiceError` results to HTTP envelopes.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  adminBackupCodes,
  agentAutonomyGrants,
  agentRoles,
  constitutions,
  roles,
  settings,
  sites,
  systemState,
  userRoles,
  users,
  type Database,
} from '@lumibase/database';
import { hashPassword } from '../../services/auth/password';
import { ROLE_LIBRARY } from '../../services/agent-role-service';
import { AUTONOMY_LEVELS } from '../../services/autonomy-service';
import {
  BASELINE_CONSTITUTION_TEMPLATE,
  computeConstitutionHash,
} from '../../services/constitution-service';
import {
  CONTENT_OS_FLAG_DEFAULTS,
  CONTENT_OS_SETTINGS_KEY,
} from '../../services/feature-flags';
import { AuditLogger } from '../audit/logger';
import {
  serializeLockoutPolicy,
  type LockoutPolicy,
} from './policy-codec';
import {
  normalizeAdminPath,
  validateAdminPath,
} from './path-validator';
import { verifySetupToken } from './setup-token';

// ── public types ────────────────────────────────────────────────────────

export type SystemStateValue = 'uninitialized' | 'initialized';

export interface SetupStateResponse {
  readonly state: SystemStateValue;
  readonly requiresSetupToken: boolean;
}

export interface SetupCapabilities {
  readonly geoip: { readonly available: boolean; readonly source?: 'maxmind' };
  readonly smtp: { readonly available: boolean };
}

export interface SetupCompleteAccount {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface SetupCompleteInput {
  readonly setupToken?: string;
  readonly account: SetupCompleteAccount;
  readonly adminPath: string;
  readonly policy: LockoutPolicy;
  readonly project?: SetupCompleteProject;
}

export interface SetupCompleteProject {
  readonly defaultLanguage: string;
  readonly siteUrl: string;
  readonly displayTitle: string;
  readonly theme?: null;
}

interface NormalizedProjectConfiguration {
  readonly defaultLanguage: string;
  readonly siteUrl: string;
  readonly displayTitle: string;
  readonly theme: null;
}

export interface SetupCompleteContext {
  /** Originating request id; threaded into the post-commit audit log entry. */
  readonly requestId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

export interface SetupCompleteResult {
  readonly user: PublicUser;
  readonly adminPath: string;
  /**
   * Plaintext backup codes — returned exactly once. The DB only holds
   * the PBKDF2 hashes (Req 14.2), persisted into `admin_backup_codes`
   * inside the setup transaction via the injected
   * {@link BackupCodesPersister} (default:
   * {@link defaultBackupCodesPersister}). The plaintext never touches
   * the database and is unrecoverable after this response, so the
   * wizard's "Recovery Setup" step must surface it to the operator now.
   */
  readonly backupCodes: ReadonlyArray<string>;
  /**
   * The setup token is invalidated during the setup transaction. Returning
   * `null` keeps the HTTP response aligned with the wizard contract and lets
   * clients assert that no reusable token survived completion.
   */
  readonly setupToken: null;
}

// ── error taxonomy ──────────────────────────────────────────────────────

export type SetupServiceError =
  | { readonly code: 'ALREADY_INITIALIZED' }
  | { readonly code: 'SETUP_IN_PROGRESS' }
  | { readonly code: 'SETUP_TOKEN_REQUIRED' }
  | { readonly code: 'SETUP_TOKEN_INVALID' }
  | {
      readonly code: 'VALIDATION_ERROR';
      readonly issues: ReadonlyArray<{
        readonly path: ReadonlyArray<string | number>;
        readonly message: string;
      }>;
    }
  | { readonly code: 'PATH_PREDICTABLE'; readonly message: string }
  | { readonly code: 'PATH_RESERVED'; readonly message: string }
  | { readonly code: 'PATH_TAKEN' }
  | { readonly code: 'INTERNAL'; readonly cause?: unknown };

export type SetupCompleteOutcome =
  | { readonly ok: true; readonly value: SetupCompleteResult }
  | { readonly ok: false; readonly error: SetupServiceError };

// ── dependencies ────────────────────────────────────────────────────────

/**
 * Persistence hook for the eight backup-code hashes. The
 * `admin_backup_codes` table (task 10.1) now exists, so the default
 * implementation — {@link defaultBackupCodesPersister} — performs the
 * real INSERT inside the setup transaction; one row per hash with
 * `usedAt`/`usedFromIp` left NULL (a code is spendable until redeemed).
 *
 * The hook stays injectable so tests can stub/spy the persistence step
 * without a live Postgres. Because the inserts run on the same `tx`
 * handle as the rest of `complete()`, a rollback leaves zero backup-code
 * rows behind (Req 1.5: no side effect leaks on failure).
 */
export type BackupCodesPersister = (
  args: {
    readonly userId: string;
    readonly hashes: ReadonlyArray<string>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
) => Promise<void>;

/**
 * Capability probe for GeoIP. Default: filesystem check at the standard
 * volume path. Tests can inject a stub.
 */
export type GeoipProbe = () => boolean;

export interface SetupServiceDeps {
  readonly db: Database;
  readonly requireSetupToken: boolean;
  readonly smtpAvailable: boolean;
  readonly geoipProbe?: GeoipProbe;
  readonly backupCodesPersister?: BackupCodesPersister;
  /**
   * Audit logger for the post-commit Req 15.1 setup events
   * (admin-setup-wizard task 11.2): `setup_started`, `setup_completed`,
   * `bootstrap_admin_created`, `admin_path_set`, `lockout_policy_updated`.
   *
   * OPTIONAL + injectable. When omitted, `complete()` constructs a
   * default `new AuditLogger({ db })` bound to the same per-request
   * client, so the production behaviour (writing the audit rows) is
   * preserved exactly as the former `auditWriter ?? makeFallbackAuditWriter()`
   * default did — only now through the real {@link AuditLogger} (secret
   * masking + ≤1s budget + structured fallback, task 11.1). Tests can
   * inject a spy `{ async write(e) { calls.push(e) } }` to assert the
   * emitted entries without a live Postgres; the existing
   * `backup-codes-persister.test.ts` / `setup-flow.integration.test.ts`
   * suites pass no `audit` and rely on the default, which still writes
   * the `setup_completed` row they assert on.
   *
   * `AuditLogger.write` is best-effort + never-throws (task 11.1), so a
   * failed audit write can never roll back or fail the setup (Req 1.5).
   */
  readonly audit?: AuditLoggerLike;
}

/**
 * Structural shape of {@link AuditLogger} that {@link SetupService}
 * depends on — just the `write` method. Declared as a narrow interface
 * (rather than the concrete class) so tests can inject a tiny spy
 * without constructing a real logger, while the real `AuditLogger`
 * satisfies it. Matches the `Omit<AuditLogEntry,'id'|'timestamp'>`
 * input the logger accepts.
 */
export interface AuditLoggerLike {
  write(entry: {
    event: string;
    actorEmail?: string | null;
    targetEmail?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    countryCode?: string | null;
    metadata?: Record<string, unknown>;
    requestId?: string | null;
  }): Promise<void>;
}

// ── service ─────────────────────────────────────────────────────────────

const DEFAULT_GEOIP_PATH = '/var/lib/lumibase/geoip/GeoLite2-Country.mmdb';
const SETUP_LOCK_TIMEOUT_MS = 5_000;
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // strip I,O,0,1,L
const PROJECT_SETTINGS_KEY = 'project_configuration';

export class SetupService {
  constructor(private readonly deps: SetupServiceDeps) {}

  /**
   * Read setup state. Bootstrap-admin presence is the source of truth
   * (Req 1.2, 1.3); `system_state.state` only matters when there's no
   * users row yet (e.g. a brand-new instance before the first complete).
   */
  async getState(): Promise<SetupStateResponse> {
    const { db, requireSetupToken } = this.deps;

    const bootstrapRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isBootstrap, true))
      .limit(1);

    if (bootstrapRows.length > 0) {
      return { state: 'initialized', requiresSetupToken: false };
    }

    return { state: 'uninitialized', requiresSetupToken: requireSetupToken };
  }

  /**
   * Probe ambient capabilities. Both probes are best-effort — a probe
   * failure must not fail the request.
   */
  async getCapabilities(): Promise<SetupCapabilities> {
    const probe = this.deps.geoipProbe ?? defaultGeoipProbe;
    let geoipAvailable = false;
    try {
      geoipAvailable = probe();
    } catch {
      geoipAvailable = false;
    }

    return {
      geoip: geoipAvailable
        ? { available: true, source: 'maxmind' }
        : { available: false },
      smtp: { available: this.deps.smtpAvailable },
    };
  }

  /**
   * Atomic setup. Returns a tagged outcome rather than throwing so the
   * route handler can map errors to HTTP codes deterministically.
   *
   * Algorithm (design §6.5):
   *   1. Open a transaction; row-lock the singleton.
   *   2. If state ≠ 'uninitialized' → return ALREADY_INITIALIZED.
   *   3. Verify setup token (if required).
   *   4. Normalise + validate adminPath.
   *   5. Validate account (email shape, password length); the callers
   *      already validate via Zod but we re-check defensively.
   *   6. Set state='initializing'.
   *   7. Hash password + backup codes.
   *   8. Upsert the default site (so the bootstrap admin and policy
   *      have a `siteId` to attach to — see §15.7 / open question).
   *   9. Insert the bootstrap user with isBootstrap=true.
   *  10. Persist backup code hashes via the injected persister
   *      (defaults to `defaultBackupCodesPersister`, which writes the
   *      `admin_backup_codes` rows on the same tx).
   *  11. Upsert `settings.login_security_policy` with the canonical JSON.
   *  12. Flip system_state.state='initialized', store adminPath, clear
   *      setup token hash, stamp initializedAt.
   *  13. Commit.
   *  14. Audit-log `setup_completed` post-commit (Req 1.5: side
   *      effects only after commit).
   */
  async complete(
    input: SetupCompleteInput,
    ctx: SetupCompleteContext,
  ): Promise<SetupCompleteOutcome> {
    const { db } = this.deps;

    // ── 4. Normalise + validate path eagerly, before opening a tx,
    //       so callers don't pay for a connection on obvious garbage.
    const normalizedPath = normalizeAdminPath(input.adminPath);
    const pathCheck = validateAdminPath(normalizedPath);
    if (!pathCheck.ok) {
      return {
        ok: false,
        error:
          pathCheck.code === 'INVALID_FORMAT'
            ? {
                code: 'VALIDATION_ERROR',
                issues: [
                  { path: ['adminPath'], message: pathCheck.message },
                ],
              }
            : pathCheck.code === 'PATH_PREDICTABLE'
            ? { code: 'PATH_PREDICTABLE', message: pathCheck.message }
            : { code: 'PATH_RESERVED', message: pathCheck.message },
      };
    }

    // ── 5. Account shape check (defensive, route layer should have run
    //       Zod first). We don't enforce zxcvbn here — that's a wizard
    //       UX concern (Req 3.7) and recheck would require the package.
    const accountIssues = validateAccount(input.account);
    if (accountIssues.length > 0) {
      return {
        ok: false,
        error: { code: 'VALIDATION_ERROR', issues: accountIssues },
      };
    }

    const policyJson = serializeLockoutPolicy(input.policy);
    const policyValue = JSON.parse(policyJson) as Record<string, unknown>;
    const projectCheck = validateProject(input.project);
    if (!projectCheck.ok) {
      return {
        ok: false,
        error: { code: 'VALIDATION_ERROR', issues: projectCheck.issues },
      };
    }
    const projectValue = projectCheck.value;

    let outcome: SetupCompleteOutcome | undefined;

    try {
      await db.transaction(async (tx) => {
        // ── 1. Bound the time we'll spend waiting on the row lock
        //       (design §6.6). We use `SELECT set_config(...)` rather
        //       than `SET LOCAL statement_timeout = $1` because
        //       Postgres' `SET` statement does not accept bind
        //       parameters via the extended-query protocol — the same
        //       reason `apps/cms/src/middleware/rls.ts` reaches for
        //       `set_config`. The third arg `true` makes the change
        //       transaction-local, so it cleans up automatically on
        //       commit/rollback.
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(
            SETUP_LOCK_TIMEOUT_MS,
          )}, true)`,
        );

        // Ensure the singleton row exists so the FOR UPDATE below has
        // something to lock. The CHECK constraint on `system_state.id`
        // makes the upsert a no-op for any subsequent caller.
        await tx
          .insert(systemState)
          .values({ id: 'singleton', state: 'uninitialized' })
          .onConflictDoNothing();

        // Drizzle's `.for('update')` issues `SELECT … FOR UPDATE` on
        // the matching row, blocking concurrent writers (Req 1.7).
        // With statement_timeout=5s, blocked sessions surface 57014
        // which we map to SETUP_IN_PROGRESS in the catch block below.
        const lockedRows = await tx
          .select({
            state: systemState.state,
            setupTokenHash: systemState.setupTokenHash,
            adminPath: systemState.adminPath,
          })
          .from(systemState)
          .where(eq(systemState.id, 'singleton'))
          .for('update');

        const locked = lockedRows[0];
        if (!locked) {
          // The upsert above guarantees a row, so absence here means
          // the singleton was deleted out from under us (e.g. test
          // cleanup mid-run). Treat as a transient internal error.
          throw new SetupAbort({ code: 'INTERNAL' });
        }

        // ── 2. Already done? Bootstrap-admin presence is the source of
        //       truth (Req 1.2/1.3); `state === 'initialized'` is the
        //       fast path. The `'initializing'` branch is defensive —
        //       with the row lock + statement_timeout combo no
        //       concurrent caller should ever observe this state, but
        //       a previously-killed process could have left it stuck
        //       and the operator deserves a clear signal.
        if (locked.state === 'initialized') {
          throw new SetupAbort({ code: 'ALREADY_INITIALIZED' });
        }
        if (locked.state === 'initializing') {
          throw new SetupAbort({ code: 'SETUP_IN_PROGRESS' });
        }

        // ── 3. Setup token gate (Req 2.6).
        if (this.deps.requireSetupToken) {
          if (!input.setupToken) {
            throw new SetupAbort({ code: 'SETUP_TOKEN_REQUIRED' });
          }
          const ok = await verifySetupToken(
            input.setupToken,
            locked.setupTokenHash,
          );
          if (!ok) {
            throw new SetupAbort({ code: 'SETUP_TOKEN_INVALID' });
          }
        }

        // ── 5b. `setup_started` audit entry (Req 15.1; task 11.2). Emit it
        //        only after the cheap initialized/token gates pass so an
        //        unauthenticated caller cannot force setup-attempt audit writes
        //        or the PBKDF2 work below with missing/invalid tokens.
        await this.resolveAuditLogger().write({
          event: 'setup_started',
          actorEmail: input.account.email,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          requestId: ctx.requestId ?? null,
          metadata: { adminPathHash: await sha256ShortHex(normalizedPath) },
        });

        // ── 6. Hash only after the row-lock, initialized-state check, and
        //       setup-token gate have succeeded. PBKDF2 100k is intentionally
        //       expensive, so invalid public setup requests must be rejected
        //       before reaching this point.
        const passwordHash = await hashPassword(input.account.password);
        const plainBackupCodes: string[] = [];
        for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
          plainBackupCodes.push(generateBackupCode());
        }
        const backupCodeHashes = await Promise.all(
          plainBackupCodes.map((c) => hashPassword(c)),
        );

        const baselineConstitutionHash = await computeConstitutionHash(
          BASELINE_CONSTITUTION_TEMPLATE,
        );

        // Path uniqueness is enforced by the
        // `system_state_admin_path_unique` index on commit. Because
        // `system_state` is a singleton, that index can only collide
        // with itself after a stale write — captured by the 23505
        // mapping in the outer catch block.

        // ── 8. Upsert the default site so the bootstrap admin and all
        //       subsequent schema objects (collections, fields, settings)
        //       have a valid `siteId` FK to reference (design §6.5 step 8,
        //       see also open-question-8 in the deferred lockout policy block).
        //       We use a fixed id `'__default__'` so a re-entrant wizard
        //       run (e.g. after a crash mid-initializing) is idempotent.
        //       The operator can rename/reconfigure the site via the Studio
        //       after first-run.
        const DEFAULT_SITE_ID = '__default__';
        await tx
          .insert(sites)
          .values({ id: DEFAULT_SITE_ID, name: projectValue.displayTitle })
          .onConflictDoNothing();

        // ── 8b. Seed the agent role library (Setup Impact Registry #1;
        //        content-os Req 10.3). Without this, `agent_roles` stays
        //        empty until the first `GET /agent/roles` lazily seeds it,
        //        and any agent run before that fails "role not found".
        //        `onConflictDoNothing` keeps a re-entrant wizard run (and
        //        the lazy `ensureSeeded()` fallback) idempotent.
        await tx
          .insert(agentRoles)
          .values(
            ROLE_LIBRARY.map((role) => ({
              siteId: DEFAULT_SITE_ID,
              name: role.name,
              description: role.description,
              systemPromptRef: role.systemPromptRef,
              capabilities: [...role.capabilities],
            })),
          )
          .onConflictDoNothing();

        // ── 8c. Materialise the Content OS feature flags row, all OFF
        //        (Setup Impact Registry #2). With the row present, Studio
        //        has a base row to toggle and "never set" is
        //        distinguishable from "intentionally off".
        await tx
          .insert(settings)
          .values({
            siteId: DEFAULT_SITE_ID,
            key: CONTENT_OS_SETTINGS_KEY,
            value: CONTENT_OS_FLAG_DEFAULTS,
            scope: 'site',
          })
          .onConflictDoNothing();

        // ── 9. Insert the bootstrap admin.
        const inserted = await tx
          .insert(users)
          .values({
            email: input.account.email,
            passwordHash,
            firstName: input.account.firstName,
            lastName: input.account.lastName,
            status: 'active',
            isBootstrap: true,
          })
          .returning({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          });

        const newUser = inserted[0];
        if (!newUser) {
          throw new SetupAbort({ code: 'INTERNAL' });
        }

        // ── 9a. Create the platform `Administrator` role (admin bypass) and
        //        bind the bootstrap admin to it. requirements.md Req 3 states
        //        the initialized state requires a user with role `admin` and
        //        `is_bootstrap=true`; without an actual RBAC role the
        //        PermissionService bundle resolves `admin=false` and every
        //        schema/items request 403s. `systemKey: 'administrator'` keeps
        //        a re-entrant wizard run idempotent via the
        //        `roles_site_system_key_unique` index.
        const adminRoleId = await this.upsertAdministratorRole(
          tx,
          DEFAULT_SITE_ID,
        );
        await tx
          .insert(userRoles)
          .values({
            userId: newUser.id,
            siteId: DEFAULT_SITE_ID,
            roleId: adminRoleId,
          })
          .onConflictDoNothing();

        // ── 9. Persist backup code hashes into `admin_backup_codes`
        //       (task 10.1 created the table). Runs on the same `tx`
        //       handle so the rows commit atomically with the bootstrap
        //       admin — a rollback leaves zero backup-code rows. The
        //       persister is injectable (tests stub it); production
        //       falls back to `defaultBackupCodesPersister`, mirroring
        //       the `auditWriter ?? makeFallbackAuditWriter()` pattern.
        const persistBackupCodes =
          this.deps.backupCodesPersister ?? defaultBackupCodesPersister;
        await persistBackupCodes(
          { userId: newUser.id, hashes: backupCodeHashes },
          tx,
        );

        // ── 9b. Baseline autonomy grants (Setup Impact Registry #3):
        //        one explicit L1 (PROPOSE — full HITL) grant per
        //        (role, capability) in the seed library, so autonomy is
        //        data with an audit trail from day one rather than a
        //        hardcoded fallback. L1 is the only level that can never
        //        ELEVATE a dangerous skill sharing a capability with a
        //        safe one (resolver fallback is L1 dangerous / L2 safe,
        //        but a grant row applies to both contexts) — matching the
        //        v0.5.0 rollout guidance "start agents at L0/L1 per site
        //        and promote via trust ledger". Fresh instances only; we
        //        deliberately do NOT backfill existing instances, where
        //        the implicit safe→L2 fallback is already in effect.
        await tx
          .insert(agentAutonomyGrants)
          .values(
            ROLE_LIBRARY.flatMap((role) =>
              role.capabilities.map((capability) => ({
                siteId: DEFAULT_SITE_ID,
                agentRole: role.name,
                capability,
                level: AUTONOMY_LEVELS.PROPOSE,
                grantedBy: newUser.id,
                evidence: { source: 'setup_bootstrap' },
              })),
            ),
          )
          .onConflictDoNothing();

        // ── 9c. Baseline constitution, seeded as a DRAFT (Setup Impact
        //        Registry #4). Drafts have zero runtime effect — the
        //        publish gate only consults the active version — so this
        //        is purely a discoverability seed: the operator reviews
        //        and activates it in Mission Control. Every template
        //        evaluator is report-only (`blocking: false`), so even
        //        activation never vetoes a publish until a human flips a
        //        rule to blocking.
        await tx
          .insert(constitutions)
          .values({
            siteId: DEFAULT_SITE_ID,
            version: 1,
            evaluators: [...BASELINE_CONSTITUTION_TEMPLATE],
            hash: baselineConstitutionHash,
            status: 'draft',
            createdBy: newUser.id,
          })
          .onConflictDoNothing();

        // ── 10. Lockout policy persistence (Req 6.6, 6.7; Setup Impact
        //        Registry #5 — resolves open-question-8). The policy row
        //        lives under the `__default__` site because that is the
        //        only site that exists at bootstrap, and the reader
        //        (`loadLockoutPolicyFromSettings` in login-guard) looks
        //        the row up by `key` alone — so this placement satisfies
        //        the instance-wide semantics without prejudging the
        //        multi-tenancy decision. If per-site policies land later,
        //        the reader is the single place to change. The canonical
        //        JSON also remains in the `setup_completed` audit entry
        //        (`metadata.policy`) for forensic replay.
        const policySettingsInsert = tx.insert(settings).values({
          siteId: DEFAULT_SITE_ID,
          key: 'login_security_policy',
          value: policyValue,
          scope: 'site',
        });
        if (typeof policySettingsInsert.onConflictDoUpdate === 'function') {
          await policySettingsInsert.onConflictDoUpdate({
            target: [settings.siteId, settings.key],
            set: { value: policyValue, updatedAt: new Date() },
          });
        } else {
          await policySettingsInsert;
        }

        const projectSettingsInsert = tx
          .insert(settings)
          .values({
            siteId: DEFAULT_SITE_ID,
            key: PROJECT_SETTINGS_KEY,
            value: projectValue,
            scope: 'site',
          });

        if (
          typeof projectSettingsInsert.onConflictDoUpdate === 'function'
        ) {
          await projectSettingsInsert.onConflictDoUpdate({
            target: [settings.siteId, settings.key],
            set: {
              value: projectValue,
              scope: 'site',
              updatedAt: new Date(),
            },
          });
        } else {
          await projectSettingsInsert;
        }

        // ── 11. Flip the singleton.
        await tx
          .update(systemState)
          .set({
            state: 'initialized',
            adminPath: normalizedPath,
            setupTokenHash: null,
            initializedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(systemState.id, 'singleton'));

        outcome = {
          ok: true,
          value: {
            user: {
              id: newUser.id,
              email: newUser.email,
              firstName: newUser.firstName,
              lastName: newUser.lastName,
            },
            adminPath: normalizedPath,
            backupCodes: plainBackupCodes,
            setupToken: null,
          },
        };
      });
    } catch (err) {
      if (err instanceof SetupAbort) {
        return { ok: false, error: err.error };
      }
      // Postgres unique-violation on system_state.admin_path or
      // users.is_bootstrap → translate to a user-facing code.
      const pgCode = pgErrorCode(err);
      if (pgCode === '23505') {
        return { ok: false, error: { code: 'PATH_TAKEN' } };
      }
      // statement_timeout while waiting on the row lock → treat as
      // a concurrent run.
      if (pgCode === '57014') {
        return { ok: false, error: { code: 'SETUP_IN_PROGRESS' } };
      }
      return { ok: false, error: { code: 'INTERNAL', cause: err } };
    }

    if (!outcome) {
      return { ok: false, error: { code: 'INTERNAL' } };
    }

    // ── 14. Post-commit audit (Req 1.5, 15.1; task 11.2). Failures
    //        here MUST NOT roll back the setup — `AuditLogger.write` is
    //        best-effort + never-throws (task 11.1), emitting the
    //        structured `console.error` fallback if the DB write fails,
    //        so the worst case is a (replayable) missing row. We emit
    //        the companion events alongside the primary `setup_completed`
    //        because they are all consequences of THIS successful setup:
    //          - `bootstrap_admin_created` — the bootstrap admin row,
    //          - `admin_path_set`          — the Admin_Path was chosen,
    //          - `lockout_policy_updated`  — the policy was captured,
    //          - `setup_completed`         — the wizard finished.
    //        Metadata is minimal + masked: the Admin_Path is recorded
    //        only as its 8-char SHA-256 prefix (`adminPathHash`), never
    //        the raw path (it is a secret — design §7.3); the policy is
    //        the canonical JSON. No password/hash/token is in scope.
    if (outcome.ok) {
      const audit = this.resolveAuditLogger();
      const adminPathHash = await sha256ShortHex(outcome.value.adminPath);
      const base = {
        actorEmail: outcome.value.user.email,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId ?? null,
      };

      // The four events are independent + best-effort, so we fire them
      // concurrently rather than serially — `AuditLogger.write` never
      // throws, so `Promise.all` can't reject, and parallelism keeps the
      // post-commit block off the request's critical path.
      await Promise.all([
        audit.write({
          ...base,
          event: 'bootstrap_admin_created',
          targetEmail: outcome.value.user.email,
          metadata: { userId: outcome.value.user.id },
        }),
        audit.write({
          ...base,
          event: 'admin_path_set',
          targetEmail: outcome.value.user.email,
          metadata: { adminPathHash },
        }),
        audit.write({
          ...base,
          event: 'lockout_policy_updated',
          targetEmail: outcome.value.user.email,
          metadata: { policy: policyValue },
        }),
        audit.write({
          ...base,
          event: 'setup_completed',
          targetEmail: outcome.value.user.email,
          metadata: { adminPathHash, policy: policyValue },
        }),
      ]);
    }

    return outcome;
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Resolve the {@link AuditLogger} to use for the post-commit setup
   * events. Honours an injected `audit` dep (tests pass a spy); falls
   * back to a real `new AuditLogger({ db })` bound to the same
   * per-request client — preserving the production behaviour the former
   * `auditWriter ?? makeFallbackAuditWriter()` default provided, now
   * through the secret-masking, budget-bounded, never-throwing logger
   * (task 11.1).
   */
  private resolveAuditLogger(): AuditLoggerLike {
    return this.deps.audit ?? new AuditLogger({ db: this.deps.db });
  }

  /**
   * Upsert the platform `Administrator` role for a site and return its id.
   * Idempotent across re-entrant wizard runs via the
   * `roles_site_system_key_unique` index — a second run reuses the existing
   * row rather than inserting a duplicate. `adminAccess: true` makes the
   * PermissionService bundle short-circuit to full bypass (see
   * docs permissions-rbac.md §"adminAccess=true là bypass toàn bộ").
   */
  private async upsertAdministratorRole(
    tx: any,
    siteId: string,
  ): Promise<string> {
    const inserted = await tx
      .insert(roles)
      .values({
        siteId,
        key: 'administrator',
        systemKey: 'administrator',
        name: 'Administrator',
        description: 'Full platform access. Created during first-run setup.',
        adminAccess: true,
        appAccess: true,
      })
      .onConflictDoNothing()
      .returning({ id: roles.id });

    if (inserted[0]?.id) return inserted[0].id;

    // Conflict path: row already exists (re-entrant run) — read it back.
    const existing = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.siteId, siteId), eq(roles.systemKey, 'administrator')),
      )
      .limit(1);

    const adminRoleId = existing[0]?.id;
    if (!adminRoleId) {
      throw new SetupAbort({ code: 'INTERNAL' });
    }
    return adminRoleId;
  }
}

// ── internal helpers ────────────────────────────────────────────────────

class SetupAbort extends Error {
  readonly error: SetupServiceError;
  constructor(error: SetupServiceError) {
    super(error.code);
    this.error = error;
  }
}

const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Mixed-class character set for the Req 3.3 password rules. The wizard
 * already enforces this client-side via Zod (`apps/studio/src/modules/
 * setup/schemas/account.ts`), but the service re-checks defensively so
 * a misbehaving client can't bypass the rule.
 */
const PASSWORD_SPECIAL_CHARS = /[!@#$%^&*()\-_=+\[\]{};:,.?\/]/;

function validateAccount(
  account: SetupCompleteAccount,
): Array<{ path: Array<string>; message: string }> {
  const issues: Array<{ path: Array<string>; message: string }> = [];
  if (typeof account.email !== 'string' || !EMAIL_REGEX.test(account.email)) {
    issues.push({ path: ['account', 'email'], message: 'invalid email' });
  }
  if (typeof account.password !== 'string' || account.password.length < 12) {
    issues.push({
      path: ['account', 'password'],
      message: 'password must be at least 12 characters',
    });
  } else {
    // Req 3.3 — must contain at least one lowercase, uppercase, digit,
    // and special character.
    const pwd = account.password;
    if (!/[a-z]/.test(pwd)) {
      issues.push({
        path: ['account', 'password'],
        message: 'password must contain a lowercase letter',
      });
    }
    if (!/[A-Z]/.test(pwd)) {
      issues.push({
        path: ['account', 'password'],
        message: 'password must contain an uppercase letter',
      });
    }
    if (!/\d/.test(pwd)) {
      issues.push({
        path: ['account', 'password'],
        message: 'password must contain a digit',
      });
    }
    if (!PASSWORD_SPECIAL_CHARS.test(pwd)) {
      issues.push({
        path: ['account', 'password'],
        message: 'password must contain a special character',
      });
    }
  }
  if (typeof account.firstName !== 'string' || account.firstName.trim().length === 0) {
    issues.push({ path: ['account', 'firstName'], message: 'required' });
  }
  if (typeof account.lastName !== 'string' || account.lastName.trim().length === 0) {
    issues.push({ path: ['account', 'lastName'], message: 'required' });
  }
  return issues;
}

function validateProject(project: SetupCompleteProject | undefined):
  | { ok: true; value: NormalizedProjectConfiguration }
  | {
      ok: false;
      issues: Array<{ path: Array<string>; message: string }>;
    } {
  if (!project) {
    return {
      ok: true,
      value: {
        defaultLanguage: 'en',
        siteUrl: 'http://localhost:5173',
        displayTitle: 'Lumibase',
        theme: null,
      },
    };
  }

  const issues: Array<{ path: Array<string>; message: string }> = [];
  const defaultLanguage = project.defaultLanguage.trim();
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(defaultLanguage)) {
    issues.push({
      path: ['project', 'defaultLanguage'],
      message: 'invalid language tag',
    });
  }

  let siteUrl = '';
  try {
    const url = new URL(project.siteUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({
        path: ['project', 'siteUrl'],
        message: 'site URL must use http or https',
      });
    }
    url.hash = '';
    if (url.pathname === '/') {
      url.pathname = '';
    } else {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    siteUrl = url.toString().replace(/\/$/, '');
  } catch {
    issues.push({ path: ['project', 'siteUrl'], message: 'invalid URL' });
  }

  const displayTitle = project.displayTitle
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (displayTitle.length < 2 || displayTitle.length > 80) {
    issues.push({
      path: ['project', 'displayTitle'],
      message: 'display title must be 2-80 characters',
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      defaultLanguage,
      siteUrl,
      displayTitle,
      theme: null,
    },
  };
}

function generateBackupCode(): string {
  // Draw characters from the alphabet using rejection sampling so the
  // distribution is uniform (no modulo bias).
  const alphabetLen = BACKUP_CODE_ALPHABET.length;
  const unbiasedUpperBound = Math.floor(256 / alphabetLen) * alphabetLen;
  let raw = '';

  while (raw.length < 16) {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < buf.length && raw.length < 16; i++) {
      const byte = buf[i]!;
      if (byte >= unbiasedUpperBound) continue;
      raw += BACKUP_CODE_ALPHABET[byte % alphabetLen];
    }
  }

  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}`;
}

/**
 * Default {@link BackupCodesPersister}: inserts one
 * `admin_backup_codes` row per pre-hashed backup code, all on the
 * supplied transaction handle so the writes are atomic with the rest
 * of `SetupService.complete()`. `id`/`createdAt` use their schema
 * defaults; `usedAt`/`usedFromIp` stay NULL (a freshly minted code is
 * spendable until redeemed — Req 14.2). When the array is empty the
 * insert is skipped so we never issue a zero-row `VALUES ()`.
 *
 * Exported so unit tests can exercise the row shape against a fake `tx`
 * without standing up Postgres.
 */
export const defaultBackupCodesPersister: BackupCodesPersister = async (
  { userId, hashes },
  tx,
) => {
  if (hashes.length === 0) return;
  const rows = hashes.map((codeHash) => ({ userId, codeHash }));
  await tx.insert(adminBackupCodes).values(rows);
};

function defaultGeoipProbe(): boolean {
  try {
    // Lazy require so Cloudflare Workers builds don't drag node:fs in.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.existsSync(DEFAULT_GEOIP_PATH);
  } catch {
    return false;
  }
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const candidate = (err as { code?: unknown }).code;
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

async function sha256ShortHex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += view[i]!.toString(16).padStart(2, '0');
  return hex;
}
