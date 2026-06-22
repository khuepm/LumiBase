import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Bot, Boxes, CheckCircle2, ClipboardCheck, Database, Loader2, Play, RefreshCw, Wrench } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';

type Tab = 'runs' | 'tools' | 'approvals' | 'artifacts' | 'memory';

interface AgentRun {
  id: string;
  goalId: string;
  agentName: string;
  status: string;
  risk: string;
  metrics: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

interface AgentTool {
  name: string;
  description: string;
  requiredCapabilities: string[];
  riskPolicy: { level: string; approvalPolicy?: string };
  enabled: boolean;
  owner: string;
}

interface AgentApproval {
  id: string;
  runId: string;
  subjectType: string;
  status: string;
  approvalPolicy: string;
  requestedByAgent: string;
  createdAt: string;
}

interface AgentArtifact {
  id: string;
  runId: string;
  type: string;
  title: string;
  status: string;
  hash: string;
  createdAt: string;
}

interface AgentMemoryContext {
  memories: Array<{ id: string; scope: string; content: string; confidence: number }>;
  recentRuns: AgentRun[];
  approvedArtifacts: AgentArtifact[];
}

async function agentRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/agent${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-Lumi-Site': site } : {}),
      ...init.headers,
      'X-Lumi-Client': 'studio',
    },
  });
  if (!res.ok) {
    throw new Error(`Agent request failed: ${res.status}`);
  }
  const body = (await res.json()) as { data: T };
  return body.data;
}

const tabs: Array<{ id: Tab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: 'runs', label: 'Runs', icon: Bot },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  { id: 'artifacts', label: 'Artifacts', icon: Boxes },
  { id: 'memory', label: 'Memory', icon: Database },
];

export function AgentHarnessPage() {
  const [tab, setTab] = useState<Tab>('runs');
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [memory, setMemory] = useState<AgentMemoryContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRuns, nextTools, nextApprovals, nextArtifacts, nextMemory] = await Promise.all([
        agentRequest<AgentRun[]>('/runs'),
        agentRequest<AgentTool[]>('/tools'),
        agentRequest<AgentApproval[]>('/approvals'),
        agentRequest<AgentArtifact[]>('/artifacts'),
        agentRequest<AgentMemoryContext>('/memory'),
      ]);
      setRuns(nextRuns);
      setTools(nextTools);
      setApprovals(nextApprovals);
      setArtifacts(nextArtifacts);
      setMemory(nextMemory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent harness');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generateDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentRequest('/generate-app', {
        method: 'POST',
        body: JSON.stringify({
          collections: ['products', 'orders', 'customers'],
          targetApp: 'storefront',
          approvalPolicy: 'before_commit',
        }),
      });
      await load();
      setTab('artifacts');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Harness</h1>
          <p className="text-sm text-muted-foreground">Goals, runs, tools, approvals, artifacts, evaluations, and memory.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void generateDemo()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Generate
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 border-b">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {entry.label}
            </button>
          );
        })}
      </div>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {loading ? (
        <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {tab === 'runs' && <RunsTable runs={runs} />}
          {tab === 'tools' && <ToolsTable tools={tools} />}
          {tab === 'approvals' && <ApprovalsTable approvals={approvals} />}
          {tab === 'artifacts' && <ArtifactsTable artifacts={artifacts} />}
          {tab === 'memory' && <MemoryPanel memory={memory} />}
        </>
      )}
    </div>
  );
}

function RunsTable({ runs }: { runs: AgentRun[] }) {
  return <DataTable columns={['Run', 'Agent', 'Status', 'Risk', 'Created']} rows={runs.map((run) => [run.id, run.agentName, run.status, run.risk, formatDate(run.createdAt)])} />;
}

function ToolsTable({ tools }: { tools: AgentTool[] }) {
  return <DataTable columns={['Tool', 'Risk', 'Enabled', 'Capabilities', 'Owner']} rows={tools.map((tool) => [
    tool.name,
    tool.riskPolicy.level,
    tool.enabled ? 'Yes' : 'No',
    tool.requiredCapabilities.join(', ') || '-',
    tool.owner,
  ])} />;
}

function ApprovalsTable({ approvals }: { approvals: AgentApproval[] }) {
  return <DataTable columns={['Approval', 'Subject', 'Status', 'Policy', 'Agent']} rows={approvals.map((approval) => [
    approval.id,
    approval.subjectType,
    approval.status,
    approval.approvalPolicy,
    approval.requestedByAgent,
  ])} />;
}

function ArtifactsTable({ artifacts }: { artifacts: AgentArtifact[] }) {
  return <DataTable columns={['Artifact', 'Type', 'Title', 'Status', 'Hash']} rows={artifacts.map((artifact) => [
    artifact.id,
    artifact.type,
    artifact.title,
    artifact.status,
    artifact.hash,
  ])} />;
}

function MemoryPanel({ memory }: { memory: AgentMemoryContext | null }) {
  if (!memory) return null;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Metric label="Memories" value={memory.memories.length} />
      <Metric label="Recent Runs" value={memory.recentRuns.length} />
      <Metric label="Approved Artifacts" value={memory.approvedArtifacts.length} />
      <div className="md:col-span-3">
        <DataTable columns={['Scope', 'Confidence', 'Content']} rows={memory.memories.map((entry) => [entry.scope, String(entry.confidence), entry.content])} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <table className="w-full table-fixed text-left text-sm">
        <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>{columns.map((column) => <th key={column} className="px-3 py-2 font-medium">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">No records.</td></tr>
          ) : rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`} className="border-b last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`} className="truncate px-3 py-2" title={cell}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
