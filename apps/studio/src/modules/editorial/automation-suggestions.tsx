import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Jev automation suggestions in the review queue (J11, #518).
 *
 * Lists the automation actions recorded for a collection: shadow suggestions
 * (nothing written) and live proposals (waiting for, or decided by, an
 * approval). A reviewer accepts, overrides (edit to another value) or rejects
 * the decision behind a suggestion; the verdict is stored as review feedback
 * on that decision, which is what the shadow metrics are computed from.
 *
 * Nothing here applies a suggestion: accepting a shadow suggestion records
 * agreement only. Live writes go through approvals in Mission Control.
 *
 * The automation API is control-plane (admin only). A non-admin sees a
 * short note instead of the list.
 */

export interface AutomationActionView {
  id: string;
  action: 'tag' | 'route';
  mode: 'shadow' | 'live';
  status: string;
  reason: string | null;
  itemId: string;
  questionKey: string | null;
  confidence: number | null;
  inZone: boolean;
  proposed: { field: string; value: unknown; target?: string; transition?: string | null } | null;
  approvalId: string | null;
  chain: {
    reviewRunId: string | null;
    revisionId: string | null;
    feedback: Array<{ verdict: string; editedValue: unknown; principalId: string }>;
  };
}

type Verdict = 'accept' | 'edit' | 'reject';

function errorCode(err: unknown): string | null {
  return err instanceof LumiError ? ((err.body as { errors?: Array<{ code?: string }> })?.errors?.[0]?.code ?? null) : null;
}

function statusLabel(row: AutomationActionView): string {
  if (row.mode === 'shadow') return row.status === 'recorded' ? 'Shadow suggestion' : `Shadow · ${row.status}`;
  if (row.status === 'pending_approval') return 'Live · awaiting approval';
  return `Live · ${row.status}`;
}

function SuggestionRow({ row, collection }: { row: AutomationActionView; collection: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [override, setOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const send = useMutation({
    mutationFn: async (vars: { verdict: Verdict; acknowledgeStale?: boolean }) => {
      await client.rawRequest(`/api/v1/ai/automation/actions/${row.id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: vars.verdict,
          ...(vars.verdict === 'edit' ? { editedValue: override.trim() } : {}),
          ...(vars.acknowledgeStale ? { acknowledgeStale: true } : {}),
        }),
      });
    },
    onSuccess: () => {
      setError(null);
      setStale(false);
      void queryClient.invalidateQueries({ queryKey: ['automation-actions', collection] });
    },
    onError: (err) => {
      if (errorCode(err) === 'REVIEW_STALE') {
        setStale(true);
        setError('The item changed since this decision. Record your verdict anyway, or re-run the flow.');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not record the verdict.');
    },
  });

  const given = row.chain.feedback[0];
  const canGive = Boolean(row.chain.reviewRunId && row.questionKey) && !given;
  const target = row.proposed?.target ?? (row.proposed ? JSON.stringify(row.proposed.value) : '—');
  const lastVerdict = send.variables?.verdict;

  return (
    <li data-testid={`automation-${row.id}`} style={{ borderBottom: '1px solid #eee', padding: '12px 0' }}>
      <div>
        <strong>Item:</strong> {row.itemId} · <strong>{row.action === 'tag' ? 'Tag' : 'Queue'}:</strong> {target}
        {row.proposed?.transition ? ` · then ${row.proposed.transition}` : ''}
      </div>
      <div style={{ fontSize: 12, color: '#555' }}>
        {statusLabel(row)}
        {row.reason ? ` (${row.reason})` : ''}
        {row.confidence !== null ? ` · confidence ${row.confidence.toFixed(2)}` : ''}
        {row.inZone ? ' · in auto-action zone' : ''}
      </div>
      {given ? (
        <p style={{ fontSize: 12 }}>Verdict recorded: {given.verdict}</p>
      ) : canGive ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button type="button" disabled={send.isPending} onClick={() => send.mutate({ verdict: 'accept' })}>
            Accept
          </button>
          <input
            aria-label={`Override value for ${row.itemId}`}
            placeholder={row.action === 'tag' ? 'Correct tag' : 'Correct queue'}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
          <button
            type="button"
            disabled={send.isPending || override.trim().length === 0}
            onClick={() => send.mutate({ verdict: 'edit' })}
          >
            Override
          </button>
          <button type="button" disabled={send.isPending} onClick={() => send.mutate({ verdict: 'reject' })}>
            Reject
          </button>
        </div>
      ) : (
        <p style={{ fontSize: 12 }}>No decision to give feedback on.</p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 12, color: '#b91c1c' }}>
          {error}{' '}
          {stale && lastVerdict && (
            <button type="button" onClick={() => send.mutate({ verdict: lastVerdict, acknowledgeStale: true })}>
              Record anyway
            </button>
          )}
        </p>
      )}
    </li>
  );
}

export function AutomationSuggestions({ collection }: { collection: string }) {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['automation-actions', collection],
    queryFn: async () => {
      const res = await client.rawRequest<AutomationActionView[]>(
        `/api/v1/ai/automation/actions?collection=${encodeURIComponent(collection)}&limit=50`,
      );
      return res.data;
    },
    retry: false,
  });

  return (
    <section aria-labelledby="automation-suggestions-heading" style={{ marginTop: 24 }}>
      <h3 id="automation-suggestions-heading">Automation suggestions</h3>
      <p style={{ fontSize: 12, color: '#555' }}>
        Routed items and tag suggestions from Jev automation. Shadow suggestions change nothing; your verdict is recorded as
        feedback.
      </p>
      {query.isLoading ? (
        <p>Loading suggestions…</p>
      ) : query.isError ? (
        <p>
          {query.error instanceof LumiError && query.error.status === 403
            ? 'Automation suggestions are visible to site admins only.'
            : 'Failed to load automation suggestions.'}
        </p>
      ) : (query.data ?? []).length === 0 ? (
        <p>No automation suggestions for this collection.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(query.data ?? []).map((row) => (
            <SuggestionRow key={row.id} row={row} collection={collection} />
          ))}
        </ul>
      )}
    </section>
  );
}
