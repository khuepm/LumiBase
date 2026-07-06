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
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  type FeGraph,
  type FlowGraph,
  canonicalToFe,
  feToCanonical,
  validateGraph,
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
  Database,
  Check,
} from 'lucide-react';
import { getApiClient, getActiveToken, getActiveSite } from '@/lib/api';
import { flowNodeTypes } from './flow-node-types';
import { RunHistoryPanel } from './run-history-panel';

interface FlowDetail {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  triggerType: 'webhook' | 'event' | 'schedule' | 'manual';
  graph: {
    nodes: Node[];
    edges: Edge[];
  } | null;
}

const PALETTE_ITEMS = [
  { type: 'condition', label: 'Condition (if)', icon: GitBranch, color: 'text-amber-500 bg-amber-500/10' },
  { type: 'transform', label: 'Transform (JS)', icon: RefreshCw, color: 'text-indigo-500 bg-indigo-500/10' },
  { type: 'http', label: 'HTTP Request', icon: Globe, color: 'text-blue-500 bg-blue-500/10' },
  { type: 'mail', label: 'Send Mail', icon: Mail, color: 'text-violet-500 bg-violet-500/10' },
  { type: 'log', label: 'Log Terminal', icon: Terminal, color: 'text-slate-500 bg-slate-500/10' },
  { type: 'sleep', label: 'Delay (Sleep)', icon: Clock, color: 'text-orange-500 bg-orange-500/10' },
  { type: 'run-extension', label: 'Run Extension', icon: Puzzle, color: 'text-rose-500 bg-rose-500/10' },
  { type: 'item-crud', label: 'Database CRUD', icon: Database, color: 'text-cyan-500 bg-cyan-500/10' },
];

function flowsApi(path: string, init?: RequestInit) {
  return fetch(`/api/v1/flows${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      'X-Lumi-Site': getActiveSite(),
      ...(init?.headers ?? {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`Flows API error: ${r.status}`);
    return r.json();
  });
}

/**
 * Bridge ReactFlow's node/edge model to the shared FeGraph so the canonical
 * converter + validator (single source of truth with the backend) can run.
 * ReactFlow encodes the operation key on `node.type` and marks the error branch
 * with `sourceHandle === 'no'`.
 */
function toFeGraph(nodes: Node[], edges: Edge[]): FeGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      data: { key: (n.type as string) ?? '', options: (n.data ?? {}) as Record<string, unknown> },
      position: n.position,
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: (e as { sourceHandle?: string }).sourceHandle === 'no' ? 'onError' : 'next',
    })),
  };
}

/** Canonical runtime graph → ReactFlow nodes/edges for the editor. */
function fromCanonical(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  const fe = canonicalToFe(graph);
  const nodes: Node[] = fe.nodes.map((n) => ({
    id: n.id,
    type: n.data?.key ?? 'log',
    position: n.position ?? { x: 0, y: 0 },
    data: (n.data?.options ?? {}) as Record<string, unknown>,
  }));
  const edges: Edge[] = fe.edges.map((e) => ({
    id: `edge_${e.source}_${e.target}_${e.type}`,
    source: e.source,
    target: e.target,
    sourceHandle: e.type === 'onError' ? 'no' : 'yes',
    type: 'smoothstep',
  }));
  return { nodes, edges };
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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<any>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Fetch flow detail if edit mode
  const flowQuery = useQuery({
    queryKey: ['flow-detail', id],
    queryFn: async () => {
      if (isNew) return null;
      const resp = await flowsApi(`/${id}`);
      return resp.data as FlowDetail;
    },
    enabled: !isNew,
  });

  // Populate data when loaded
  useEffect(() => {
    if (flowQuery.data) {
      const flow = flowQuery.data;
      setName(flow.name);
      setDescription(flow.description ?? '');
      setStatus(flow.status);
      setTriggerType(flow.triggerType);
      if (flow.graph) {
        const g = flow.graph as unknown as Record<string, unknown>;
        if (Array.isArray(g.edges)) {
          // Legacy row stored the raw ReactFlow shape — load as-is.
          setNodes((g.nodes as Node[]) ?? []);
          setEdges((g.edges as Edge[]) ?? []);
        } else {
          // Canonical runtime graph (the format the backend persists now).
          const fe = fromCanonical(flow.graph as unknown as FlowGraph);
          setNodes(fe.nodes);
          setEdges(fe.edges);
        }
      }
    }
  }, [flowQuery.data, setNodes, setEdges]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Convert to the canonical runtime graph and validate before persisting so
      // the drawn graph and the executed graph never diverge (validateGraph runs
      // on the server too, but catching it here gives inline feedback).
      const graph = feToCanonical(toFeGraph(nodes, edges));
      const result = validateGraph(graph, []);
      if (status === 'active' && !result.ok) {
        throw new Error(result.errors.map((e) => e.message).join('; '));
      }
      const body = { name, description, status, triggerType, graph };

      if (isNew) {
        const resp = await flowsApi('', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return resp.data as FlowDetail;
      } else {
        const resp = await flowsApi(`/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return resp.data as FlowDetail;
      }
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      qc.invalidateQueries({ queryKey: ['flow-detail', id] });
      alert('Flow saved successfully!');
      if (isNew && data?.id) {
        navigate({ to: `/automation/flows/${data.id}` });
      }
    },
    onError: (err) => {
      alert(`Cannot save flow: ${(err as Error).message}`);
    },
  });

  // Trigger test run mutation
  const runMutation = useMutation({
    mutationFn: () => flowsApi(`/${id}/run`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      alert('Test run triggered successfully!');
    },
    onError: (err) => {
      alert(`Test run failed: ${err.message}`);
    },
  });

  // Add node helper
  const addNode = useCallback((type: string) => {
    const newId = `node_${type}_${Date.now()}`;
    
    // Default config values based on node type
    let defaultData: any = {};
    if (type === 'condition') {
      defaultData = { expression: 'data.status === "active"' };
    } else if (type === 'transform') {
      defaultData = { script: 'return { ...data, transformed: true };' };
    } else if (type === 'http') {
      defaultData = { url: 'https://api.example.com', method: 'POST', body: '{}' };
    } else if (type === 'mail') {
      defaultData = { to: 'recipient@example.com', subject: 'Lumibase Notification', body: 'Hello!' };
    } else if (type === 'log') {
      defaultData = { message: 'Workflow checkpoint reached' };
    } else if (type === 'sleep') {
      defaultData = { duration: 2000 };
    } else if (type === 'run-extension') {
      defaultData = { extensionName: '', method: '' };
    } else if (type === 'item-crud') {
      defaultData = { action: 'item.create', collection: '', data: '{}' };
    }

    const newNode: Node = {
      id: newId,
      type,
      position: { x: Math.random() * 200 + 100, y: Math.random() * 200 + 100 },
      data: defaultData,
    };

    setNodes((nds) => nds.concat(newNode));
    setSelectedNodeId(newId);
  }, [setNodes]);

  const onConnect = useCallback(
    (params: Connection) => {
      // Connect next nodes or error branch connections
      const edgeType = params.sourceHandle === 'no' ? 'onError' : 'next';
      const edge: Edge = {
        ...params,
        id: `edge_${params.source}_${params.target}_${Date.now()}`,
        type: 'smoothstep',
        style: edgeType === 'onError' ? { stroke: '#ef4444', strokeDasharray: '5,5' } : { stroke: '#6366f1' },
      };
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges]
  );

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedNodeId(null);
  }, [setNodes, setEdges]);

  // Selected node config logic
  const selectedNode = useMemo(() => {
    return nodes.find((n) => n.id === selectedNodeId) || null;
  }, [nodes, selectedNodeId]);

  const updateSelectedNodeData = useCallback((field: string, val: any) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === selectedNodeId) {
          return {
            ...n,
            data: {
              ...n.data,
              [field]: val,
            },
          };
        }
        return n;
      })
    );
  }, [selectedNodeId, setNodes]);

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
              className="font-semibold text-lg text-foreground bg-transparent border-b border-transparent hover:border-muted focus:border-primary px-1 outline-none transition"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Status badge and select dropdown */}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
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

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: Operations Palette */}
        <div className="w-64 border-r bg-muted/10 p-4 flex flex-col gap-4 overflow-y-auto">
          <div>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Flow settings</h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground">Trigger Type</label>
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as any)}
                  className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1"
                >
                  <option value="manual">Manual Trigger</option>
                  <option value="webhook">Webhook Trigger</option>
                  <option value="event">CMS Event (item.*)</option>
                  <option value="schedule">Schedule (Cron)</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this workflow do?"
                  rows={2}
                  className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary mt-1 resize-none"
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Add Operations</h3>
            <div className="grid gap-2">
              {PALETTE_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.type}
                    onClick={() => addNode(item.type)}
                    className="flex items-center justify-between rounded-lg border bg-background p-2.5 hover:bg-accent text-left group transition-all"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`flex h-6 w-6 items-center justify-center rounded ${item.color}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <span className="text-xs font-medium text-foreground">{item.label}</span>
                    </div>
                    <Plus className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Visual Editor Canvas */}
        <div className="flex-1 relative bg-muted/5">
          <ReactFlow
            nodes={nodes}
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

        {/* Right Sidebar: Node configurations */}
        <div className="w-80 border-l bg-background p-4 overflow-y-auto flex flex-col justify-between">
          {selectedNode ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2 mb-2">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-bold text-foreground">Configure Node</h3>
                </div>
                <button
                  onClick={() => deleteNode(selectedNode.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-rose-50 text-rose-600 transition"
                  title="Delete Node"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Node specific config forms */}
              <div className="space-y-3">
                {selectedNode.type === 'condition' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Expression (JSONata / JS)</label>
                    <input
                      type="text"
                      value={selectedNode.data.expression || ''}
                      onChange={(e) => updateSelectedNodeData('expression', e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Evaluates if the path continues (e.g. `data.status = "published"`)</p>
                  </div>
                )}

                {selectedNode.type === 'transform' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Transform Script (JS)</label>
                    <textarea
                      value={selectedNode.data.script || ''}
                      onChange={(e) => updateSelectedNodeData('script', e.target.value)}
                      rows={8}
                      className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono resize-y"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Mutate payload. Must return the final object state.</p>
                  </div>
                )}

                {selectedNode.type === 'http' && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">HTTP Method</label>
                      <select
                        value={selectedNode.data.method || 'GET'}
                        onChange={(e) => updateSelectedNodeData('method', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">URL Endpoint</label>
                      <input
                        type="url"
                        value={selectedNode.data.url || ''}
                        onChange={(e) => updateSelectedNodeData('url', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Body JSON payload</label>
                      <textarea
                        value={selectedNode.data.body || ''}
                        onChange={(e) => updateSelectedNodeData('body', e.target.value)}
                        rows={4}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono"
                      />
                    </div>
                  </div>
                )}

                {selectedNode.type === 'mail' && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Recipient Email (To)</label>
                      <input
                        type="email"
                        value={selectedNode.data.to || ''}
                        onChange={(e) => updateSelectedNodeData('to', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Subject</label>
                      <input
                        type="text"
                        value={selectedNode.data.subject || ''}
                        onChange={(e) => updateSelectedNodeData('subject', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Message Body</label>
                      <textarea
                        value={selectedNode.data.body || ''}
                        onChange={(e) => updateSelectedNodeData('body', e.target.value)}
                        rows={4}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                )}

                {selectedNode.type === 'log' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Log Message</label>
                    <input
                      type="text"
                      value={selectedNode.data.message || ''}
                      onChange={(e) => updateSelectedNodeData('message', e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                    />
                  </div>
                )}

                {selectedNode.type === 'sleep' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Duration (ms)</label>
                    <input
                      type="number"
                      value={selectedNode.data.duration || ''}
                      onChange={(e) => updateSelectedNodeData('duration', Number(e.target.value))}
                      className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                    />
                  </div>
                )}

                {selectedNode.type === 'run-extension' && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Extension Slug</label>
                      <input
                        type="text"
                        value={selectedNode.data.extensionName || ''}
                        onChange={(e) => updateSelectedNodeData('extensionName', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Method / Action</label>
                      <input
                        type="text"
                        value={selectedNode.data.method || ''}
                        onChange={(e) => updateSelectedNodeData('method', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                )}

                {selectedNode.type === 'item-crud' && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Operation Action</label>
                      <select
                        value={selectedNode.data.action || 'item.create'}
                        onChange={(e) => updateSelectedNodeData('action', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      >
                        <option value="item.create">Create Item</option>
                        <option value="item.update">Update Item</option>
                        <option value="item.delete">Delete Item</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Collection</label>
                      <input
                        type="text"
                        value={selectedNode.data.collection || ''}
                        onChange={(e) => updateSelectedNodeData('collection', e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Payload JSON / Options</label>
                      <textarea
                        value={selectedNode.data.data || ''}
                        onChange={(e) => updateSelectedNodeData('data', e.target.value)}
                        rows={4}
                        className="w-full rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-primary font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-center p-6">
              <Workflow className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <h4 className="text-sm font-semibold">{name}</h4>
              <p className="text-xs mt-1 leading-relaxed">
                Click on any operation node in the canvas to configure its settings, or connect node handles to construct workflows.
              </p>
            </div>
          )}

          <div className="border-t pt-4 text-right">
            <span className="text-[10px] text-muted-foreground font-mono">
              ID: {selectedNodeId || 'none'}
            </span>
          </div>

          {!isNew && id && (
            <div className="border-t pt-4">
              <h3 className="mb-2 text-sm font-semibold">Run history</h3>
              <RunHistoryPanel flowId={id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
