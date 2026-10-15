import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import {
  decisionHarness,
  editorRef,
  PROFILE_KEY,
  SITE,
  type DecisionHarness,
} from '../../__tests__/helpers/flow-decision-harness';
import { flowDecisionsEnabled, parseDecisionSettings } from '../decision-governance';
import { DecisionProviderError } from '../decision-provider';
import {
  aiDecisionRuntimeFromEnv,
  decisionBranch,
  FlowDecisionError,
  runAiDecisionNode,
  type AiDecisionOutput,
} from '../flow-ai-decision';
import { processFlowRunJob } from '../flow-run-service';
import { registerHandler, type FlowNode, type FlowRunContext } from '../flow-service';

/**
 * Flows `ai:decision` governance (J10, #517): every failure is a failure
 * (never `true`), every gate is checked when the node executes, and a retry
 * of the same flow run replays the stored decision without a provider call.
 */

let h: DecisionHarness;

const BRANCHES = { true: 'T', false: 'F', unknown: 'U', error: 'E' };
const OPTIONS = { profileKey: PROFILE_KEY, profileVersion: 1, collection: 'posts', questionKey: 'spam', noulThreshold: 0.8 };

function node(branches: Record<string, string | null> = BRANCHES, id = 'decide'): FlowNode {
  return { id, key: 'ai:decision', options: OPTIONS, branches };
}

function ctx(env: Record<string, unknown> = {}, input: Record<string, unknown> = { itemId: 'itm_1' }): FlowRunContext {
  return { input, steps: {}, env: { runId: 'run_1', principal: editorRef, ...env } };
}

function decide(
  options: Record<string, unknown> = OPTIONS,
  n: FlowNode = node(),
  context: FlowRunContext = ctx(),
): Promise<AiDecisionOutput> {
  return runAiDecisionNode(context, options, n, h.runtime);
}

const calls = () => h.provider.provider.decide.mock.calls.length;

beforeEach(async () => {
  h = await decisionHarness();
  // A strong "yes": any failure that leaked into an answer would read as true.
  h.upstream.answers.spam = { type: 'noul', noul: 0.99 };
});

describe('governance failures never yield true', () => {
  const cases: Array<{ name: string; code: string; arrange: () => void; context?: () => FlowRunContext; reachesProvider: boolean }> = [
    { name: 'site kill switch', code: 'DECISION_DISABLED', arrange: () => (h.settings.value = { ...h.settings.value, enabled: false }), reachesProvider: false },
    { name: 'flows flag off', code: 'DECISION_DISABLED', arrange: () => (h.settings.value = { ...h.settings.value, flows: false }), reachesProvider: false },
    { name: 'provider not configured', code: 'DECISION_NOT_CONFIGURED', arrange: () => (h.configured.value = null), reachesProvider: false },
    { name: 'quota exhausted', code: 'DECISION_QUOTA_EXCEEDED', arrange: () => (h.quota.value = { ...h.quota.value, requestsPerHour: 0 }), reachesProvider: false },
    { name: 'decision timeout', code: 'DECISION_TIMEOUT', arrange: () => (h.upstream.error = new DecisionProviderError('DECISION_TIMEOUT', 'slow')), reachesProvider: true },
    { name: 'provider unavailable', code: 'DECISION_UNAVAILABLE', arrange: () => (h.upstream.error = new DecisionProviderError('DECISION_UNAVAILABLE', 'down', 503)), reachesProvider: true },
    { name: 'provider rate limit', code: 'DECISION_RATE_LIMITED', arrange: () => (h.upstream.error = new DecisionProviderError('DECISION_RATE_LIMITED', '429', 429)), reachesProvider: true },
    {
      name: 'cancelled run',
      code: 'DECISION_CANCELLED',
      arrange: () => undefined,
      context: () => {
        const controller = new AbortController();
        controller.abort();
        return ctx({ _signal: controller.signal });
      },
      reachesProvider: true,
    },
    { name: 'item missing', code: 'REVIEW_ITEM_NOT_FOUND', arrange: () => (h.content.items = {}), reachesProvider: false },
    { name: 'unpinned / missing profile version', code: 'REVIEW_PROFILE_NOT_FOUND', arrange: () => undefined, reachesProvider: false },
  ];

  for (const c of cases) {
    it(`${c.name} → error branch when mapped`, async () => {
      c.arrange();
      const options = c.code === 'REVIEW_PROFILE_NOT_FOUND' ? { ...OPTIONS, profileVersion: 7 } : OPTIONS;
      const out = await decide(options, node(), c.context?.() ?? ctx());
      expect(out.branch).toBe('error');
      expect(out.errorCode).toBe(c.code);
      expect(out.decision).toBeNull();
      if (!c.reachesProvider) expect(calls()).toBe(0);
    });

    it(`${c.name} → throws (onError) when no error branch is mapped`, async () => {
      c.arrange();
      const options = c.code === 'REVIEW_PROFILE_NOT_FOUND' ? { ...OPTIONS, profileVersion: 7 } : OPTIONS;
      const err = await decide(options, node({ true: 'T', false: 'F', unknown: 'U' }), c.context?.() ?? ctx()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FlowDecisionError);
      expect((err as FlowDecisionError).code).toBe(c.code);
    });
  }

  it('a profile version is required: the active version is never used implicitly', async () => {
    const { profileVersion: _omit, ...unpinned } = OPTIONS;
    const out = await decide(unpinned);
    expect(out).toMatchObject({ branch: 'error', errorCode: 'VALIDATION' });
    expect(calls()).toBe(0);
  });

  it('a node without branches refuses to run at all', async () => {
    await expect(decide(OPTIONS, { id: 'd', key: 'ai:decision', next: 'X' })).rejects.toMatchObject({
      code: 'DECISION_FLOW_MISCONFIGURED',
    });
    expect(calls()).toBe(0);
  });

  it('score questions and missing thresholds are configuration errors', async () => {
    expect(await decide({ ...OPTIONS, questionKey: 'tone' })).toMatchObject({ branch: 'error', errorCode: 'VALIDATION' });
    const { noulThreshold: _t, ...noThreshold } = OPTIONS;
    expect(await decide(noThreshold)).toMatchObject({ branch: 'error', errorCode: 'VALIDATION' });
    expect(await decide({ ...OPTIONS, questionKey: 'category', noulThreshold: undefined })).toMatchObject({
      branch: 'error',
      errorCode: 'VALIDATION',
    });
    expect(calls()).toBe(0);
  });
});

describe('gates are evaluated when the node executes', () => {
  it('a kill switch flipped after the run started blocks before the provider call', async () => {
    // The op's own check passes; the switch flips while content is read, and
    // governance re-reads settings at call time.
    h.content.onRead = () => {
      h.settings.value = { ...h.settings.value, enabled: false };
    };
    const out = await decide();
    expect(out).toMatchObject({ branch: 'error', errorCode: 'DECISION_DISABLED' });
    expect(calls()).toBe(0);
  });

  it('aiDecisions.flows turned off after enqueue blocks the queued run', async () => {
    h.settings.value = { ...h.settings.value, flows: false };
    expect(await decide()).toMatchObject({ branch: 'error', errorCode: 'DECISION_DISABLED' });
    expect(calls()).toBe(0);
  });

  it('a principal without ai:decide is denied', async () => {
    h.grants.set('usr_editor', ['items:read']);
    const out = await decide();
    expect(out).toMatchObject({ branch: 'error', errorCode: 'FORBIDDEN' });
    expect(calls()).toBe(0);
  });

  it('a principal revoked after enqueue is denied', async () => {
    h.grants.delete('usr_editor');
    expect(await decide()).toMatchObject({ branch: 'error', errorCode: 'FORBIDDEN' });
    expect(calls()).toBe(0);
  });

  it('a run with no principal (event, schedule, webhook) is refused, not run as system', async () => {
    const out = await decide(OPTIONS, node(), ctx({ principal: null }));
    expect(out).toMatchObject({ branch: 'error', errorCode: 'FORBIDDEN' });
    expect(calls()).toBe(0);
  });

  it('decisions in flows are off by default (Phase C)', () => {
    expect(flowDecisionsEnabled(parseDecisionSettings({ enabled: true }))).toBe(false);
    expect(flowDecisionsEnabled(parseDecisionSettings({ enabled: false, flows: true }))).toBe(false);
    expect(flowDecisionsEnabled(parseDecisionSettings({ enabled: true, flows: true }))).toBe(true);
    expect(flowDecisionsEnabled(parseDecisionSettings({ enabled: true, flows: 'yes' }))).toBe(false);
  });
});

describe('idempotency', () => {
  it('a retry with the same flow run id makes one provider call and replays the branch', async () => {
    const first = await decide();
    const second = await decide();
    expect(calls()).toBe(1);
    expect(first).toMatchObject({ branch: 'true', replayed: false });
    expect(second).toMatchObject({ branch: 'true', replayed: true, runId: first.runId });
    expect(h.store.runs).toHaveLength(1);
    expect(h.store.runs[0]!.idempotencyKey).toBe('flow:run_1:decide');
  });

  it('another flow run or another node is a separate decision', async () => {
    await decide();
    await decide(OPTIONS, node(BRANCHES, 'decide_2'));
    await decide(OPTIONS, node(), ctx({ runId: 'run_2' }));
    expect(calls()).toBe(3);
    expect(h.store.runs.map((r) => r.idempotencyKey).sort()).toEqual([
      'flow:run_1:decide',
      'flow:run_1:decide_2',
      'flow:run_2:decide',
    ]);
  });

  it('a replay whose content changed reads as unknown, not as the stored answer', async () => {
    await decide();
    h.content.items['itm_1'] = { title: 'Edited', body: 'New body' };
    const replay = await decide();
    expect(calls()).toBe(1);
    expect(replay).toMatchObject({ branch: 'unknown', replayed: true, decision: { unknownReason: 'stale' } });
  });

  it('a decision that failed is retried on the next execution (the store reclaims error runs)', async () => {
    h.upstream.error = new DecisionProviderError('DECISION_UNAVAILABLE', 'down', 503);
    expect(await decide()).toMatchObject({ branch: 'error' });
    h.upstream.error = null;
    expect(await decide()).toMatchObject({ branch: 'true', replayed: false });
    expect(calls()).toBe(2);
    expect(h.store.runs).toHaveLength(1);
  });
});

describe('site scope', () => {
  it('a principal of another site is denied before any database read', async () => {
    const touched: string[] = [];
    const db = new Proxy({}, {
      get(_t, prop) {
        touched.push(String(prop));
        throw new Error('db must not be touched');
      },
    }) as unknown as Database;
    const runtime = aiDecisionRuntimeFromEnv({ db, siteId: SITE });
    const out = await runAiDecisionNode(
      ctx({ principal: { type: 'user', siteId: 'site_2', userId: 'usr_editor' } }),
      OPTIONS,
      node(),
      runtime,
    );
    expect(out).toMatchObject({ branch: 'error', errorCode: 'FORBIDDEN' });
    expect(touched).toEqual([]);
  });

  it("another site's profiles and runs are invisible", async () => {
    const other = await decisionHarness('site_2');
    other.store.profiles = [];
    const out = await runAiDecisionNode(
      ctx({ principal: { ...editorRef, siteId: 'site_2' } }),
      OPTIONS,
      node(),
      other.runtime,
    );
    expect(out).toMatchObject({ branch: 'error', errorCode: 'REVIEW_PROFILE_NOT_FOUND' });
    await decide();
    expect(h.store.runs.every((r) => r.siteId === SITE)).toBe(true);
    expect(other.store.runs).toHaveLength(0);
  });
});

describe('branch mapping', () => {
  const noul = (n: number) => ({ type: 'noul' as const, noul: n });
  const choice = (c: string, confidence = 0.9) => ({ type: 'choice' as const, choice: c, probabilities: {}, confidence });
  const base = { noulThreshold: 0.8, minConfidence: 0.7, abstained: false, stale: false };

  it('noul uses symmetric thresholds', () => {
    expect(decisionBranch(noul(0.8), base).branch).toBe('true');
    expect(decisionBranch(noul(0.2), base).branch).toBe('false');
    expect(decisionBranch(noul(0.79), base).branch).toBe('unknown');
    expect(decisionBranch(noul(0.21), base).branch).toBe('unknown');
  });

  it('a 50/50 noul at the lowest threshold is unknown, not true', () => {
    const half = { ...base, noulThreshold: 0.5 };
    expect(decisionBranch(noul(0.5), half)).toMatchObject({ branch: 'unknown', unknownReason: 'between_thresholds' });
    expect(decisionBranch(noul(0.51), half).branch).toBe('true');
    expect(decisionBranch(noul(0.49), half).branch).toBe('false');
  });

  it('choice abstention, reserved keys and low confidence are unknown', () => {
    expect(decisionBranch(choice('news'), base).branch).toBe('news');
    expect(decisionBranch(choice('other'), base).branch).toBe('unknown');
    expect(decisionBranch(choice('unknown'), base).branch).toBe('unknown');
    expect(decisionBranch(choice('error'), base).branch).toBe('unknown');
    expect(decisionBranch(choice('news', 0.5), base).branch).toBe('unknown');
    expect(decisionBranch(choice('news'), { ...base, abstained: true }).branch).toBe('unknown');
  });
});

describe('worker path', () => {
  it('hands the job principal, cache and env to the run, as a reference only', async () => {
    let seen: Record<string, unknown> | null = null;
    registerHandler('test:capture-env', async (c) => {
      seen = c.env;
      return { ok: true };
    });
    const flowRow = { id: 'flw_1', siteId: SITE, graph: { entry: 'a', nodes: [{ id: 'a', key: 'test:capture-env' }] } };
    const db = {
      select: () => ({ from: () => ({ where: async () => [flowRow] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Database;
    const cache = { marker: 'cache' } as never;
    await processFlowRunJob(
      db,
      { kind: 'flow', siteId: SITE, runId: 'run_9', flowId: 'flw_1', input: {}, principal: editorRef },
      undefined,
      { DECISION_PROVIDER: 'typesafe' },
      cache,
    );
    expect(seen).toMatchObject({ siteId: SITE, runId: 'run_9', principal: editorRef, cache, processEnv: { DECISION_PROVIDER: 'typesafe' } });
    expect(Object.keys(editorRef)).not.toContain('capabilities');
  });
});
