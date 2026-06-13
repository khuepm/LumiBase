import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi, type ContentOsFlags } from './api';

/**
 * Content OS rollout switchboard (content-os-ui task 15; Req 15).
 *
 * The four per-site flags gate every autonomous subsystem (content-os task
 * 20.1), but until this panel the only way to flip one was a hand-crafted
 * `POST /api/v1/settings` call. Enabling arms autonomous behavior, so
 * OFF→ON takes a two-step confirm — the same philosophy as the kill-switch
 * freeze confirm — while ON→OFF, like every stop control in Mission
 * Control, applies on the first click.
 *
 * Saves merge the flags over the existing row value: the `contentOs` row
 * also carries non-flag keys (e.g. `agentReviewMinConfidence`) that must
 * survive a toggle.
 */

const FLAG_ROWS: Array<{
  key: keyof ContentOsFlags;
  label: string;
  description: string;
}> = [
  {
    key: 'reconciler',
    label: 'Reconciler',
    description: 'Drift scans raise goals; agents converge content toward intents.',
  },
  {
    key: 'vetoWindow',
    label: 'Veto window',
    description: 'L3 dangerous writes stage with a countdown humans can veto.',
  },
  {
    key: 'agentReview',
    label: 'Agent review',
    description: 'Reviewer agents decide low-risk approvals below the site threshold.',
  },
  {
    key: 'mcp',
    label: 'MCP endpoint',
    description: 'External agents may call /api/v1/mcp with capability tokens.',
  },
];

export function RolloutFlagsPanel() {
  const queryClient = useQueryClient();
  const [arming, setArming] = useState<keyof ContentOsFlags | null>(null);

  const query = useQuery({
    queryKey: ['mc-content-os-flags'],
    queryFn: missionControlApi.contentOsFlags,
  });

  const mutation = useMutation({
    mutationFn: (next: ContentOsFlags) =>
      missionControlApi.saveContentOsFlags({ ...(query.data?.raw ?? {}), ...next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-content-os-flags'] });
    },
    onSettled: () => setArming(null),
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading rollout flags…</p>;
  }
  if (query.isError || !query.data) {
    return <p className="text-sm text-destructive">Failed to load rollout flags.</p>;
  }

  const flags = query.data.flags;
  const allOff = FLAG_ROWS.every(({ key }) => !flags[key]);

  const apply = (key: keyof ContentOsFlags, value: boolean) =>
    mutation.mutate({ ...flags, [key]: value });

  return (
    <div className="space-y-2">
      {FLAG_ROWS.map(({ key, label, description }) => {
        const on = flags[key];
        const isArming = arming === key && !on;
        return (
          <div
            key={key}
            className="flex items-start justify-between gap-3 rounded-md border p-2.5"
          >
            <div>
              <p className="text-sm font-medium leading-tight">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {isArming ? (
                <>
                  <button
                    type="button"
                    onClick={() => setArming(null)}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => apply(key, true)}
                    disabled={mutation.isPending}
                    className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Confirm enable
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={label}
                  onClick={() => (on ? apply(key, false) : setArming(key))}
                  disabled={mutation.isPending}
                  className={cn(
                    'relative h-5 w-9 rounded-full transition-colors disabled:opacity-50',
                    on ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all',
                      on ? 'left-[18px]' : 'left-0.5',
                    )}
                  />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {allOff && (
        <p className="text-xs text-muted-foreground">
          Every subsystem is off — the site behaves exactly like the pre-Content-OS baseline.
        </p>
      )}
      {mutation.isError && (
        <p className="text-xs text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : 'Saving failed.'}
        </p>
      )}
    </div>
  );
}
