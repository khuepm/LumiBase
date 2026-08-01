import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bug, ExternalLink } from 'lucide-react';
import type { BuildMetadata } from '@lumibase/contracts';
import { getApiClient } from '@/lib/api';
import { studioBuildMetadata } from '@/lib/build-metadata';

const RELEASES_URL = 'https://github.com/khuepm/lumibase/releases';
const BUG_REPORT_URL =
  'https://github.com/khuepm/lumibase/issues/new?template=bug_report.yml';
const UNKNOWN = 'unknown';

function shortSha(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === UNKNOWN) return UNKNOWN;
  return trimmed.slice(0, 12);
}

function formatBuildTime(value: string): string {
  if (!value || value === UNKNOWN) return UNKNOWN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function shouldWarnVersionMismatch(frontendVersion: string, backendVersion?: string): boolean {
  if (!backendVersion || frontendVersion === UNKNOWN || backendVersion === UNKNOWN) return false;
  return frontendVersion !== backendVersion;
}

export function VersionInfoFooter() {
  const client = getApiClient();
  const backendVersionQuery = useQuery({
    queryKey: ['system-version'],
    queryFn: async () => {
      const response = await client.rawRequest<BuildMetadata>('/api/v1/system/version');
      return response.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const backendMetadata = backendVersionQuery.data;
  const hasVersionMismatch = shouldWarnVersionMismatch(
    studioBuildMetadata.version,
    backendMetadata?.version,
  );

  return (
    <footer
      aria-label="Build and release information"
      className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-foreground">Studio v{studioBuildMetadata.version}</span>
          <span>Git {shortSha(studioBuildMetadata.gitSha)}</span>
          <span>Built {formatBuildTime(studioBuildMetadata.buildTime)}</span>
          <span>Channel {studioBuildMetadata.releaseChannel}</span>
          <span>
            Backend{' '}
            {backendVersionQuery.isLoading
              ? 'checking…'
              : backendMetadata
                ? `v${backendMetadata.version}`
                : 'unavailable'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {hasVersionMismatch && (
            <span
              role="status"
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-800"
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Frontend/backend versions differ.
            </span>
          )}
          <span>No client-side downloads or updates are performed.</span>
          <a
            href={BUG_REPORT_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            <Bug className="h-3.5 w-3.5" aria-hidden="true" />
            Report a bug
          </a>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Release notes
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </footer>
  );
}

export const versionInfoFooterInternals = {
  formatBuildTime,
  shouldWarnVersionMismatch,
  shortSha,
};
