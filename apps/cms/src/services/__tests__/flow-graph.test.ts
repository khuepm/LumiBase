import {
  type FlowGraph,
  canonicalToFe,
  feToCanonical,
  validateGraph,
} from '@lumibase/contracts';
import { describe, expect, it } from 'vitest';
import { flowSchema, graphErrorsForSave } from '../flow-management';

describe('flow graph conversion', () => {
  const canonical: FlowGraph = {
    entry: 'a',
    nodes: [
      { id: 'a', key: 'log', next: 'b', onError: 'c', position: { x: 0, y: 0 } },
      { id: 'b', key: 'http', next: null, onError: null, position: { x: 100, y: 0 } },
      { id: 'c', key: 'log', next: null, onError: null, position: { x: 0, y: 100 } },
    ],
  };

  it('round-trips canonical → fe → canonical preserving edges + entry', () => {
    const fe = canonicalToFe(canonical);
    const back = feToCanonical(fe);
    expect(back.entry).toBe('a');
    const a = back.nodes.find((n) => n.id === 'a');
    expect(a?.next).toBe('b');
    expect(a?.onError).toBe('c');
    expect(a?.position).toEqual({ x: 0, y: 0 });
  });

  it('feToCanonical derives entry as the node with no incoming edge', () => {
    const fe = {
      nodes: [
        { id: 'x', data: { key: 'log' } },
        { id: 'y', data: { key: 'log' } },
      ],
      edges: [{ source: 'x', target: 'y', type: 'next' as const }],
    };
    expect(feToCanonical(fe).entry).toBe('x');
  });
});

describe('branch edges (J10, #517)', () => {
  const branching: FlowGraph = {
    entry: 'd',
    nodes: [
      {
        id: 'd',
        key: 'ai:decision',
        branches: { true: 't', false: 'f', unknown: 'u', error: null },
        position: { x: 0, y: 0 },
      },
      { id: 't', key: 'log', next: null, onError: null, position: { x: 1, y: 0 } },
      { id: 'f', key: 'log', next: null, onError: null, position: { x: 1, y: 1 } },
      { id: 'u', key: 'log', next: null, onError: null, position: { x: 1, y: 2 } },
    ],
  };

  it('canonicalToFe emits one branch edge per mapped branch and keeps end-of-run branches on the node', () => {
    const fe = canonicalToFe(branching);
    expect(fe.edges).toEqual([
      { source: 'd', target: 't', type: 'branch', branch: 'true' },
      { source: 'd', target: 'f', type: 'branch', branch: 'false' },
      { source: 'd', target: 'u', type: 'branch', branch: 'unknown' },
    ]);
    expect(fe.nodes[0]!.data?.endBranches).toEqual(['error']);
  });

  it('round-trips branches (including null) and never turns a branch edge into next', () => {
    const back = feToCanonical(canonicalToFe(branching));
    const d = back.nodes.find((n) => n.id === 'd')!;
    expect(d.branches).toEqual({ error: null, true: 't', false: 'f', unknown: 'u' });
    expect(d.next).toBeNull();
    expect(d.onError).toBeNull();
    expect(back.entry).toBe('d');
    // Nodes without branches carry no branches key at all.
    expect(back.nodes.find((n) => n.id === 't')).not.toHaveProperty('branches');
  });

  it('a drawn branch edge replaces an end-of-run mapping of the same key', () => {
    const fe = canonicalToFe(branching);
    fe.edges.push({ source: 'd', target: 't', type: 'branch', branch: 'error' });
    expect(feToCanonical(fe).nodes[0]!.branches!['error']).toBe('t');
  });

  it('validateGraph flags a dangling branch target and a cycle through a branch', () => {
    const dangling: FlowGraph = { entry: 'd', nodes: [{ id: 'd', key: 'ai:decision', branches: { true: 'ghost' } }] };
    expect(validateGraph(dangling).errors).toEqual([
      expect.objectContaining({ code: 'DANGLING_EDGE', nodeId: 'd' }),
    ]);
    const cyclic: FlowGraph = {
      entry: 'd',
      nodes: [
        { id: 'd', key: 'ai:decision', branches: { true: 'a' } },
        { id: 'a', key: 'log', next: 'd' },
      ],
    };
    expect(validateGraph(cyclic).errors.some((e) => e.code === 'CYCLE')).toBe(true);
    expect(validateGraph(branching).ok).toBe(true);
  });

  it('validateGraph flags invalid branch keys and branching operations without branches', () => {
    const bad: FlowGraph = { entry: 'd', nodes: [{ id: 'd', key: 'ai:decision', branches: { 'not a key': null } }] };
    expect(validateGraph(bad).errors.some((e) => e.code === 'INVALID_BRANCH')).toBe(true);
    const bare: FlowGraph = { entry: 'd', nodes: [{ id: 'd', key: 'ai:decision', next: null }] };
    expect(validateGraph(bare).ok).toBe(true);
    expect(validateGraph(bare, [], { branchingKeys: ['ai:decision'] }).errors).toEqual([
      expect.objectContaining({ code: 'BRANCHES_REQUIRED', nodeId: 'd' }),
    ]);
  });
});

describe('flow save gate keeps branches', () => {
  it('flowSchema keeps node branches instead of stripping them', () => {
    const parsed = flowSchema.parse({
      name: 'f',
      triggerType: 'manual',
      graph: { entry: 'd', nodes: [{ id: 'd', key: 'ai:decision', branches: { true: null, error: null } }] },
    });
    expect(parsed.graph.nodes[0]!.branches).toEqual({ true: null, error: null });
  });

  it('an active flow with an ai:decision node and no branches is refused', () => {
    const graph: FlowGraph = { entry: 'd', nodes: [{ id: 'd', key: 'ai:decision', next: null }] };
    expect(graphErrorsForSave('active', graph)).toEqual([expect.objectContaining({ code: 'BRANCHES_REQUIRED' })]);
    expect(graphErrorsForSave('draft', graph)).toBeNull();
  });
});

describe('validateGraph', () => {
  it('passes a well-formed graph', () => {
    const g: FlowGraph = { entry: 'a', nodes: [{ id: 'a', key: 'log', next: null }] };
    expect(validateGraph(g, ['log']).ok).toBe(true);
  });

  it('flags a dangling edge', () => {
    const g: FlowGraph = { entry: 'a', nodes: [{ id: 'a', key: 'log', next: 'ghost' }] };
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'DANGLING_EDGE')).toBe(true);
  });

  it('flags a missing entry', () => {
    const g: FlowGraph = { nodes: [{ id: 'a', key: 'log', next: null }] };
    expect(validateGraph(g).errors.some((e) => e.code === 'NO_ENTRY')).toBe(true);
  });

  it('flags a cycle', () => {
    const g: FlowGraph = {
      entry: 'a',
      nodes: [
        { id: 'a', key: 'log', next: 'b' },
        { id: 'b', key: 'log', next: 'a' },
      ],
    };
    expect(validateGraph(g).errors.some((e) => e.code === 'CYCLE')).toBe(true);
  });

  it('flags an unknown operation when knownKeys is provided', () => {
    const g: FlowGraph = { entry: 'a', nodes: [{ id: 'a', key: 'mystery', next: null }] };
    expect(validateGraph(g, ['log', 'http']).errors.some((e) => e.code === 'UNKNOWN_OPERATION')).toBe(true);
  });

  it('skips the unknown-operation check when knownKeys is empty', () => {
    const g: FlowGraph = { entry: 'a', nodes: [{ id: 'a', key: 'anything', next: null }] };
    expect(validateGraph(g).ok).toBe(true);
  });
});
