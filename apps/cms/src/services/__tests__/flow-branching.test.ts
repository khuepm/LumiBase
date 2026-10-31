import { beforeEach, describe, expect, it } from 'vitest';
import { decisionHarness, editorRef, PROFILE_KEY, type DecisionHarness } from '../../__tests__/helpers/flow-decision-harness';
import { runAiDecisionNode } from '../flow-ai-decision';
import { registerHandler, runFlow, type FlowGraph } from '../flow-service';

/**
 * Explicit branches in the flow runner (J10, #517).
 *
 * A sample flow: one `ai:decision` node whose four branches each lead to a
 * spy node, plus a shared tail. The decision runs through the real operation
 * (real ReviewService, real governed decision path, fake upstream), and the
 * spies prove that only the chosen branch's nodes execute.
 */

const executed: string[] = [];
let harness: DecisionHarness;

registerHandler('test:spy', async (_ctx, options) => {
  executed.push(String(options['label']));
  return { ran: options['label'] };
});
registerHandler('test:branch', async (_ctx, options) => ({ branch: options['branch'] }));
registerHandler('test:no-branch', async () => ({ done: true }));
// The real operation with the harness runtime; production registers the same
// function under `ai:decision` with the runtime built from the run env.
registerHandler('test:ai-decision', async (ctx, options, node) => runAiDecisionNode(ctx, options, node, harness.runtime));

function spy(id: string, next: string | null = null) {
  return { id, key: 'test:spy', options: { label: id }, next };
}

/** decide → true:onTrue | false:onFalse | unknown:onUnknown | error:onError; true continues to tail. */
function sampleGraph(options: Record<string, unknown> = {}): FlowGraph {
  return {
    entry: 'decide',
    nodes: [
      {
        id: 'decide',
        key: 'test:ai-decision',
        options: {
          profileKey: PROFILE_KEY,
          profileVersion: 1,
          collection: 'posts',
          questionKey: 'spam',
          noulThreshold: 0.8,
          ...options,
        },
        // `next` is set on purpose: a node with branches must never fall through to it.
        next: 'fallthrough',
        branches: { true: 'onTrue', false: 'onFalse', unknown: 'onUnknown', error: 'onError' },
      },
      spy('onTrue', 'tail'),
      spy('onFalse'),
      spy('onUnknown'),
      spy('onError'),
      spy('tail'),
      spy('fallthrough'),
    ],
  };
}

function env(runId = 'run_1') {
  return { runId, principal: editorRef };
}

beforeEach(async () => {
  executed.length = 0;
  harness = await decisionHarness();
});

describe('ai:decision branches in a sample flow', () => {
  it('true runs only the true branch and its continuation', async () => {
    harness.upstream.answers.spam = { type: 'noul', noul: 0.93 };
    const result = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env());
    expect(result.status).toBe('success');
    expect(executed).toEqual(['onTrue', 'tail']);
    expect(result.steps['decide']).toMatchObject({ branch: 'true', decision: { value: 0.93, threshold: 0.8 } });
  });

  it('false runs only the false branch', async () => {
    harness.upstream.answers.spam = { type: 'noul', noul: 0.1 };
    const result = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env());
    expect(result.status).toBe('success');
    expect(executed).toEqual(['onFalse']);
    expect(result.steps['decide']).toMatchObject({ branch: 'false' });
  });

  it('a probability between the thresholds runs only the unknown branch', async () => {
    harness.upstream.answers.spam = { type: 'noul', noul: 0.5 };
    const result = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env());
    expect(executed).toEqual(['onUnknown']);
    expect(result.steps['decide']).toMatchObject({ branch: 'unknown', decision: { unknownReason: 'between_thresholds' } });
  });

  it('a low-confidence choice runs only the unknown branch', async () => {
    harness.upstream.answers.category = { type: 'choice', choice: 'news', probabilities: {}, confidence: 0.4 };
    const graph = sampleGraph({ questionKey: 'category', minConfidence: 0.7 });
    delete graph.nodes[0]!.options!['noulThreshold'];
    graph.nodes[0]!.branches = { news: 'onTrue', promo: 'onFalse', unknown: 'onUnknown', error: 'onError' };
    const result = await runFlow(graph, { itemId: 'itm_1' }, env());
    expect(executed).toEqual(['onUnknown']);
    expect(result.steps['decide']).toMatchObject({ branch: 'unknown', decision: { unknownReason: 'low_confidence' } });
  });

  it('a confident choice follows its own key', async () => {
    const graph = sampleGraph({ questionKey: 'category', minConfidence: 0.7 });
    delete graph.nodes[0]!.options!['noulThreshold'];
    graph.nodes[0]!.branches = { news: 'onTrue', promo: 'onFalse', unknown: 'onUnknown', error: 'onError' };
    const result = await runFlow(graph, { itemId: 'itm_1' }, env());
    expect(executed).toEqual(['onTrue', 'tail']);
    expect(result.steps['decide']).toMatchObject({ branch: 'news' });
  });

  it('a provider failure runs only the error branch, never true', async () => {
    const { DecisionProviderError } = await import('../decision-provider');
    harness.upstream.error = new DecisionProviderError('DECISION_UNAVAILABLE', 'down', 503);
    const result = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env());
    expect(result.status).toBe('success');
    expect(executed).toEqual(['onError']);
    expect(result.steps['decide']).toMatchObject({ branch: 'error', errorCode: 'DECISION_UNAVAILABLE', decision: null });
  });

  it('without an error branch a failure takes onError instead of any decision branch', async () => {
    harness.settings.value = { ...harness.settings.value, enabled: false };
    const graph = sampleGraph();
    delete graph.nodes[0]!.branches!['error'];
    graph.nodes[0]!.onError = 'onError';
    const result = await runFlow(graph, { itemId: 'itm_1' }, env());
    expect(executed).toEqual(['onError']);
    expect(result.steps['decide']).toMatchObject({ error: expect.stringContaining('DECISION_DISABLED') });
  });

  it('a returned branch with no mapping is a run error, not a fall-through', async () => {
    harness.upstream.answers.spam = { type: 'noul', noul: 0.5 };
    const graph = sampleGraph();
    delete graph.nodes[0]!.branches!['unknown'];
    const result = await runFlow(graph, { itemId: 'itm_1' }, env());
    expect(result.status).toBe('error');
    expect(result.error).toBe('Unmapped branch "unknown" at node decide');
    expect(executed).toEqual([]);
  });

  it('a branch mapped to null ends the run on that branch', async () => {
    harness.upstream.answers.spam = { type: 'noul', noul: 0.1 };
    const graph = sampleGraph();
    graph.nodes[0]!.branches!['false'] = null;
    const result = await runFlow(graph, { itemId: 'itm_1' }, env());
    expect(result.status).toBe('success');
    expect(executed).toEqual([]);
  });
});

describe('runner branching rules', () => {
  it('follows the returned branch of any operation', async () => {
    const graph: FlowGraph = {
      entry: 'b',
      nodes: [
        { id: 'b', key: 'test:branch', options: { branch: 'left' }, branches: { left: 'L', right: 'R' } },
        spy('L'),
        spy('R'),
      ],
    };
    expect((await runFlow(graph, {}, {})).status).toBe('success');
    expect(executed).toEqual(['L']);
  });

  it('a node with branches whose operation returns no branch is an error', async () => {
    const graph: FlowGraph = {
      entry: 'b',
      nodes: [{ id: 'b', key: 'test:no-branch', next: 'N', branches: { true: 'N' } }, spy('N')],
    };
    const result = await runFlow(graph, {}, {});
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/returned no branch/);
    expect(executed).toEqual([]);
  });

  it('condition returns branch true/false and drives explicit branches', async () => {
    const graph: FlowGraph = {
      entry: 'c',
      nodes: [
        { id: 'c', key: 'condition', options: { path: 'input.n', operator: '>', value: 3 }, branches: { true: 'T', false: 'F' } },
        spy('T'),
        spy('F'),
      ],
    };
    const yes = await runFlow(graph, { n: 5 }, {});
    expect(yes.steps['c']).toMatchObject({ pass: true, branch: 'true' });
    expect(executed).toEqual(['T']);
    executed.length = 0;
    await runFlow(graph, { n: 1 }, {});
    expect(executed).toEqual(['F']);
  });

  it('legacy next-only graphs are unchanged, even when the operation returns a branch', async () => {
    const graph: FlowGraph = {
      entry: 'c',
      nodes: [
        { id: 'c', key: 'condition', options: { path: 'input.n', operator: '>', value: 3 }, next: 'A' },
        spy('A', 'B'),
        spy('B'),
      ],
    };
    const result = await runFlow(graph, { n: 1 }, {});
    expect(result.status).toBe('success');
    expect(result.steps['c']).toMatchObject({ pass: false });
    expect(executed).toEqual(['A', 'B']);
  });

  it('a cancelled run starts no further node', async () => {
    const controller = new AbortController();
    registerHandler('test:abort', async () => {
      controller.abort();
      return { aborted: true };
    });
    const graph: FlowGraph = { entry: 'x', nodes: [{ id: 'x', key: 'test:abort', next: 'A' }, spy('A')] };
    const result = await runFlow(graph, {}, { _signal: controller.signal });
    expect(result.status).toBe('error');
    expect(result.error).toBe('Flow cancelled before node A');
    expect(executed).toEqual([]);
  });

  it('re-executing the same flow run replays the decision: one provider call, same branch', async () => {
    const first = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env('run_retry'));
    const second = await runFlow(sampleGraph(), { itemId: 'itm_1' }, env('run_retry'));
    expect(harness.provider.provider.decide).toHaveBeenCalledTimes(1);
    expect(first.steps['decide']).toMatchObject({ branch: 'true', replayed: false });
    expect(second.steps['decide']).toMatchObject({ branch: 'true', replayed: true });
    expect((second.steps['decide'] as { runId: string }).runId).toBe((first.steps['decide'] as { runId: string }).runId);
  });
});
