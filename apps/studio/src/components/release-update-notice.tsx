import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  RELEASE_UPDATE_CHECK_INTERVAL_MS,
  UPGRADE_GUIDE_URL,
  checkReleaseManifest,
  isReleaseUpdateCheckEnabled,
  type ReleaseUpdateStatus,
} from '@/lib/release-updates';

interface ReleaseUpdateNoticeProps {
  compact?: boolean;
  initialStatus?: ReleaseUpdateStatus | null;
}

/**
 * Opt-in Studio update checker.
 *
 * This component only reads the public release manifest over an anonymous GET.
 * It does not send the active site id, token, hostname, installed extensions,
 * telemetry payloads, or any UI command that could restart services or run
 * migrations. Operators must enable the check explicitly in Settings → Updates.
 */
export function ReleaseUpdateNotice({ compact = false, initialStatus = null }: ReleaseUpdateNoticeProps) {
  const [enabled, setEnabled] = useState(() => isReleaseUpdateCheckEnabled());
  const [status, setStatus] = useState<ReleaseUpdateStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const refreshPreference = useCallback(() => {
    setEnabled(isReleaseUpdateCheckEnabled());
  }, []);

  const runCheck = useCallback(async () => {
    if (!isReleaseUpdateCheckEnabled()) {
      setStatus(null);
      setError(null);
      setEnabled(false);
      return;
    }

    setChecking(true);
    try {
      const nextStatus = await checkReleaseManifest();
      setStatus(nextStatus);
      setError(null);
      setEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read release manifest.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'lumibase.releaseUpdates.optIn') {
        refreshPreference();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refreshPreference);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refreshPreference);
    };
  }, [refreshPreference]);

  useEffect(() => {
    if (!enabled) return undefined;

    void runCheck();

    const interval = window.setInterval(() => {
      void runCheck();
    }, RELEASE_UPDATE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [enabled, runCheck]);

  if (!enabled) return null;

  if (status?.updateAvailable) {
    const upgradeGuideUrl = status.target.upgradeGuideUrl ?? UPGRADE_GUIDE_URL;

    return (
      <div
        role="status"
        className={compact
          ? 'flex max-w-xl items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 shadow-sm'
          : 'rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 shadow-sm'}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className={compact ? 'min-w-0 truncate' : 'space-y-2'}>
          <p className="font-medium">
            New version available: LumiBase {status.target.version}
          </p>
          {!compact ? (
            <p className="text-amber-900/80">
              Released {status.target.releaseDate}. This phase only notifies admins; Studio will not restart services or run migrations from the UI.
            </p>
          ) : null}
          {status.target.migrationWarning || status.belowMinimumSafeUpgradeVersion ? (
            <p className="font-medium text-amber-950">
              Review the upgrade guide before updating{status.belowMinimumSafeUpgradeVersion ? ` from versions below ${status.target.minimumSafeUpgradeVersion}` : ''}.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={upgradeGuideUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              Upgrade guide
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <a
              href={status.target.changelogUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              Changelog
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!compact && error) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        Release update checks are enabled, but Studio could not read the manifest: {error}
      </div>
    );
  }

  if (!compact) {
    return (
      <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <span>{checking ? 'Checking for LumiBase updates…' : 'No newer LumiBase release found from the public manifest.'}</span>
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={checking}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={checking ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" />
            Check now
          </button>
        </div>
      </div>
    );
  }

  return null;
}
