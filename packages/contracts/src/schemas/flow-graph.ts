/**
 * Flow graph — shared converter + validator between the editor's ReactFlow
 * representation (`FeGraph`: nodes + edges) and the runtime canonical form
 * (`FlowGraph`: nodes with `next`/`onError` pointers). Both the Studio editor
 * (on save/load) and the CMS (on persist/validate) use these so the drawn
 * graph and the executed graph never diverge.
 *
 * Canonical = `FlowGraph` (the runtime format). The editor converts on load
 * and save. See `.kiro/specs/visual-flow-builder`.
 */

// ── Canonical (runtime) ──────────────────────────────────────────────────────

export interface FlowNode {
  id: string;
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
  /** Editor coordinates, preserved across round-trips. */
  position?: { x: number; y: number };
}

export interface FlowGraph {
  entry?: string;
  nodes: FlowNode[];
}

// ── Editor (ReactFlow) ───────────────────────────────────────────────────────

export interface FeNode {
  id: string;
  /** Node kind (operation key) lives under data.key or data.type. */
  data?: { key?: string; type?: string; options?: Record<string, unknown> };
  position?: { x: number; y: number };
}

export interface FeEdge {
  source: string;
  target: string;
  /** 'next' (success) or 'onError'. */
  type?: 'next' | 'onError';
}

export interface FeGraph {
  nodes: FeNode[];
  edges: FeEdge[];
}

// ── Conversion ───────────────────────────────────────────────────────────────

/** Editor graph → canonical runtime graph. */
export function feToCanonical(fe: FeGraph): FlowGraph {
  const nodes: FlowNode[] = fe.nodes.map((n) => {
    const next = fe.edges.find((e) => e.source === n.id && e.type !== 'onError');
    const onError = fe.edges.find((e) => e.source === n.id && e.type === 'onError');
    return {
      id: n.id,
      key: n.data?.key ?? n.data?.type ?? '',
      options: n.data?.options,
      next: next ? next.target : null,
      onError: onError ? onError.target : null,
      position: n.position,
    };
  });
  // Entry = the node that is not the target of any edge (first such, by order).
  const targets = new Set(fe.edges.map((e) => e.target));
  const entry = fe.nodes.find((n) => !targets.has(n.id))?.id ?? fe.nodes[0]?.id;
  return { entry, nodes };
}

/** Canonical runtime graph → editor graph. */
export function canonicalToFe(g: FlowGraph): FeGraph {
  const nodes: FeNode[] = g.nodes.map((n) => ({
    id: n.id,
    data: { key: n.key, type: n.key, options: n.options },
    position: n.position ?? { x: 0, y: 0 },
  }));
  const edges: FeEdge[] = [];
  for (const n of g.nodes) {
    if (n.next) edges.push({ source: n.id, target: n.next, type: 'next' });
    if (n.onError) edges.push({ source: n.id, target: n.onError, type: 'onError' });
  }
  return { nodes, edges };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type GraphErrorCode = 'DANGLING_EDGE' | 'CYCLE' | 'NO_ENTRY' | 'UNKNOWN_OPERATION';

export interface GraphError {
  code: GraphErrorCode;
  nodeId?: string;
  message: string;
}

/**
 * Validate a canonical graph. `knownKeys` is the set of operation keys with a
 * registered handler; pass an empty array to skip the UNKNOWN_OPERATION check.
 */
export function validateGraph(g: FlowGraph, knownKeys: string[] = []): { ok: boolean; errors: GraphError[] } {
  const errors: GraphError[] = [];
  const ids = new Set(g.nodes.map((n) => n.id));
  const known = new Set(knownKeys);

  if (g.nodes.length > 0 && !(g.entry && ids.has(g.entry))) {
    errors.push({ code: 'NO_ENTRY', message: 'Graph has no valid entry node.' });
  }

  for (const n of g.nodes) {
    for (const edge of [n.next, n.onError]) {
      if (edge && !ids.has(edge)) {
        errors.push({ code: 'DANGLING_EDGE', nodeId: n.id, message: `Node "${n.id}" points to missing node "${edge}".` });
      }
    }
    if (knownKeys.length > 0 && !known.has(n.key)) {
      errors.push({ code: 'UNKNOWN_OPERATION', nodeId: n.id, message: `Node "${n.id}" uses unknown operation "${n.key}".` });
    }
  }

  if (hasCycle(g)) {
    errors.push({ code: 'CYCLE', message: 'Graph contains a cycle.' });
  }

  return { ok: errors.length === 0, errors };
}

function hasCycle(g: FlowGraph): boolean {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 in-stack, 2 done

  const visit = (id: string): boolean => {
    const node = byId.get(id);
    if (!node) return false; // dangling handled separately
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const edge of [node.next, node.onError]) {
      if (edge && visit(edge)) return true;
    }
    state.set(id, 2);
    return false;
  };

  for (const n of g.nodes) {
    if (visit(n.id)) return true;
  }
  return false;
}
