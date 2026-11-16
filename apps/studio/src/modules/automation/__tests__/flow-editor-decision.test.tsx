// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { FlowGraph } from '@lumibase/contracts';

/**
 * Flow editor: the `ai:decision` palette entry and explicit branch edges
 * (J10, #517).
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'new' }),
  useNavigate: () => vi.fn(),
}));

import { canvasToCanonical, edgeForConnection, FlowEditor, graphToCanvas } from '../flow-editor';
import { AiDecisionNode, aiDecisionBranchKeys, flowNodeTypes } from '../flow-node-types';

beforeAll(() => {
  // ReactFlow measures its container; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
});

const OPERATIONS = [
  { key: 'log', description: 'Log a message' },
  { key: 'ai:decision', description: 'Governed AI decision' },
];

function renderEditor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ data: { operations: OPERATIONS } }) }) as Response),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FlowEditor />
    </QueryClientProvider>,
  );
}

describe('ai:decision palette entry', () => {
  it('appears in the palette from the operation registry and adds a node with its config panel', async () => {
    renderEditor();
    const entry = await screen.findByRole('button', { name: /AI Decision/ });
    fireEvent.click(entry);
    expect(await screen.findByLabelText('Profile version (pinned)')).toBeInTheDocument();
    expect(screen.getByLabelText('Question key')).toBeInTheDocument();
    expect(screen.getByText(/never/)).toBeInTheDocument();
  });

  it('the node draws one source handle per branch: true, false, unknown, error (+ choice keys)', () => {
    expect(flowNodeTypes['ai:decision']).toBe(AiDecisionNode);
    const { container } = render(
      <ReactFlowProvider>
        <AiDecisionNode data={{ key: 'ai:decision', options: { profileKey: 'moderation', profileVersion: 2 } }} />
      </ReactFlowProvider>,
    );
    const handles = [...container.querySelectorAll('[data-handleid]')].map((h) => h.getAttribute('data-handleid'));
    expect(handles).toEqual(['true', 'false', 'unknown', 'error']);
    expect(screen.getByText('moderation@v2')).toBeInTheDocument();
    expect(aiDecisionBranchKeys({ choices: ['news', 'promo', 'bad key'] })).toEqual([
      'news',
      'promo',
      'true',
      'false',
      'unknown',
      'error',
    ]);
  });
});

describe('branch edges in the editor', () => {
  it('a connection from a decision handle becomes a branch edge; others keep next/onError', () => {
    const branch = edgeForConnection({ source: 'd', target: 't', sourceHandle: 'unknown', targetHandle: null }, 'ai:decision', 1);
    expect(branch.data).toEqual({ branch: 'branch', branchKey: 'unknown' });
    expect(branch.sourceHandle).toBe('unknown');
    const plain = edgeForConnection({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null }, 'log', 1);
    expect(plain.data).toEqual({ branch: 'next' });
  });

  it('round-trips a canonical graph with branches through the canvas', () => {
    const graph: FlowGraph = {
      entry: 'd',
      nodes: [
        { id: 'd', key: 'ai:decision', options: { profileKey: 'm' }, branches: { true: 't', false: 'f', unknown: 'u', error: null } },
        { id: 't', key: 'log', next: null, onError: null },
        { id: 'f', key: 'log', next: null, onError: null },
        { id: 'u', key: 'log', next: null, onError: null },
      ],
    };
    const canvas = graphToCanvas(graph as unknown as Record<string, unknown>);
    expect(canvas.nodes[0]!.type).toBe('ai:decision');
    expect(canvas.edges.map((e) => [e.sourceHandle, e.target])).toEqual([
      ['true', 't'],
      ['false', 'f'],
      ['unknown', 'u'],
    ]);
    const back = canvasToCanonical(canvas.nodes, canvas.edges);
    expect(back.nodes[0]!.branches).toEqual({ true: 't', false: 'f', unknown: 'u', error: null });
    expect(back.nodes[0]!.next).toBeNull();
  });
});
