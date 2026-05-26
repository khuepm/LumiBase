import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { getActiveToken, getActiveSite } from '@/lib/api';

interface ApprovalRecord {
  id: string;
  siteId: string;
  agentName: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: string;
  context: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

async function fetchApprovals(): Promise<ApprovalRecord[]> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch('/api/v1/ai/approvals', {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch approvals: ${res.status}`);
  }
  const body = (await res.json()) as { data: ApprovalRecord[] };
  return body.data;
}

async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/ai/approvals/${id}/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
    },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    throw new Error(`Failed to ${decision === 'approved' ? 'approve' : 'reject'} action: ${res.status}`);
  }
}


const MAX_DISPLAY_CARDS = 50;

export function AIApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchApprovals();
      setApprovals(data.slice(0, MAX_DISPLAY_CARDS));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  const handleDecision = async (id: string, decision: 'approved' | 'rejected') => {
    setProcessingIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      await decideApproval(id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">AI Approvals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review and decide on pending AI actions that require human approval.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {approvals.length === 0 && !error && (
        <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
          No pending approvals.
        </div>
      )}

      <div className="grid gap-4">
        {approvals.map((approval) => {
          const isProcessing = processingIds.has(approval.id);
          return (
            <div
              key={approval.id}
              className="rounded-lg border bg-background p-4 shadow-sm"
            >
              <div className="mb-3">
                <h3 className="font-semibold text-base">{approval.skillName}</h3>
                {approval.context && (
                  <p className="mt-1 text-sm text-muted-foreground">{approval.context}</p>
                )}
              </div>

              <pre className="mb-4 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(approval.arguments, null, 2)}
              </pre>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void handleDecision(approval.id, 'approved')}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {isProcessing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="h-4 w-4" />
                  )}
                  Approve
                </button>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void handleDecision(approval.id, 'rejected')}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {isProcessing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
