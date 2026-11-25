import { useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { setActiveSite } from '@/lib/api';
import { useEnvironmentMarker } from '@/modules/settings/environments-api';

/**
 * Fixed label shown on every screen while Studio works inside a Content
 * Environment (#853 task 5.5, Req 4.5): which environment, of which origin,
 * and a way back. Renders nothing on an ordinary site.
 */
export function EnvironmentBanner() {
  const marker = useEnvironmentMarker();
  const queryClient = useQueryClient();
  if (!marker) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-200"
    >
      <span className="inline-flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
        Environment <strong className="font-semibold">{marker.key || 'environment'}</strong> of site{' '}
        <code className="rounded bg-amber-500/15 px-1">{marker.originSiteId}</code>. Changes here do not reach production until promoted.
      </span>
      <button
        type="button"
        onClick={async () => {
          await queryClient.cancelQueries();
          queryClient.clear();
          setActiveSite(marker.originSiteId);
          window.location.reload();
        }}
        className="rounded border border-amber-500/40 px-2 py-0.5 font-medium hover:bg-amber-500/15"
      >
        Back to origin
      </button>
    </div>
  );
}
