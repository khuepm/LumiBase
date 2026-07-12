/**
 * Settings → Change Feed (spec cdc-extension-integration, Req 8.1, 8.3).
 *
 * Minimal v1 panel: subscription list (status/kind/lag/lastDeliveredAt),
 * recent deliveries per subscription, and pause / resume / replay /
 * dispatch-now actions — destructive/rewinding actions confirm first.
 * The feed routes are not part of the typed SDK yet, so calls go through
 * `rawRequest` (the CDC control-plane panel convention).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rss, Pause, Play, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

const BASE = '/api/v1/cdc';

export interface ChangeFeedSubscription {
  id: string;
  name: string;
  kind: 'pull' | 'webhook' | 'extension';
  status: 'active' | 'paused' | 'dead' | 'stale';
  collections: string[];
  operations: string[];
  payloadMode: string;
  cursor: string | null;
  lastDeliveredAt: string | null;
  consecutiveFailures: number;
  lag: { events: number; behindMs: number | null };
}

export interface ChangeFeedDelivery {
  id: string;
  attempt: number;
  status: 'success' | 'failed';
  httpStatus: number | null;
  errorMessage: string | null;
  eventCount: number;
  durationMs: number;
  createdAt: string;
}

async function listSubscriptions(): Promise<ChangeFeedSubscription[]> {
  const res = await getApiClient().rawRequest<ChangeFeedSubscription[]>(
    `${BASE}/subscriptions`,
  );
  return res.data;
}

async function listDeliveries(id: string): Promise<ChangeFeedDelivery[]> {
  const res = await getApiClient().rawRequest<ChangeFeedDelivery[]>(
    `${BASE}/subscriptions/${encodeURIComponent(id)}/deliveries?limit=20`,
  );
  return res.data;
}

function post(path: string, body?: unknown) {
  return getApiClient().rawRequest(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patch(path: string, body: unknown) {
  return getApiClient().rawRequest(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const STATUS_STYLE: Record<ChangeFeedSubscription['status'], string> = {
  active: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-amber-100 text-amber-700',
  dead: 'bg-red-100 text-red-700',
  stale: 'bg-orange-100 text-orange-700',
};

export function formatLag(lag: ChangeFeedSubscription['lag']): string {
  if (lag.events === 0) return 'caught up';
  const time =
    lag.behindMs === null
      ? ''
      : lag.behindMs > 60_000
        ? ` (~${Math.round(lag.behindMs / 60_000)}m behind)`
        : ` (~${Math.round(lag.behindMs / 1000)}s behind)`;
  return `${lag.events} events${time}`;
}

export function ChangeFeedPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const subsQuery = useQuery({
    queryKey: ['cdc-feed-subscriptions'],
    queryFn: listSubscriptions,
    refetchInterval: 10_000,
  });
  const deliveriesQuery = useQuery({
    queryKey: ['cdc-feed-deliveries', expanded],
    queryFn: () => listDeliveries(expanded!),
    enabled: expanded !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cdc-feed-subscriptions'] });
  const pauseResume = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) =>
      patch(`/subscriptions/${encodeURIComponent(id)}`, { status }),
    onSuccess: invalidate,
  });
  const replay = useMutation({
    mutationFn: ({ id, occurredAfter }: { id: string; occurredAfter: string }) =>
      post(`/subscriptions/${encodeURIComponent(id)}/replay`, { occurred_after: occurredAfter }),
    onSuccess: invalidate,
  });
  const dispatchNow = useMutation({
    mutationFn: (id: string) => post(`/subscriptions/${encodeURIComponent(id)}/dispatch`),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      getApiClient().rawRequest(`${BASE}/subscriptions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });

  const subs = subsQuery.data ?? [];

  const onReplay = (sub: ChangeFeedSubscription) => {
    const iso = window.prompt(
      `Replay "${sub.name}" from (ISO timestamp, within retention):`,
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    if (!iso) return;
    if (
      window.confirm(
        `Rewind "${sub.name}" to ${iso}? Events after that point will be delivered again (at-least-once).`,
      )
    ) {
      replay.mutate({ id: sub.id, occurredAfter: iso });
    }
  };

  const onDelete = (sub: ChangeFeedSubscription) => {
    if (
      window.confirm(
        `Delete subscription "${sub.name}"? Its checkpoint is lost; outbox events are kept until retention.`,
      )
    ) {
      remove.mutate(sub.id);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Change Feed</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Consumers of the content change feed — pull clients, signed webhooks, and extension
          sink connectors.
        </p>
      </header>

      <div className="grid gap-4">
        {subsQuery.isLoading && <div className="text-muted-foreground">Loading...</div>}
        {subs.length === 0 && !subsQuery.isLoading && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            No change-feed subscriptions yet.
          </div>
        )}
        {subs.map((sub) => (
          <div key={sub.id} className="rounded-lg border bg-background p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                  <Rss className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{sub.name}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{sub.kind}</span>
                    <span
                      data-testid={`status-${sub.id}`}
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[sub.status]}`}
                    >
                      {sub.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Lag: {formatLag(sub.lag)}
                    {sub.lastDeliveredAt
                      ? ` · last delivered ${new Date(sub.lastDeliveredAt).toLocaleString()}`
                      : ' · never delivered'}
                    {sub.consecutiveFailures > 0
                      ? ` · ${sub.consecutiveFailures} consecutive failures`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {sub.status === 'active' && (
                  <button
                    type="button"
                    title="Pause"
                    aria-label={`Pause ${sub.name}`}
                    onClick={() => pauseResume.mutate({ id: sub.id, status: 'paused' })}
                    className="rounded-md p-2 hover:bg-muted"
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                )}
                {sub.status === 'paused' && (
                  <button
                    type="button"
                    title="Resume"
                    aria-label={`Resume ${sub.name}`}
                    onClick={() => pauseResume.mutate({ id: sub.id, status: 'active' })}
                    className="rounded-md p-2 hover:bg-muted"
                  >
                    <Play className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  title="Replay"
                  aria-label={`Replay ${sub.name}`}
                  onClick={() => onReplay(sub)}
                  className="rounded-md p-2 hover:bg-muted"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                {sub.kind !== 'pull' && (
                  <button
                    type="button"
                    title="Dispatch now"
                    aria-label={`Dispatch ${sub.name} now`}
                    onClick={() => dispatchNow.mutate(sub.id)}
                    className="rounded-md p-2 hover:bg-muted"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  title="Delete"
                  aria-label={`Delete ${sub.name}`}
                  onClick={() => onDelete(sub)}
                  className="rounded-md p-2 text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === sub.id ? null : sub.id)}
                  className="ml-2 rounded-md border px-2 py-1 text-xs"
                >
                  {expanded === sub.id ? 'Hide deliveries' : 'Deliveries'}
                </button>
              </div>
            </div>

            {expanded === sub.id && (
              <div className="mt-4 border-t pt-3">
                {deliveriesQuery.isLoading && (
                  <div className="text-sm text-muted-foreground">Loading deliveries…</div>
                )}
                {(deliveriesQuery.data ?? []).length === 0 && !deliveriesQuery.isLoading && (
                  <div className="text-sm text-muted-foreground">No deliveries yet.</div>
                )}
                <ul className="space-y-1 text-sm">
                  {(deliveriesQuery.data ?? []).map((d) => (
                    <li key={d.id} className="flex items-center gap-3">
                      <span
                        className={
                          d.status === 'success' ? 'text-emerald-600' : 'text-red-600'
                        }
                      >
                        {d.status}
                      </span>
                      <span className="text-muted-foreground">
                        attempt {d.attempt} · {d.eventCount} events · {d.durationMs}ms
                        {d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}
                        {d.errorMessage ? ` · ${d.errorMessage}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
