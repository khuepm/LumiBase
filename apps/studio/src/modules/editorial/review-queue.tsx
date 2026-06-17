import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { usePermissions } from '@/lib/use-permissions';

/**
 * Editorial review queue (regulated-content-readiness task 8.5; Req 10.2-10.4).
 *
 * Lists pending Content_Reviews and exposes Approve / Reject actions wired to
 * the editorial endpoints. Action buttons are gated by the caller's `update`
 * permission on the collection; insufficient permission disables (not hides)
 * the action so the reviewer still sees the item's state (Req 10.4).
 *
 * Routing/i18n registration is the final wiring step; the component is
 * self-contained and consumes the API via the shared SDK client.
 */

interface ReviewRow {
  id: string;
  itemId: string | null;
  revisionId: string | null;
  requestedBy: string | null;
  assignedTo: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

// The collection a review belongs to is not stored on content_reviews; the
// queue is collection-scoped via this prop so actions can target the endpoint.
export interface ReviewQueueProps {
  collection: string;
}

export function ReviewQueue({ collection }: ReviewQueueProps) {
  const client = getApiClient();
  const perms = usePermissions();
  const queryClient = useQueryClient();
  const canDecide = perms.can(collection, 'update');
  const [reason, setReason] = useState('');

  const reviewsQuery = useQuery({
    queryKey: ['editorial-reviews', 'pending'],
    queryFn: async () => {
      const res = await client.rawRequest<ReviewRow[]>('/api/v1/editorial/reviews?status=pending');
      return res.data;
    },
  });

  const decide = useMutation({
    mutationFn: async (vars: { itemId: string; action: 'approve' | 'reject' }) => {
      await client.rawRequest(`/api/v1/editorial/${collection}/${vars.itemId}/${vars.action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || undefined }),
      });
    },
    onSuccess: () => {
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['editorial-reviews'] });
    },
  });

  if (reviewsQuery.isLoading) return <p>Loading review queue…</p>;
  if (reviewsQuery.isError) return <p>Failed to load reviews.</p>;

  const reviews = reviewsQuery.data ?? [];

  return (
    <section>
      <h2>Review queue</h2>
      {reviews.length === 0 ? (
        <p>No items awaiting review.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {reviews.map((r) => (
            <li key={r.id} style={{ borderBottom: '1px solid #eee', padding: '12px 0' }}>
              <div>
                <strong>Item:</strong> {r.itemId ?? '(erased)'} · <strong>By:</strong>{' '}
                {r.requestedBy ?? 'unknown'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  disabled={!canDecide || !r.itemId || decide.isPending}
                  title={canDecide ? 'Approve' : 'You lack permission to decide reviews'}
                  onClick={() => r.itemId && decide.mutate({ itemId: r.itemId, action: 'approve' })}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={!canDecide || !r.itemId || decide.isPending}
                  title={canDecide ? 'Reject' : 'You lack permission to decide reviews'}
                  onClick={() => r.itemId && decide.mutate({ itemId: r.itemId, action: 'reject' })}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <textarea
        placeholder="Optional decision reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: '100%', marginTop: 12 }}
      />
    </section>
  );
}
