import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle, Inbox, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { missionControlApi } from './api';
import { ExceptionInbox, invalidateInboxQueries } from './inbox';
import { MissionControlLayout, useMissionControlBase } from './layout';
import { StagedDiff } from './staged-diff';
import { useInboxData, type InboxEntry } from './use-inbox';

/**
 * Full exception inbox (content-os-ui task 4.2; Req 3.1, 3.4, 1.4):
 * the urgency-sorted list on the left keeps its inline actions, the right
 * pane shows the selected entry in full — a real field diff for staged
 * changes, decision context for the rest. Selection lives in the `entry`
 * search param so notifications can deep-link a specific exception; a
 * vanished entry degrades to a notice, never a 404 (entries are ephemeral).
 */

function useSelectedEntryId(): [string | undefined, (id: string | undefined) => void] {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const selected = (location.search as { entry?: string }).entry;
  const select = (id: string | undefined) => {
    void navigate({
      to: location.pathname as never,
      search: (id ? { entry: id } : {}) as never,
      replace: true,
    });
  };
  return [selected, select];
}

function EntryDetail({ entry }: { entry: InboxEntry }) {
  const base = useMissionControlBase();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const invalidate = () => invalidateInboxQueries(queryClient);

  const vetoMutation = useMutation({
    mutationFn: ({ approvalId, why }: { approvalId: string; why: string }) =>
      missionControlApi.veto(approvalId, why || 'Vetoed from Mission Control'),
    onSuccess: invalidate,
  });
  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      missionControlApi.decideApproval(id, decision),
    onSuccess: invalidate,
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => missionControlApi.resumeIntent(id),
    onSuccess: invalidate,
  });

  if (entry.kind === 'veto') {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Staged change</h2>
        <StagedDiff veto={entry.veto} />
        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <label className="block grow text-xs font-medium text-muted-foreground">
            Veto reason (optional, audited)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              vetoMutation.mutate({
                approvalId: String(entry.veto.approvalId ?? entry.veto.id),
                why: reason.trim(),
              })
            }
            disabled={vetoMutation.isPending}
            className="rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {vetoMutation.isPending ? 'Vetoing…' : 'Veto'}
          </button>
        </div>
      </div>
    );
  }

  if (entry.kind === 'approval') {
    return (
      <div className="space-y-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-sky-600" /> Approval pending
        </h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Subject</dt>
          <dd>
            {entry.approval.subjectType}{' '}
            <code className="rounded bg-muted px-1 text-xs">{entry.approval.subjectId}</code>
          </dd>
          <dt className="text-muted-foreground">Requested by</dt>
          <dd>{entry.approval.requestedByAgent}</dd>
          <dt className="text-muted-foreground">Run</dt>
          <dd>
            <code className="rounded bg-muted px-1 text-xs">{entry.approval.runId}</code>
          </dd>
          <dt className="text-muted-foreground">Requested at</dt>
          <dd>{new Date(entry.approval.createdAt).toLocaleString()}</dd>
        </dl>
        <div className="flex gap-2 border-t pt-3">
          <button
            type="button"
            onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'approved' })}
            disabled={decideMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            <CheckCircle className="h-4 w-4" /> Approve
          </button>
          <button
            type="button"
            onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'rejected' })}
            disabled={decideMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <XCircle className="h-4 w-4" /> Reject
          </button>
        </div>
      </div>
    );
  }

  if (entry.kind === 'incident') {
    return (
      <div className="space-y-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Incident ({entry.incident.severity})
        </h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Source</dt>
          <dd>{entry.incident.source}</dd>
          <dt className="text-muted-foreground">Agent role</dt>
          <dd>{entry.incident.agentRole}</dd>
          {entry.incident.capability && (
            <>
              <dt className="text-muted-foreground">Capability</dt>
              <dd>
                <code className="rounded bg-muted px-1 text-xs">{entry.incident.capability}</code>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Opened at</dt>
          <dd>{new Date(entry.incident.createdAt).toLocaleString()}</dd>
        </dl>
        {Object.keys(entry.incident.detail).length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-xs">
            {JSON.stringify(entry.incident.detail, null, 2)}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">
          Incidents demote the role's autonomy automatically — see the{' '}
          <Link to={`${base}/trust` as never} className="text-primary hover:underline">
            trust ledger
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 text-destructive" /> Intent in error
      </h2>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <dt className="text-muted-foreground">Intent</dt>
        <dd>
          <Link
            to={`${base}/intents/${entry.intent.id}` as never}
            className="text-primary hover:underline"
          >
            {entry.intent.name}
          </Link>
        </dd>
        <dt className="text-muted-foreground">Collection</dt>
        <dd>
          <code className="rounded bg-muted px-1 text-xs">{entry.intent.collection}</code>
        </dd>
        {entry.intent.statusReason && (
          <>
            <dt className="text-muted-foreground">Reason</dt>
            <dd>{entry.intent.statusReason}</dd>
          </>
        )}
      </dl>
      <button
        type="button"
        onClick={() => resumeMutation.mutate(entry.intent.id)}
        disabled={resumeMutation.isPending}
        className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
      >
        {resumeMutation.isPending ? 'Resuming…' : 'Resume intent'}
      </button>
    </div>
  );
}

function InboxBody() {
  const { entries, isLoading } = useInboxData();
  const [selectedId, select] = useSelectedEntryId();
  const selected = entries.find((e) => e.id === selectedId);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_3fr]">
      <div>
        <ExceptionInbox onOpenEntry={(entry) => select(entry.id)} />
      </div>
      <aside className="rounded-lg border bg-background p-4">
        {selected ? (
          <EntryDetail key={selected.id} entry={selected} />
        ) : selectedId && !isLoading ? (
          <p className="text-sm text-muted-foreground">
            This entry is gone — it was decided, committed or resolved in the meantime.
          </p>
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <Inbox className="h-5 w-5" />
            <p className="text-sm">Select an entry to see its full context.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function InboxPage() {
  return (
    <MissionControlLayout>
      <InboxBody />
    </MissionControlLayout>
  );
}
