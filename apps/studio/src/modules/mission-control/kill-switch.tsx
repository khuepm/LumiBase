import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonX } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * Kill switch UI (content-os task 18.3; Req 16.6): four escalating scopes.
 * Freezing a role or the whole site is a two-step confirm — type the scope
 * name to arm the button. Lifting is immediate (restoring safety is cheap).
 */

const SCOPES = [
  { id: 'run', label: 'Cancel run', needsTarget: true, confirm: false, hint: 'Stops one run at the next tool-call boundary.' },
  { id: 'intent', label: 'Pause intent', needsTarget: true, confirm: false, hint: 'The reconciler stops generating goals for it.' },
  { id: 'role', label: 'Freeze role', needsTarget: true, confirm: true, hint: 'Blocks every tool call of one agent role.' },
  { id: 'site', label: 'Freeze site', needsTarget: false, confirm: true, hint: 'Stops ALL agent activity. Reads keep working.' },
] as const;

export function KillSwitchPanel() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('run');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stateQuery = useQuery({ queryKey: ['mc-kill-switch'], queryFn: missionControlApi.killSwitch });

  const activateMutation = useMutation({
    mutationFn: () =>
      missionControlApi.activateKillSwitch(scope, targetId.trim() || undefined, reason.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] });
      setConfirmText('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const liftMutation = useMutation({
    mutationFn: ({ liftScope, target }: { liftScope: 'role' | 'site'; target?: string }) =>
      missionControlApi.liftKillSwitch(liftScope, target),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] }),
    onError: (err: Error) => setError(err.message),
  });

  const selected = SCOPES.find((s) => s.id === scope)!;
  // Two-step confirm for freezes: the user must type the scope id to arm.
  const armed = !selected.confirm || confirmText.trim().toLowerCase() === selected.id;
  const active = stateQuery.data?.active ?? [];

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
      )}

      <section className="rounded-lg border border-destructive/30 p-4">
        <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-destructive">
          <OctagonX className="h-4 w-4" /> Stop agent activity
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setScope(s.id);
                setConfirmText('');
              }}
              className={cn(
                'rounded-md border px-2 py-2 text-xs',
                scope === s.id ? 'border-destructive bg-destructive/10 font-medium' : 'hover:bg-muted',
              )}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{selected.hint}</p>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {selected.needsTarget && (
            <label className="block text-xs font-medium text-muted-foreground">
              Target {scope === 'run' ? 'run id' : scope === 'intent' ? 'intent id' : 'role name'}
              <input
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
              />
            </label>
          )}
          <label className="block text-xs font-medium text-muted-foreground">
            Reason (audited)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
            />
          </label>
        </div>

        {selected.confirm && (
          <label className="mt-3 block text-xs font-medium text-destructive">
            Step 2 — type <code className="rounded bg-destructive/10 px-1">{selected.id}</code> to confirm the freeze
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded-md border border-destructive/40 bg-background px-2 py-2 text-sm"
            />
          </label>
        )}

        <button
          type="button"
          onClick={() => activateMutation.mutate()}
          disabled={!armed || activateMutation.isPending || (selected.needsTarget && !targetId.trim())}
          className="mt-3 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
        >
          {activateMutation.isPending ? 'Stopping…' : selected.label}
        </button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Active freezes</h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is frozen.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((freeze) => (
              <li
                key={freeze.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  <strong>{freeze.scope}</strong>
                  {freeze.targetRole ? ` · ${freeze.targetRole}` : ''}
                  {freeze.reason && <span className="ml-2 text-xs text-muted-foreground">{freeze.reason}</span>}
                  <span className="ml-2 text-xs text-muted-foreground">
                    since {new Date(freeze.createdAt).toLocaleString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    liftMutation.mutate({
                      liftScope: freeze.scope as 'role' | 'site',
                      target: freeze.targetRole ?? undefined,
                    })
                  }
                  disabled={liftMutation.isPending}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  Lift
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
