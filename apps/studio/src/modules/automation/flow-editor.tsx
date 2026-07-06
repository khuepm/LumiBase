import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  feToCanonical,
  canonicalToFe,
  validateGraph,
  type FlowGraph,
  type FeGraph,
  type GraphError,
} from '@lumibase/shared';
import {
  Save,
  Play,
  ArrowLeft,
  Trash2,
  Settings,
  Workflow,
  Plus,
  GitBranch,
  RefreshCw,
  Globe,
  Mail,
  Terminal,
  Clock,
  Puzzle,
  Rocket,
  Radar,
  History,
  AlertTriangle,
} from 'lucide-react';
import { getActiveToken, getActiveSite } from '@/lib/api';
import { flowNodeTypes } from './flow-node-types';
import { RunHistoryPanel, type FlowRunDetail } from './run-history-panel';

/**
 * Visual flow editor (visual-flow-builder Req 4, 5, 6).
 *
 * The canvas is ReactFlow, but the persisted format is the CANONICAL runtime
 * graph (`{ entry, nodes: [{ id, key, options, next, onError }] }`): the
 * editor converts with the shared `canonicalToFe`/`feToCanonical` on
 * load/save and runs the shared `validateGraph` against the operation
 * registry before saving, so a drawn graph and an executed graph can never
 * diverge. The palette itself is loaded from `GET /flows/operations` — the
 * registry, not a hardcoded list, decides what can be placed.
 */

interface FlowDetail {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  triggerType: 'webhook' | 'event' | 'schedule' | 'manual';
  triggerOptions: Record<string, unknown> | null;
  graph: Record<string, unknown> | null;
}

interface OperationInfo {
  key: string;
  description: string;
  options?: Record<string, string>;
}

/** Presentation for known operation keys; anything else gets the generic look. */
const OP_PRESENTATION: Record<string, { label: string; icon: typeof Globe; color: string }> = {
  condition: { label: 'Condition (if)', icon: GitBranch, color: 'text-amber-500 bg-amber-500/10' },
  transform: { label: 'Transform', icon: RefreshCw, color: 'text-indigo-500 bg-indigo-500/10' },
  http: { label: 'HTTP Request', icon: Globe, color: 'text-blue-500 bg-blue-500/10' },
  mail: { label: 'Send Mail', icon: Mail, color: 'text-violet-500 bg-violet-500/10' },
  log: { label: 'Log', icon: Terminal, color: 'text-slate-500 bg-slate-500/10' },
  sleep: { label: 'Delay (Sleep)', icon: Clock, color: 'text-orange-500 bg-orange-500/10' },
  'deploy:trigger': { label: 'Trigger Deploy', icon: Rocket, color: 'text-emerald-600 bg-emerald-500/10' },
  'deploy:status': { label: 'Deploy Status', icon: Radar, color: 'text-teal-600 bg-teal-500/10' },
  'drift-scan': { label: 'Drift Scan', icon: Radar, color: 'text-cyan-600 bg-cyan-500/10' },
  'trust-promote-check': { label: 'Trust Check', icon: Puzzle, color: 'text-rose-500 bg-rose-500/10' },
};

function flowsApi(path: string, init?: RequestInit) {
  return fetch(`/api/v1/flows${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      'X-Lumi-Site': getActiveSite(),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { errors?: { message?: string }[] };
      throw new Error(body.errors?.[0]?.message ?? `Flows API error: ${r.status}`);
    }
    return r.json();
  });
}

/** Op key → ReactFlow node type: dedicated component when one exists, else generic. */
function rfTypeFor(key: string): string {
  return key in flowNodeTypes && key !== 'genericOp' ? key : 'genericOp';
}

/** Canonical (or legacy ReactFlow-shaped) stored graph → canvas state. */
function graphToCanvas(graph: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } {
  // Legacy editor saves stored raw ReactFlow `{ nodes, edges }`; keep loading them.
  if (Array.isArray(graph.edges)) {
    const legacyNodes = (graph.nodes as Node[]).map((n) => ({
      ...n,
      type: rfTypeFor(String(n.type ?? '')),
      data: { key: n.type, options: { ...(n.data as Record<string, unknown>) } },
    }));
    return { nodes: legacyNodes, edges: graph.edges as Edge[] };
  }
  const fe = canonicalToFe(graph as unknown as FlowGraph);
  const nodes: Node[] = fe.nodes.map((n) => ({
    id: n.id,
    type: rfTypeFor(String(n.data?.key ?? '')),
    position: n.position ?? { x: 0, y: 0 },
    data: { key: n.data?.key, options: n.data?.options ?? {} },
  }));
  const edges: Edge[] = fe.edges.map((e, i) => ({
    id: `edge_${e.source}_${e.target}_${i}`,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    data: { branch: e.type ?? 'next' },
    style: e.type === 'onError' ? { stroke: '#ef4444', strokeDasharray: '5,5' } : { stroke: '#6366f1' },
  }));
  return { nodes, edges };
}

/** Canvas state → canonical graph via the shared converter. */
function canvasToCanonical(nodes: Node[], edges: Edge[]): FlowGraph {
  const fe: FeGraph = {
    nodes: nodes.map((n) => ({
      id: n.id,
      data: {
        key: String((n.data as { key?: string }).key ?? n.type ?? ''),
        options: ((n.data as { options?: Record<string, unknown> }).options ?? {}) as Record<string, unknown>,
      },
      position: n.position,
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: (e.data as { branch?: 'next' | 'onError' } | undefined)?.branch === 'onError' ? 'onError' : 'next',
    })),
  };
  return feToCanonical(fe);
}

export function FlowEditor() {
  const { id } = useParams({ strict: false });
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState('New Flow');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'draft'>('draft');
  const [triggerType, setTriggerType] = useState<'webhook' | 'event' | 'schedule' | 'manual'>('manual');
  const [triggerOptions, setTriggerOptions] = useState<Record<string, unknown>>({});
  const [graphErrors, setGraphErrors] = useState<GraphError[]>([]);
  const [sidebarTab, setSidebarTab] = useState<'config' | 'runs'>('config');
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Palette + knownKeys come from the operation registry (Req 5.3).
  const operationsQuery = useQuery({
    queryKey: ['flow-operations'],
    queryFn: async () => {
      const resp = await flowsApi('/operations');
      return (resp.data as { operations: OperationInfo[] }).operations;
    },
  });
  const operations = useMemo(() => operationsQuery.data ?? [], [operationsQuery.data]);
  const knownKeys = useMemo(() => operations.map((o) => o.key), [operations]);

  const flowQuery = useQuery({
    queryKey: ['flow-detail', id],
    queryFn: async () => {
      if (isNew) return null;
      const resp = await flowsApi(`/${id}`);
      return resp.data as FlowDetail;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (flowQuery.data) {
      const flow = flowQuery.data;
      setName(flow.name);
      setDescription(flow.description ?? '');
      setStatus(flow.status);
      setTriggerType(flow.triggerType);
      setTriggerOptions(flow.triggerOptions ?? {});
      if (flow.graph) {
        const canvas = graphToCanvas(flow.graph);
        setNodes(canvas.nodes);
        setEdges(canvas.edges);
      }
    }
  }, [flowQuery.data, setNodes, setEdges]);

  // Validate on save; inline errors mark the offending nodes (Req 5.3).
  const validate = useCallback((): GraphError[] => {
    const canonical = canvasToCanonical(nodes, edges);
    const result = validateGraph(canonical, knownKeys);
    setGraphErrors(result.errors);
    return result.errors;
  }, [nodes, edges, knownKeys]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const errors = validate();
      // An active flow must be valid (the server enforces this too); drafts
      // may be saved mid-edit so work-in-progress is never lost.
      if (status === 'active' && errors.length > 0) {
        throw new Error(`Graph has ${errors.length} validation error(s) — fix them or save as draft.`);
      }
      const body = {
        name,
        description,
        status,
        triggerType,
        triggerOptions,
        graph: canvasToCanonical(nodes, edges),
      };
      const resp = isNew
        ? await flowsApi('', { method: 'POST', body: JSON.stringify(body) })
        : await flowsApi(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      return resp.data as FlowDetail;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      qc.invalidateQueries({ queryKey: ['flow-detail', id] });
      if (isNew && data?.id) {
        navigate({ to: `/automation/flows/${data.id}` });
      }
    },
  });

  const runMutation = useMutation({
    mutationFn: () => flowsApi(`/${id}/run`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      // Show the fresh run (with its per-node steps) immediately (Req 6.4).
      qc.invalidateQueries({ queryKey: ['flow-runs', id] });
      setSidebarTab('runs');
    },
  });

  const addNode = useCallback(
    (key: string) => {
      const newId = `node_${key.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
      const newNode: Node = {
        id: newId,
        type: rfTypeFor(key),
        position: { x: Math.random() * 200 + 100, y: Math.random() * 200 + 100 },
        data: { key, options: {} },
      };
      setNodes((nds) => nds.concat(newNode));
      setSelectedNodeId(newId);
    },
    [setNodes],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      const branch = params.sourceHandle === 'no' ? 'onError' : 'next';
      const edge: Edge = {
        ...params,
        id: `edge_${params.source}_${params.target}_${Date.now()}`,
        type: 'smoothstep',
        data: { branch },
        style: branch === 'onError' ? { stroke: '#ef4444', strokeDasharray: '5,5' } : { stroke: '#6366f1' },
      };
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId(null);
    },
    [setNodes, setEdges],
  );

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId) || null, [nodes, selectedNodeId]);
  const selectedKey = selectedNode ? String((selectedNode.data as { key?: string }).key ?? '') : '';
  const selectedOptions = (selectedNode?.data as { options?: Record<string, unknown> } | undefined)?.options ?? {};

  const updateOption = useCallback(
    (field: string, val: unknown) => {
      if (!selectedNodeId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  options: { ...((n.data as { options?: Record<string, unknown> }).options ?? {}), [field]: val },
                },
              }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const setTriggerOption = (field: string, val: unknown) =>
    setTriggerOptions((prev) => ({ ...prev, [field]: val }));

  // Decorate nodes with validation + selected-run state (Req 5.3, 6.3):
  // errored nodes ring red; for a selected run, executed nodes ring green
  // (last one red when the run failed) and untouched nodes dim.
  const decoratedNodes = useMemo(() => {
    const errorNodeIds = new Set(graphErrors.map((e) => e.nodeId).filter(Boolean));
    const stepIds = selectedRun ? Object.keys(selectedRun.steps ?? {}) : [];
    const lastStepId = stepIds[stepIds.length - 1];
    return nodes.map((n) => {
      let className = '';
      if (errorNodeIds.has(n.id)) className = 'rounded-xl ring-2 ring-rose-500';
      else if (selectedRun) {
        if (stepIds.includes(n.id)) {
          className =
            selectedRun.status === 'error' && n.id === lastStepId
              ? 'rounded-xl ring-2 ring-rose-500'
              : 'rounded-xl ring-2 ring-emerald-500';
        } else {
          className = 'opacity-40';
        }
      }
      return className ? { ...n, className } : n;
    });
  }, [nodes, graphErrors, selectedRun]);

  const OPTION_FIELD_HINTS = useMemo(
    () => operations.find((o) => o.key === selectedKey)?.options ?? null,
    [operations, selectedKey],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-background">
      {/* Top Toolbar */}
      <div className="flex h-14 items-center justify-between border-b px-6 bg-background/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: '/automation/flows' })}
            className="flex h-8 w-8 items-center justify-center rounded-lg border hover:bg-accent text-muted-foreground transition"
            title="Back to Flows list"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-violet-600" />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Flow name"
              className="font-semibold text-lg text-foreground bg-transparent border-b border-transparent hover:border-muted focus:border-primary px-1 outline-none transition"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'inactive' | 'draft')}
            aria-label="Flow status"
            className="rounded-lg border bg-background px-3 py-1 text-sm outline-none"
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

          {!isNew && (
            <button
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending || status !== 'active'}
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {runMutation.isPending ? 'Running...' : 'Test Run'}
            </button>
          )}

          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/95 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saveMutation.isPending ? 'Saving...' : 'Save Flow'}
          </button>
        </div>
      </div>

      {/* Validation / save error banner (Req 5.3) */}
      {(graphErrors.length > 0 || saveMutation.isError) && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-0.5">
            {saveMutation.isError && (
              <p className="font-medium">
                {saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed.'}
              </p>
            )}
            {graphErrors.map((e, i) => (
              <p key={i}>
                <span className="font-mono font-medium">{e.code}</span>
                {e.nodeId ? <span className="font-mono"> @{e.nodeId}</span> : null} — {e.message}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: settings + registry-driven palette */}
        <div className="w-64 border-r bg-muted/10 p-4 flex flex-col gap-4 overflow-y-auto">
          <div>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Flow settings</h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground">Trigger Type</label>
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as typeof triggerType)}
                  aria-label="Trigger type"
                  className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1"
                >
                  <option value="manual">Manual Trigger</option>
                  <option value="webhook">Webhook Trigger</option>
                  <option value="event">CMS Event (item.*)</option>
                  <option value="schedule">Schedule (Cron)</option>
                </select>
              </div>

              {/* Trigger-specific config (Req 1.3, 2.3, 3.2) */}
              {triggerType === 'schedule' && (
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground">Cron expression *</label>
                  <input
                    type="text"
                    value={String(triggerOptions.cron ?? '')}
                    onChange={(e) => setTriggerOption('cron', e.target.value)}
                    placeholder="*/5 * * * *"
                    aria-label="Cron expression"
                    className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1 font-mono"
                  />
                  <p className="text-[9px] text-muted-foreground mt-0.5">5-field cron (UTC). Required to activate.</p>
                </div>
              )}
              {triggerType === 'webhook' && (
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground">Webhook token *</label>
                  <input
                    type="text"
                    value={String(triggerOptions.token ?? '')}
                    onChange={(e) => setTriggerOption('token', e.target.value)}
                    placeholder="shared secret"
                    aria-label="Webhook token"
                    className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1 font-mono"
                  />
                  {!isNew && (
                    <p className="text-[9px] text-muted-foreground mt-0.5 break-all">
                      POST /api/v1/flows/{id}/trigger với header <code>x-flow-token</code>.
                    </p>
                  )}
                </div>
              )}
              {triggerType === 'event' && (
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">Collection (empty = all)</label>
                    <input
                      type="text"
                      value={String(triggerOptions.collection ?? '')}
                      onChange={(e) => setTriggerOption('collection', e.target.value || undefined)}
                      placeholder="posts"
                      aria-label="Event collection"
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">Action</label>
                    <select
                      value={String(triggerOptions.action ?? '')}
                      onChange={(e) => setTriggerOption('action', e.target.value || undefined)}
                      aria-label="Event action"
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1"
                    >
                      <option value="">All actions</option>
                      <option value="create">create</option>
                      <option value="update">update</option>
                      <option value="delete">delete</option>
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-medium text-muted-foreground">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this workflow do?"
                  rows={2}
                  aria-label="Flow description"
                  className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1 resize-none"
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Add Operations</h3>
            {operationsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading operations…</p>
            ) : (
              <div className="grid gap-2">
                {operations.map((op) => {
                  const pres = OP_PRESENTATION[op.key] ?? {
                    label: op.key,
                    icon: Puzzle,
                    color: 'text-slate-500 bg-slate-500/10',
                  };
                  const Icon = pres.icon;
                  return (
                    <button
                      key={op.key}
                      onClick={() => addNode(op.key)}
                      title={op.description}
                      className="flex items-center justify-between rounded-lg border bg-background p-2.5 hover:bg-accent text-left group transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 items-center justify-center rounded ${pres.color}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <span className="text-xs font-medium text-foreground">{pres.label}</span>
                      </div>
                      <Plus className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative bg-muted/5">
          <ReactFlow
            nodes={decoratedNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={flowNodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <MiniMap style={{ borderRadius: 8, overflow: 'hidden' }} />
            <Controls />
            <Background color="#ccc" gap={16} size={1} />
          </ReactFlow>
        </div>

        {/* Right Sidebar: node config / run history */}
        <div className="w-80 border-l bg-background p-4 overflow-y-auto flex flex-col gap-4">
          <div className="flex items-center gap-1 border-b pb-2">
            <button
              type="button"
              onClick={() => setSidebarTab('config')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                sidebarTab === 'config' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              <Settings className="h-3.5 w-3.5" /> Configure
            </button>
            {!isNew && (
              <button
                type="button"
                onClick={() => setSidebarTab('runs')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                  sidebarTab === 'runs' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <History className="h-3.5 w-3.5" /> Runs
              </button>
            )}
          </div>

          {sidebarTab === 'runs' && !isNew ? (
            <RunHistoryPanel flowId={String(id)} onRunSelected={setSelectedRun} />
          ) : selectedNode ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-bold text-foreground font-mono">{selectedKey}</h3>
                </div>
                <button
                  onClick={() => deleteNode(selectedNode.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-rose-50 text-rose-600 transition"
                  title="Delete Node"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3">
                {selectedKey === 'condition' && (
                  <>
                    <OptionInput label="Context path" hint="e.g. input.event.action" value={selectedOptions.path} onChange={(v) => updateOption('path', v)} mono />
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Operator</label>
                      <select
                        value={String(selectedOptions.operator ?? '==')}
                        onChange={(e) => updateOption('operator', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      >
                        <option value="==">==</option>
                        <option value="!=">!=</option>
                        <option value=">">&gt;</option>
                        <option value="<">&lt;</option>
                        <option value="contains">contains</option>
                      </select>
                    </div>
                    <OptionInput label="Value" value={selectedOptions.value} onChange={(v) => updateOption('value', v)} mono />
                  </>
                )}

                {selectedKey === 'transform' && (
                  <OptionJson label="Set fields (JSON object)" value={selectedOptions.set} onChange={(v) => updateOption('set', v)} />
                )}

                {selectedKey === 'http' && (
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">HTTP Method</label>
                      <select
                        value={String(selectedOptions.method ?? 'GET')}
                        onChange={(e) => updateOption('method', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      >
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                    <OptionInput label="URL Endpoint" value={selectedOptions.url} onChange={(v) => updateOption('url', v)} mono />
                    <OptionJson label="Body (JSON)" value={selectedOptions.body} onChange={(v) => updateOption('body', v)} />
                  </>
                )}

                {selectedKey === 'mail' && (
                  <>
                    <OptionInput label="Recipient (to)" value={selectedOptions.to} onChange={(v) => updateOption('to', v)} />
                    <OptionInput label="Subject" value={selectedOptions.subject} onChange={(v) => updateOption('subject', v)} />
                  </>
                )}

                {selectedKey === 'log' && (
                  <OptionInput label="Log message" value={selectedOptions.message} onChange={(v) => updateOption('message', v)} />
                )}

                {selectedKey === 'sleep' && (
                  <OptionInput
                    label="Duration (ms, max 60000)"
                    value={selectedOptions.ms}
                    onChange={(v) => updateOption('ms', Number(v))}
                    type="number"
                  />
                )}

                {(selectedKey === 'deploy:trigger' || selectedKey === 'deploy:status') && (
                  <>
                    <OptionInput
                      label="Deployment target id"
                      hint="Settings → Deployments"
                      value={selectedOptions.targetId}
                      onChange={(v) => updateOption('targetId', v)}
                      mono
                    />
                    {selectedKey === 'deploy:trigger' && (
                      <OptionInput
                        label="Coalesce window (ms)"
                        hint="Bursts of events within this window reuse one deploy. 0 = deploy per event."
                        value={selectedOptions.coalesceWindowMs}
                        onChange={(v) => updateOption('coalesceWindowMs', Number(v) || 0)}
                        type="number"
                      />
                    )}
                  </>
                )}

                {selectedKey === 'drift-scan' && (
                  <OptionInput label="Intent id" value={selectedOptions.intentId} onChange={(v) => updateOption('intentId', v)} mono />
                )}

                {/* Generic fallback: raw options editor + registry hints */}
                {!['condition', 'transform', 'http', 'mail', 'log', 'sleep', 'deploy:trigger', 'deploy:status', 'drift-scan'].includes(selectedKey) && (
                  <>
                    <OptionJson
                      label="Options (JSON)"
                      value={selectedOptions}
                      onChange={(v) => {
                        if (!selectedNodeId || typeof v !== 'object' || v === null) return;
                        setNodes((nds) =>
                          nds.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, options: v as Record<string, unknown> } } : n)),
                        );
                      }}
                    />
                    {OPTION_FIELD_HINTS && (
                      <div className="rounded-md border bg-muted/20 p-2">
                        <p className="text-[10px] font-medium uppercase text-muted-foreground mb-1">Registry options</p>
                        {Object.entries(OPTION_FIELD_HINTS).map(([k, v]) => (
                          <p key={k} className="text-[10px] font-mono text-muted-foreground">
                            {k}: {v}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground text-center p-6">
              <Workflow className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <h4 className="text-sm font-semibold">{name}</h4>
              <p className="text-xs mt-1 leading-relaxed">
                Click a node to configure it, or open the Runs tab to inspect execution history on the canvas.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionInput({
  label,
  hint,
  value,
  onChange,
  mono,
  type = 'text',
}: {
  label: string;
  hint?: string;
  value: unknown;
  onChange: (v: string) => void;
  mono?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      <input
        type={type}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className={`w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary ${mono ? 'font-mono' : ''}`}
      />
      {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

/** JSON textarea that keeps invalid intermediate states local until they parse. */
function OptionJson({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        rows={6}
        aria-label={label}
        className={`w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono resize-y ${
          invalid ? 'border-rose-400' : ''
        }`}
      />
      {invalid && <p className="text-[10px] text-rose-500 mt-1">Invalid JSON — not applied yet.</p>}
    </div>
  );
}
