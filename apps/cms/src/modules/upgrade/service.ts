import { upgradeRequests, type Database } from '@lumibase/database';
import { migrationJournal, pendingMigrations } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuditLogger } from '../audit/logger';
import { upgradeConfigured, type UpgradeConfig } from './config';
import { getUpgradeProvider } from './providers';
import { compareVersions, fetchLatestRelease, type ReleaseInfo } from './releases';

/**
 * In-app upgrade orchestration (#898). The instance never replaces itself:
 * it checks that an upgrade is safe (preflight), asks the configured provider
 * to roll the deployment (`requestUpgrade`), and reports progress by comparing
 * the version it runs with the requested target (`upgradeStatus`).
 */

export type UpgradeRequestRow = typeof upgradeRequests.$inferSelect;

export interface UpgradeRequestView {
  readonly id: string;
  readonly targetVersion: string;
  readonly fromVersion: string;
  readonly status: 'requested' | 'completed' | 'failed';
  readonly provider: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly hookStatus: number | null;
  readonly hookReference: string | null;
  readonly error: string | null;
  readonly attempts: number;
  /** Requested more than {@link OVERDUE_AFTER_MS} ago and the target still does not answer. */
  readonly overdue: boolean;
}

/** How long a requested upgrade may take before Studio shows the rollback instruction. */
export const OVERDUE_AFTER_MS = 30 * 60 * 1000;

export function viewOf(row: UpgradeRequestRow, now = Date.now()): UpgradeRequestView {
  const status = row.status === 'completed' || row.status === 'failed' ? row.status : 'requested';
  return {
    id: row.id,
    targetVersion: row.targetVersion,
    fromVersion: row.fromVersion,
    status,
    provider: row.provider,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    hookStatus: row.hookStatus,
    hookReference: row.hookReference,
    error: row.error,
    attempts: row.attempts,
    overdue: status === 'requested' && now - row.requestedAt.getTime() > OVERDUE_AFTER_MS,
  };
}

// ─── Database state ──────────────────────────────────────────────────────────

export interface MigrationStatus {
  /** Journal entries of the running code that the database has not applied. */
  readonly pending: string[];
  /** The database has a migration newer than this build knows. */
  readonly databaseAhead: boolean;
}

export async function readMigrationStatus(systemDb: Database): Promise<MigrationStatus | null> {
  try {
    const rows = (await systemDb.execute(
      sql`SELECT max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ latest: string | number | null }>;
    const raw = rows[0]?.latest ?? null;
    const latest = raw === null ? null : Number(raw);
    const newest = migrationJournal.at(-1);
    return {
      pending: pendingMigrations(latest).map((m) => m.tag),
      databaseAhead: latest !== null && newest !== undefined && latest > newest.when,
    };
  } catch (err) {
    console.warn('[upgrade] could not read the migration state', formatSafeError(err));
    return null;
  }
}

async function latestRequest(systemDb: Database): Promise<UpgradeRequestRow | null> {
  try {
    const [row] = await systemDb
      .select()
      .from(upgradeRequests)
      .orderBy(desc(upgradeRequests.requestedAt))
      .limit(1);
    return row ?? null;
  } catch (err) {
    // Schema without migration 0044 (N-1 rollout): no request recorded.
    console.warn('[upgrade] could not read upgrade requests', formatSafeError(err));
    return null;
  }
}

/** Mark a requested upgrade completed once the running version reaches its target. */
async function reconcile(systemDb: Database, row: UpgradeRequestRow | null, currentVersion: string, now: number) {
  if (!row || row.status !== 'requested') return row;
  const cmp = compareVersions(currentVersion, row.targetVersion);
  if (cmp === null || cmp < 0) return row;
  const [updated] = await systemDb
    .update(upgradeRequests)
    .set({ status: 'completed', completedAt: new Date(now) })
    .where(and(eq(upgradeRequests.id, row.id), eq(upgradeRequests.status, 'requested')))
    .returning();
  return updated ?? row;
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export interface PreflightCheck {
  readonly id:
    | 'provider-configured'
    | 'release-known'
    | 'current-version-known'
    | 'newer-version'
    | 'minimum-safe-version'
    | 'migrations-applied'
    | 'no-upgrade-in-flight';
  readonly ok: boolean;
  readonly message: string;
}

export interface Preflight {
  readonly currentVersion: string;
  readonly targetVersion: string | null;
  readonly release: ReleaseInfo | null;
  readonly releaseError: string | null;
  readonly deployment: {
    readonly runtime: UpgradeConfig['runtime'];
    readonly provider: UpgradeConfig['provider'];
    readonly configured: boolean;
    readonly channel: UpgradeConfig['channel'];
    /** Who applies migrations: the new image at start (`startup`) or the deploy pipeline before it (`pipeline`). */
    readonly migrationsRunner: UpgradeConfig['migrationsRunner'];
  };
  readonly migrations: MigrationStatus | null;
  /** The target release warns that its migrations need care (take a backup). */
  readonly migrationWarning: boolean;
  /** Always true: the request must carry `backupAcknowledged: true`. */
  readonly backupAcknowledgementRequired: true;
  readonly checks: readonly PreflightCheck[];
  readonly canUpgrade: boolean;
  readonly request: UpgradeRequestView | null;
}

export interface UpgradeDeps {
  readonly systemDb: Database;
  readonly config: UpgradeConfig;
  readonly currentVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}

export async function runPreflight(deps: UpgradeDeps): Promise<Preflight> {
  const now = deps.now ?? Date.now();
  const [lookup, migrations, row] = await Promise.all([
    fetchLatestRelease(deps.config.releasesUrl, deps.config.channel, deps.fetchImpl),
    readMigrationStatus(deps.systemDb),
    latestRequest(deps.systemDb),
  ]);
  const request = await reconcile(deps.systemDb, row, deps.currentVersion, now);
  const release = lookup.ok ? lookup.release : null;
  const configured = upgradeConfigured(deps.config);
  const toTarget = release ? compareVersions(release.version, deps.currentVersion) : null;
  const aboveMinimum = release ? compareVersions(deps.currentVersion, release.minimumSafeUpgradeVersion) : null;
  const inFlight = request?.status === 'requested' && !viewOf(request, now).overdue ? request : null;

  const checks: PreflightCheck[] = [
    {
      id: 'provider-configured',
      ok: configured,
      message: configured
        ? `Upgrades are requested through the ${deps.config.provider} provider.`
        : 'No upgrade hook is configured (LUMIBASE_UPGRADE_PROVIDER, LUMIBASE_UPGRADE_WEBHOOK_URL, LUMIBASE_UPGRADE_WEBHOOK_SECRET). Follow the upgrade guide instead.',
    },
    {
      id: 'release-known',
      ok: release !== null,
      message: release ? `Latest ${deps.config.channel} release: ${release.version}.` : `Could not read the release manifest (${lookup.ok ? '' : lookup.reason}).`,
    },
    {
      id: 'current-version-known',
      ok: compareVersions(deps.currentVersion, deps.currentVersion) !== null,
      message: `This deployment reports version ${deps.currentVersion}.`,
    },
    {
      id: 'newer-version',
      ok: toTarget !== null && toTarget > 0,
      message: toTarget !== null && toTarget > 0 ? `${release?.version} is newer.` : 'Already on the latest release.',
    },
    {
      id: 'minimum-safe-version',
      ok: aboveMinimum !== null && aboveMinimum >= 0,
      message:
        aboveMinimum !== null && aboveMinimum < 0
          ? `Upgrade to ${release?.minimumSafeUpgradeVersion} first; ${release?.version} cannot be reached directly from ${deps.currentVersion}.`
          : `Upgrading from ${deps.currentVersion} is supported.`,
    },
    {
      id: 'migrations-applied',
      ok: migrations !== null && migrations.pending.length === 0 && !migrations.databaseAhead,
      message:
        migrations === null
          ? 'Could not read the migration state.'
          : migrations.pending.length > 0
            ? `${migrations.pending.length} migration(s) of the running version are not applied: ${migrations.pending.join(', ')}. Finish the previous upgrade first.`
            : migrations.databaseAhead
              ? 'The database is ahead of the running code (a rollback is in progress?).'
              : 'Every migration of the running version is applied.',
    },
    {
      id: 'no-upgrade-in-flight',
      ok: inFlight === null,
      message: inFlight
        ? `An upgrade to ${inFlight.targetVersion} was requested at ${inFlight.requestedAt.toISOString()} and has not completed.`
        : 'No upgrade is in progress.',
    },
  ];

  return {
    currentVersion: deps.currentVersion,
    targetVersion: toTarget !== null && toTarget > 0 ? (release?.version ?? null) : null,
    release,
    releaseError: lookup.ok ? null : lookup.reason,
    deployment: {
      runtime: deps.config.runtime,
      provider: deps.config.provider,
      configured,
      channel: deps.config.channel,
      migrationsRunner: deps.config.migrationsRunner,
    },
    migrations,
    migrationWarning: release?.migrationWarning ?? false,
    backupAcknowledgementRequired: true,
    checks,
    canUpgrade: checks.every((check) => check.ok),
    request: request ? viewOf(request, now) : null,
  };
}

// ─── Request ─────────────────────────────────────────────────────────────────

export interface UpgradeActor {
  readonly userId: string | null;
  readonly email: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export type RequestUpgradeOutcome =
  | { ok: true; idempotent: boolean; request: UpgradeRequestView }
  | {
      ok: false;
      status: 400 | 409 | 422 | 502;
      code: string;
      message: string;
      checks?: readonly PreflightCheck[];
      request?: UpgradeRequestView;
    };

async function audit(systemDb: Database, actor: UpgradeActor, event: string, metadata: Record<string, unknown>) {
  try {
    // Instance scope (site NULL): an upgrade changes the code for every site.
    await new AuditLogger({ db: systemDb, siteId: null }).write({
      event,
      actorEmail: actor.email,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      metadata,
    });
  } catch (err) {
    console.warn('[upgrade] audit write failed', formatSafeError(err));
  }
}

/**
 * Ask the provider to upgrade to `targetVersion`. Idempotent per target: a
 * request already recorded for that version (requested or completed) is
 * returned as is and the hook is not called again. A failed request is
 * retried only with `retry: true`.
 */
export async function requestUpgrade(
  deps: UpgradeDeps,
  input: { targetVersion: string; backupAcknowledged: boolean; retry: boolean },
  actor: UpgradeActor,
): Promise<RequestUpgradeOutcome> {
  const now = deps.now ?? Date.now();
  if (!input.backupAcknowledged) {
    return {
      ok: false,
      status: 422,
      code: 'BACKUP_NOT_ACKNOWLEDGED',
      message: 'Confirm that a current database backup exists (backupAcknowledged: true).',
    };
  }

  const [existing] = await deps.systemDb
    .select()
    .from(upgradeRequests)
    .where(eq(upgradeRequests.targetVersion, input.targetVersion))
    .limit(1);
  const reconciled = existing ? ((await reconcile(deps.systemDb, existing, deps.currentVersion, now)) ?? existing) : null;
  // A stuck request (no answer after OVERDUE_AFTER_MS) may be retried like a failed one.
  const retriable =
    reconciled !== null && (reconciled.status === 'failed' || (input.retry && viewOf(reconciled, now).overdue));
  if (reconciled && !retriable) {
    return { ok: true, idempotent: true, request: viewOf(reconciled, now) };
  }
  if (reconciled && !input.retry) {
    return {
      ok: false,
      status: 409,
      code: 'PREVIOUS_ATTEMPT_FAILED',
      message: `The previous request for ${input.targetVersion} failed (${reconciled.error ?? 'unknown'}). Send retry: true to try again.`,
      request: viewOf(reconciled, now),
    };
  }

  const preflight = await runPreflight(deps);
  // The request being retried is not "another upgrade in flight".
  const checks = preflight.checks.map((check) =>
    check.id === 'no-upgrade-in-flight' && reconciled && preflight.request?.id === reconciled.id
      ? { ...check, ok: true }
      : check,
  );
  if (preflight.targetVersion !== input.targetVersion) {
    return {
      ok: false,
      status: 409,
      code: 'TARGET_MISMATCH',
      message: preflight.targetVersion
        ? `The upgrade target is ${preflight.targetVersion}, not ${input.targetVersion}.`
        : 'There is no newer release to upgrade to.',
      checks,
    };
  }
  if (!checks.every((check) => check.ok)) {
    return {
      ok: false,
      status: 409,
      code: 'PREFLIGHT_FAILED',
      message: 'The upgrade preflight did not pass.',
      checks,
    };
  }

  const provider = getUpgradeProvider(deps.config.provider);
  if (!provider) {
    return { ok: false, status: 409, code: 'PROVIDER_UNAVAILABLE', message: 'No upgrade provider is available.' };
  }

  // Claim the target first: a concurrent request for the same version finds
  // this row and returns it instead of firing the hook a second time.
  let row: UpgradeRequestRow | undefined;
  if (reconciled) {
    [row] = await deps.systemDb
      .update(upgradeRequests)
      .set({
        status: 'requested',
        fromVersion: deps.currentVersion,
        requestedBy: actor.userId,
        requestedAt: new Date(now),
        error: null,
        hookStatus: null,
        hookReference: null,
        completedAt: null,
        attempts: sql`${upgradeRequests.attempts} + 1`,
      })
      .where(and(eq(upgradeRequests.id, reconciled.id), eq(upgradeRequests.status, reconciled.status)))
      .returning();
  } else {
    [row] = await deps.systemDb
      .insert(upgradeRequests)
      .values({
        targetVersion: input.targetVersion,
        fromVersion: deps.currentVersion,
        status: 'requested',
        provider: provider.key,
        requestedBy: actor.userId,
        requestedAt: new Date(now),
      })
      .onConflictDoNothing({ target: upgradeRequests.targetVersion })
      .returning();
  }
  if (!row) {
    const [winner] = await deps.systemDb
      .select()
      .from(upgradeRequests)
      .where(eq(upgradeRequests.targetVersion, input.targetVersion))
      .limit(1);
    if (winner) return { ok: true, idempotent: true, request: viewOf(winner, now) };
    return { ok: false, status: 409, code: 'CONFLICT', message: 'Another request changed this upgrade; try again.' };
  }

  const result = await provider.trigger(
    {
      requestId: row.id,
      fromVersion: deps.currentVersion,
      targetVersion: input.targetVersion,
      channel: deps.config.channel,
      instanceId: deps.config.instanceId,
      runtime: deps.config.runtime,
      migrationsRunner: deps.config.migrationsRunner,
      requestedAt: new Date(now).toISOString(),
    },
    deps.config,
    deps.fetchImpl,
  );

  const [stored] = await deps.systemDb
    .update(upgradeRequests)
    .set(
      result.ok
        ? { hookStatus: result.status, hookReference: result.reference }
        : { status: 'failed', hookStatus: result.status, error: result.error },
    )
    .where(eq(upgradeRequests.id, row.id))
    .returning();
  const view = viewOf(stored ?? row, now);

  await audit(deps.systemDb, actor, result.ok ? 'system.upgrade_requested' : 'system.upgrade_request_failed', {
    requestId: row.id,
    fromVersion: deps.currentVersion,
    targetVersion: input.targetVersion,
    provider: provider.key,
    attempt: row.attempts,
    hookStatus: result.status,
    ...(result.ok ? { hookReference: result.reference } : { error: result.error }),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      code: 'UPGRADE_HOOK_FAILED',
      message: `The upgrade hook did not accept the request (${result.error}).`,
      request: view,
    };
  }
  return { ok: true, idempotent: false, request: view };
}

/** The latest request, completed when the running version has reached it. */
export async function upgradeStatus(deps: UpgradeDeps): Promise<UpgradeRequestView | null> {
  const now = deps.now ?? Date.now();
  const row = await reconcile(deps.systemDb, await latestRequest(deps.systemDb), deps.currentVersion, now);
  return row ? viewOf(row, now) : null;
}
