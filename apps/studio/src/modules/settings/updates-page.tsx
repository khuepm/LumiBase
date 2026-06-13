import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ReleaseUpdateNotice } from '@/components/release-update-notice';
import {
  RELEASE_MANIFEST_URL,
  checkReleaseManifest,
  getLastReleaseUpdateCheckAt,
  isReleaseUpdateCheckEnabled,
  setReleaseUpdateCheckEnabled,
  type ReleaseUpdateStatus,
} from '@/lib/release-updates';

export function UpdatesPage() {
  const [enabled, setEnabled] = useState(() => isReleaseUpdateCheckEnabled());
  const [lastCheckAt, setLastCheckAt] = useState(() => getLastReleaseUpdateCheckAt());
  const [status, setStatus] = useState<ReleaseUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setLastCheckAt(getLastReleaseUpdateCheckAt());
  }, [enabled, status]);

  const updatePreference = (nextEnabled: boolean) => {
    setReleaseUpdateCheckEnabled(nextEnabled);
    setEnabled(nextEnabled);
    if (!nextEnabled) {
      setStatus(null);
      setError(null);
    }
  };

  const runManualCheck = async () => {
    setChecking(true);
    try {
      const nextStatus = await checkReleaseManifest();
      setStatus(nextStatus);
      setLastCheckAt(getLastReleaseUpdateCheckAt());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read release manifest.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Updates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Opt in to read the public LumiBase release manifest and show admins when a new version is available.
        </p>
      </header>

      <section className="rounded-xl border bg-background p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Release manifest checks</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              When enabled, Studio periodically sends an anonymous GET request to <code className="rounded bg-muted px-1 py-0.5">{RELEASE_MANIFEST_URL}</code>.
              The manifest includes the latest stable and edge versions, release date, changelog URL, minimum safe upgrade version, and a migration-warning flag.
            </p>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Studio does not send tokens, site IDs, hostnames, extension lists, or other sensitive data. Telemetry is not part of this setting and must be opted into separately if introduced.
            </p>
          </div>

          <label className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => updatePreference(event.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            Enable update checks
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
          <button
            type="button"
            onClick={() => void runManualCheck()}
            disabled={!enabled || checking}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
            {checking ? 'Checking…' : 'Check now'}
          </button>
          <span className="text-sm text-muted-foreground">
            {lastCheckAt ? `Last checked ${new Date(lastCheckAt).toLocaleString()}` : 'No checks have run yet.'}
          </span>
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {enabled ? (
        <section aria-label="Update status">
          {status?.updateAvailable ? (
            <ReleaseUpdateNotice initialStatus={status} />
          ) : (
            <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground shadow-sm">
              {status
                ? `Current channel ${status.targetChannel}; latest manifest version is ${status.target.version}.`
                : 'Enable checks and click “Check now” to read the public release manifest.'}
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Update checks are disabled. Studio will not contact the release manifest endpoint until an admin opts in.
        </section>
      )}

      <section className="rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground">Phase-one safety guardrails</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Studio only displays “new version available” notices with upgrade-guide and changelog links.</li>
          <li>The UI cannot restart services, apply migrations, or trigger an upgrade workflow.</li>
          <li>Telemetry requires a separate opt-in and is intentionally not sent by this manifest check.</li>
        </ul>
      </section>
    </div>
  );
}
