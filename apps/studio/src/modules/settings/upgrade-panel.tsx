import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { useEffect, useId, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { UPGRADE_GUIDE_URL, compareVersions } from '@/lib/release-updates';

/**
 * Settings → Updates → Upgrade (#898). Preflight → confirm → progress.
 *
 * The instance cannot replace itself: the button asks the operator's
 * configured hook (CI, updater service, LumiBase control plane) to roll the
 * deployment, then watches `GET /api/v1/system/version` until the target
 * version answers. Only the bootstrap admin can see or use it (the API answers
 * 403 to anyone else, and the panel then stays hidden). Every call goes
 * through `getApiClient()` (shell contract C2, DoD §2d).
 */

export const UPGRADE_PATH = '/api/v1/system/upgrade';
export const VERSION_PATH = '/api/v1/system/version';
export const POLL_INTERVAL_MS = 10_000;

interface PreflightCheck {
  id: string;
  ok: boolean;
  message: string;
}

interface UpgradeRequestView {
  id: string;
  targetVersion: string;
  fromVersion: string;
  status: 'requested' | 'completed' | 'failed';
  requestedAt: string;
  completedAt: string | null;
  hookReference: string | null;
  error: string | null;
  attempts: number;
  overdue: boolean;
}

export interface Preflight {
  currentVersion: string;
  targetVersion: string | null;
  release: { version: string; changelogUrl: string; upgradeGuideUrl?: string; minimumSafeUpgradeVersion: string } | null;
  deployment: { runtime: string; provider: string; configured: boolean; migrationsRunner: 'startup' | 'pipeline' };
  migrations: { pending: string[]; databaseAhead: boolean } | null;
  migrationWarning: boolean;
  checks: PreflightCheck[];
  canUpgrade: boolean;
  request: UpgradeRequestView | null;
}

function errorCode(err: unknown): string | null {
  if (!(err instanceof LumiError)) return null;
  const body = err.body as { errors?: Array<{ code?: string; message?: string }> } | undefined;
  return body?.errors?.[0]?.code ?? null;
}

function errorMessage(err: unknown): string {
  if (err instanceof LumiError) {
    const body = err.body as { errors?: Array<{ message?: string }> } | undefined;
    return body?.errors?.[0]?.message ?? `Request failed (${err.status}).`;
  }
  return 'Request failed.';
}

export function UpgradePanel({ pollIntervalMs = POLL_INTERVAL_MS }: { pollIntervalMs?: number } = {}) {
  const client = getApiClient();
  const qc = useQueryClient();
  const ackId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const preflight = useQuery({
    queryKey: ['system-upgrade', 'preflight'],
    queryFn: async () => (await client.rawRequest<Preflight>(`${UPGRADE_PATH}/preflight`)).data,
    retry: false,
  });

  const request = preflight.data?.request ?? null;
  const watching = request?.status === 'requested';

  // Progress: the deployment's own version, polled while an upgrade is requested.
  const version = useQuery({
    queryKey: ['system-version'],
    queryFn: async () => (await client.rawRequest<unknown>(VERSION_PATH)) as unknown as { version: string },
    enabled: watching,
    refetchInterval: watching ? pollIntervalMs : false,
  });
  const reached =
    watching && version.data?.version && request
      ? compareVersions(version.data.version, request.targetVersion) >= 0
      : false;

  // Once the target answers (or periodically while waiting), refresh the request state.
  useEffect(() => {
    if (!watching) return undefined;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: ['system-upgrade'] }), pollIntervalMs);
    return () => clearInterval(timer);
  }, [watching, qc, pollIntervalMs]);
  useEffect(() => {
    if (reached) void qc.invalidateQueries({ queryKey: ['system-upgrade'] });
  }, [reached, qc]);

  const start = useMutation({
    mutationFn: async (input: { targetVersion: string; retry: boolean }) =>
      (
        await client.rawRequest<UpgradeRequestView>(UPGRADE_PATH, {
          method: 'POST',
          body: JSON.stringify({ ...input, backupAcknowledged: true }),
        })
      ).data,
    onSettled: async () => {
      setConfirming(false);
      setAcknowledged(false);
      await qc.invalidateQueries({ queryKey: ['system-upgrade'] });
    },
  });

  // Not the bootstrap admin: nothing to show.
  if (preflight.error instanceof LumiError && preflight.error.status === 403) return null;

  const data = preflight.data;
  const guideUrl = data?.release?.upgradeGuideUrl ?? UPGRADE_GUIDE_URL;
  const retryable = request && (request.status === 'failed' || request.overdue);

  return (
    <section aria-labelledby={`${ackId}-title`} className="rounded-xl border bg-background p-5 shadow-sm">
      <h2 id={`${ackId}-title`} className="text-lg font-semibold">
        Upgrade this deployment
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        LumiBase asks the deploy hook your operator configured to roll out the new version; this process does not
        replace itself.
      </p>

      {preflight.isLoading && <p className="mt-4 text-sm text-muted-foreground">Running preflight checks…</p>}
      {preflight.error && <p className="mt-4 text-sm text-destructive">{errorMessage(preflight.error)}</p>}

      {data && (
        <div className="mt-4 space-y-4">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <dt className="text-muted-foreground">Running</dt>
            <dd className="font-mono">{data.currentVersion}</dd>
            <dt className="text-muted-foreground">Latest release</dt>
            <dd className="font-mono">{data.release?.version ?? 'unknown'}</dd>
            <dt className="text-muted-foreground">Migrations run by</dt>
            <dd>
              {data.deployment.migrationsRunner === 'startup'
                ? 'the new version when it starts'
                : 'the deploy pipeline, before the new version starts'}
            </dd>
          </dl>

          <ul className="space-y-1 text-sm" aria-label="Preflight checks">
            {data.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2">
                <span aria-hidden="true" className={check.ok ? 'text-primary' : 'text-destructive'}>
                  {check.ok ? '✓' : '✗'}
                </span>
                <span>
                  <span className="sr-only">{check.ok ? 'Passed: ' : 'Failed: '}</span>
                  {check.message}
                </span>
              </li>
            ))}
          </ul>

          {request && <RequestStatus request={request} reached={reached} guideUrl={guideUrl} />}

          {data.canUpgrade && data.targetVersion && !confirming && (
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/95"
              onClick={() => setConfirming(true)}
            >
              Upgrade to {data.targetVersion}
            </button>
          )}
          {retryable && !data.canUpgrade && !confirming && (
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm font-semibold"
              onClick={() => setConfirming(true)}
            >
              Retry upgrade to {request.targetVersion}
            </button>
          )}

          {confirming && (
            <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              {data.migrationWarning && (
                <p className="font-medium">This release changes the database schema. Restoring a backup is the only way back.</p>
              )}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>I have a current backup of the database and know how to restore it.</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!acknowledged || start.isPending}
                  className="rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:opacity-50"
                  onClick={() =>
                    start.mutate({
                      targetVersion: (retryable && !data.canUpgrade ? request?.targetVersion : data.targetVersion) ?? '',
                      retry: Boolean(retryable),
                    })
                  }
                >
                  {start.isPending ? 'Requesting…' : 'Confirm upgrade'}
                </button>
                <button type="button" className="rounded-md border px-3 py-2" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {start.error && (
            <p className="text-sm text-destructive" role="alert">
              {errorCode(start.error) === 'UPGRADE_HOOK_FAILED'
                ? `${errorMessage(start.error)} Nothing was changed; check the hook and retry.`
                : errorMessage(start.error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RequestStatus({ request, reached, guideUrl }: { request: UpgradeRequestView; reached: boolean; guideUrl: string }) {
  if (request.status === 'completed' || reached) {
    return (
      <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm" role="status">
        Upgraded to {request.targetVersion}. Reload Studio to use the new version.
      </p>
    );
  }
  if (request.status === 'failed') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
        <p>
          The upgrade to {request.targetVersion} was not started: {request.error ?? 'the hook refused the request'}. The
          running version is unchanged.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm" role="status">
      <p>
        Upgrade to {request.targetVersion} requested{request.hookReference ? ` (${request.hookReference})` : ''}. Waiting
        for the new version to answer…
      </p>
      {request.overdue && (
        <p className="text-destructive">
          It has not answered after 30 minutes. Check the deploy pipeline; to roll back, redeploy {request.fromVersion} and
          restore the backup if migrations ran — see the{' '}
          <a className="underline" href={guideUrl} target="_blank" rel="noreferrer">
            upgrade guide
          </a>
          .
        </p>
      )}
    </div>
  );
}
