import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  missionControlApi,
  type AgentApproval,
  type AgentIncident,
  type ContentIntent,
  type StagedVeto,
} from './api';

/**
 * Single source for the exception inbox (content-os-ui task 1; Req 3.5, 2.1,
 * 6.1). One queue for everything that needs a human: veto countdowns first
 * (hard deadline), then pending approvals, open incidents, errored intents.
 * The dashboard, the inbox page and the AppShell badge all read from here so
 * the four underlying queries are shared through the React Query cache.
 */

export type InboxEntry =
  | { kind: 'veto'; id: string; urgency: number; veto: StagedVeto }
  | { kind: 'approval'; id: string; urgency: number; approval: AgentApproval }
  | { kind: 'incident'; id: string; urgency: number; incident: AgentIncident }
  | { kind: 'intent_error'; id: string; urgency: number; intent: ContentIntent };

export interface InboxCounts {
  total: number;
  approvals: number;
  staged: number;
  incidents: number;
  intentErrors: number;
  /** Soonest staged auto-commit deadline, or null when nothing is staged. */
  nearestAutoCommitAt: string | null;
}

/** Stable id used for deep-links (?entry=) and React keys. */
export function entryId(kind: InboxEntry['kind'], sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/**
 * Entries not yet in the seen set — the notification trigger (Req 14.1/14.5).
 * Pure so the poll-diff is unit-testable without timers or sockets.
 */
export function diffNewEntries(seen: ReadonlySet<string>, entries: InboxEntry[]): InboxEntry[] {
  return entries.filter((e) => !seen.has(e.id));
}

/** One-line human label per exception kind (Req 14.2). */
export function entryLabel(entry: InboxEntry): string {
  switch (entry.kind) {
    case 'veto':
      return `Staged change on ${String(entry.veto.collection ?? '?')}/${String(entry.veto.itemId ?? '?')} — veto window open`;
    case 'approval':
      return `Approval requested: ${entry.approval.subjectType} by ${entry.approval.requestedByAgent}`;
    case 'incident':
      return `Incident (${entry.incident.severity}): ${entry.incident.source} — ${entry.incident.agentRole}`;
    case 'intent_error':
      return `Intent "${entry.intent.name}" entered error`;
  }
}

export function buildEntries(
  approvals: AgentApproval[],
  staged: StagedVeto[],
  incidents: AgentIncident[],
  intents: ContentIntent[],
  now: number = Date.now(),
): InboxEntry[] {
  const entries: InboxEntry[] = [
    // Veto windows: urgency = time to auto-commit (sooner = more urgent).
    ...staged.map((veto): InboxEntry => ({
      kind: 'veto',
      id: entryId('veto', String(veto.approvalId ?? veto.id)),
      urgency: new Date(veto.autoCommitAt).getTime() - now,
      veto,
    })),
    ...approvals
      .filter((a) => a.status === 'pending' && a.kind !== 'veto')
      .map((approval): InboxEntry => ({
        kind: 'approval',
        id: entryId('approval', approval.id),
        urgency: 1_000_000_000 + (now - new Date(approval.createdAt).getTime()) * -1,
        approval,
      })),
    ...incidents.map((incident): InboxEntry => ({
      kind: 'incident',
      id: entryId('incident', incident.id),
      urgency: incident.severity === 'high' ? 500_000_000 : 1_500_000_000,
      incident,
    })),
    ...intents
      .filter((i) => i.status === 'error')
      .map((intent): InboxEntry => ({
        kind: 'intent_error',
        id: entryId('intent_error', intent.id),
        urgency: 1_200_000_000,
        intent,
      })),
  ];
  return entries.sort((a, b) => a.urgency - b.urgency);
}

export function buildCounts(entries: InboxEntry[]): InboxCounts {
  const staged = entries.filter((e) => e.kind === 'veto');
  const nearest = staged
    .map((e) => (e.kind === 'veto' ? e.veto.autoCommitAt : ''))
    .filter(Boolean)
    .sort()[0];
  return {
    total: entries.length,
    approvals: entries.filter((e) => e.kind === 'approval').length,
    staged: staged.length,
    incidents: entries.filter((e) => e.kind === 'incident').length,
    intentErrors: entries.filter((e) => e.kind === 'intent_error').length,
    nearestAutoCommitAt: nearest ?? null,
  };
}

export function useInboxData() {
  const approvalsQuery = useQuery({
    queryKey: ['mc-approvals'],
    queryFn: missionControlApi.approvals,
    refetchInterval: 60_000,
    retry: false,
  });
  const stagedQuery = useQuery({
    queryKey: ['mc-staged'],
    queryFn: missionControlApi.staged,
    refetchInterval: 60_000,
    retry: false,
  });
  const autonomyQuery = useQuery({
    queryKey: ['mc-autonomy'],
    queryFn: missionControlApi.autonomy,
    refetchInterval: 60_000,
    retry: false,
  });
  const intentsQuery = useQuery({
    queryKey: ['mc-intents'],
    queryFn: missionControlApi.intents,
    refetchInterval: 60_000,
    retry: false,
  });

  const approvals = approvalsQuery.data;
  const staged = stagedQuery.data;
  const incidents = autonomyQuery.data?.openIncidents;
  const intents = intentsQuery.data;

  const entries = useMemo(
    () => buildEntries(approvals ?? [], staged ?? [], incidents ?? [], intents ?? []),
    [approvals, staged, incidents, intents],
  );
  const counts = useMemo(() => buildCounts(entries), [entries]);

  return {
    entries,
    counts,
    intents: intents ?? [],
    isLoading: approvalsQuery.isLoading || stagedQuery.isLoading,
    /** True once every source either loaded or failed — gates the badge. */
    isError:
      approvalsQuery.isError && stagedQuery.isError && autonomyQuery.isError && intentsQuery.isError,
  };
}
