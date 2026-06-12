import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * Trust ledger UI (content-os task 17.2; Req 16.3): role × capability
 * matrix with earned levels, plus pending promotion proposals a human can
 * decide — promotion is never automatic.
 */

const LEVEL_LABELS = ['L0 shadow', 'L1 propose', 'L2 co-sign', 'L3 veto-window', 'L4 autopilot'];

export function TrustLedger() {
  const queryClient = useQueryClient();
  const autonomyQuery = useQuery({ queryKey: ['mc-autonomy'], queryFn: missionControlApi.autonomy });
  const promotionsQuery = useQuery({ queryKey: ['mc-promotions'], queryFn: missionControlApi.promotions });

  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      missionControlApi.decidePromotion(id, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-autonomy'] });
      queryClient.invalidateQueries({ queryKey: ['mc-promotions'] });
    },
  });

  if (autonomyQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading trust ledger…</p>;
  }
  const grants = autonomyQuery.data?.grants ?? [];
  const proposals = promotionsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Earned autonomy (role × capability)</h3>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No explicit grants — roles run at the defaults (L2 safe / L1 dangerous).
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Role</th>
                <th>Capability</th>
                <th>Level</th>
                <th>Granted</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id} className="border-b last:border-0">
                  <td className="py-2 font-medium">{grant.agentRole}</td>
                  <td>
                    <code className="rounded bg-muted px-1 text-xs">{grant.capability}</code>
                  </td>
                  <td>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs',
                        grant.level >= 3 ? 'bg-emerald-100 text-emerald-800' : 'bg-muted',
                      )}
                    >
                      {LEVEL_LABELS[grant.level] ?? `L${grant.level}`}
                    </span>
                  </td>
                  <td className="text-xs text-muted-foreground">
                    {new Date(grant.grantedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Pending promotions (human decision required)</h3>
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No promotion proposals waiting.</p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  Promotion proposal <code className="rounded bg-muted px-1 text-xs">{proposal.id}</code>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {new Date(proposal.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => decideMutation.mutate({ id: proposal.id, decision: 'approved' })}
                    disabled={decideMutation.isPending}
                    className="rounded-md border border-emerald-400 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50"
                  >
                    Approve raise
                  </button>
                  <button
                    type="button"
                    onClick={() => decideMutation.mutate({ id: proposal.id, decision: 'rejected' })}
                    disabled={decideMutation.isPending}
                    className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
