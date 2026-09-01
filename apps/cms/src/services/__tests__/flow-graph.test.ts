import {
  type FlowGraph,
  canonicalToFe,
  feToCanonical,
  validateGraph,
} from '@lumibase/contracts';
import { describe, expect, it } from 'vitest';

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
