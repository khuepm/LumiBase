/**
 * Flow graph — shared converter + validator between the editor's ReactFlow
 * representation (`FeGraph`: nodes + edges) and the runtime canonical form
 * (`FlowGraph`: nodes with `next`/`onError` pointers). Both the Studio editor
 * (on save/load) and the CMS (on persist/validate) use these so the drawn
 * graph and the executed graph never diverge.
 *
 * Canonical = `FlowGraph` (the runtime format). The editor converts on load
 * and save. See `.kiro/specs/visual-flow-builder`.
 *
 * Explicit branches (J10, #517): a node may carry `branches`, a map from the
 * branch key its operation returns (`true`/`false`/`unknown`/`error`, or a
 * choice key) to the next node id. `null` ends the run on that branch. When a
 * node has `branches`, the runner follows the branch the operation returned
 * and never falls through to `next`; a branch with no entry is a run error.
 */

// ── Canonical (runtime) ──────────────────────────────────────────────────────

export interface FlowNode {
  id: string;
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
  /** Branch key → next node id (`null` ends the run on that branch). */
  branches?: Record<string, string | null>;
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
  /**
   * Node kind (operation key) lives under data.key or data.type.
   * `endBranches` lists branch keys mapped to `null` (end of run), which have
   * no edge to draw; they survive a load/save round trip through it.
   */
  data?: { key?: string; type?: string; options?: Record<string, unknown>; endBranches?: string[] };
  position?: { x: number; y: number };
}

export interface FeEdge {
  source: string;
  target: string;
  /** 'next' (success), 'onError', or 'branch' (taken when the operation returns `branch`). */
  type?: 'next' | 'onError' | 'branch';
  /** Branch key for `type: 'branch'` edges. */
  branch?: string;
}

export interface FeGraph {
  nodes: FeNode[];
  edges: FeEdge[];
}

// ── Conversion ───────────────────────────────────────────────────────────────

/** Editor graph → canonical runtime graph. */
export function feToCanonical(fe: FeGraph): FlowGraph {
  const nodes: FlowNode[] = fe.nodes.map((n) => {
    const outgoing = fe.edges.filter((e) => e.source === n.id);
    const next = outgoing.find((e) => e.type !== 'onError' && e.type !== 'branch');
    const onError = outgoing.find((e) => e.type === 'onError');
    const branches: Record<string, string | null> = {};
    for (const key of n.data?.endBranches ?? []) branches[key] = null;
    for (const e of outgoing) {
      // First edge per branch wins; a drawn edge replaces an end-of-run mapping.
      if (e.type === 'branch' && e.branch && !branches[e.branch]) branches[e.branch] = e.target;
    }
    const node: FlowNode = {
      id: n.id,
      key: n.data?.key ?? n.data?.type ?? '',
      options: n.data?.options,
      next: next ? next.target : null,
      onError: onError ? onError.target : null,
      position: n.position,
    };
    if (Object.keys(branches).length > 0) node.branches = branches;
    return node;
  });
  // Entry = the node that is not the target of any edge (first such, by order).
  const targets = new Set(fe.edges.map((e) => e.target));
  const entry = fe.nodes.find((n) => !targets.has(n.id))?.id ?? fe.nodes[0]?.id;
  return { entry, nodes };
}

/** Canonical runtime graph → editor graph. */
export function canonicalToFe(g: FlowGraph): FeGraph {
  const nodes: FeNode[] = g.nodes.map((n) => {
    const endBranches = Object.entries(n.branches ?? {})
      .filter(([, target]) => target === null)
      .map(([key]) => key);
    return {
      id: n.id,
      data: {
        key: n.key,
        type: n.key,
        options: n.options,
        ...(endBranches.length > 0 ? { endBranches } : {}),
      },
      position: n.position ?? { x: 0, y: 0 },
    };
  });
  const edges: FeEdge[] = [];
  for (const n of g.nodes) {
    if (n.next) edges.push({ source: n.id, target: n.next, type: 'next' });
    if (n.onError) edges.push({ source: n.id, target: n.onError, type: 'onError' });
    for (const [branch, target] of Object.entries(n.branches ?? {})) {
      if (target) edges.push({ source: n.id, target, type: 'branch', branch });
    }
  }
  return { nodes, edges };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type GraphErrorCode =
  | 'DANGLING_EDGE'
  | 'CYCLE'
  | 'NO_ENTRY'
  | 'UNKNOWN_OPERATION'
  | 'INVALID_BRANCH'
  | 'BRANCHES_REQUIRED';

export interface GraphError {
  code: GraphErrorCode;
  nodeId?: string;
  message: string;
}

export interface ValidateGraphOptions {
  /**
   * Operation keys whose result is only meaningful through explicit branches
   * (e.g. `ai:decision`). A node of such a key without `branches` would follow
   * `next` whatever it decided, so it is reported as BRANCHES_REQUIRED.
   */
  branchingKeys?: string[];
}

const BRANCH_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Every node id a node can continue to (`next`, `onError`, branch targets). */
function successors(n: FlowNode): string[] {
  const out: string[] = [];
  if (n.next) out.push(n.next);
  if (n.onError) out.push(n.onError);
  for (const target of Object.values(n.branches ?? {})) if (target) out.push(target);
  return out;
}

/**
 * Validate a canonical graph. `knownKeys` is the set of operation keys with a
 * registered handler; pass an empty array to skip the UNKNOWN_OPERATION check.
 */
export function validateGraph(
  g: FlowGraph,
  knownKeys: string[] = [],
  options: ValidateGraphOptions = {},
): { ok: boolean; errors: GraphError[] } {
  const errors: GraphError[] = [];
  const ids = new Set(g.nodes.map((n) => n.id));
  const known = new Set(knownKeys);
  const branching = new Set(options.branchingKeys ?? []);

  if (g.nodes.length > 0 && !(g.entry && ids.has(g.entry))) {
    errors.push({ code: 'NO_ENTRY', message: 'Graph has no valid entry node.' });
  }

  for (const n of g.nodes) {
    for (const edge of successors(n)) {
      if (!ids.has(edge)) {
        errors.push({ code: 'DANGLING_EDGE', nodeId: n.id, message: `Node "${n.id}" points to missing node "${edge}".` });
      }
    }
    for (const branch of Object.keys(n.branches ?? {})) {
      if (!BRANCH_KEY.test(branch)) {
        errors.push({ code: 'INVALID_BRANCH', nodeId: n.id, message: `Node "${n.id}" has an invalid branch key "${branch}".` });
      }
    }
    if (branching.has(n.key) && Object.keys(n.branches ?? {}).length === 0) {
      errors.push({
        code: 'BRANCHES_REQUIRED',
        nodeId: n.id,
        message: `Node "${n.id}" (${n.key}) needs branch edges; it would otherwise continue whatever it decided.`,
      });
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
    for (const edge of successors(node)) {
      if (visit(edge)) return true;
    }
    state.set(id, 2);
    return false;
  };

  for (const n of g.nodes) {
    if (visit(n.id)) return true;
  }
  return false;
}
