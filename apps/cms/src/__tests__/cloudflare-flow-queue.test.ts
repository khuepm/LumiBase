import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@lumibase/database';
import { createCloudflareRuntime } from '@lumibase/runtime';
import { processCloudflareFlowEventsQueue, processCloudflareFlowRunsQueue } from '../cloudflare-flow-queue';
import type { Bindings } from '../env';
import { executeAiChatRun } from '../services/ai-chat-run-worker';
import { aiDecisionRuntimeFromEnv, runAiDecisionNode } from '../services/flow-ai-decision';
import { registerHandler, type FlowNode } from '../services/flow-service';
import { decisionHarness, editorRef, PROFILE_KEY, SITE } from './helpers/flow-decision-harness';

/**
 * Cloudflare Workers consumers for the Flows queues (B118). The handlers run
 * the SAME registration code Docker runs (`registerFlowRunsWorker`,
 * `registerFlowEventWorker`) on a real `CloudflareQueueProvider`, so the job
 * reaches the shared processing functions with the providers built from the
 * Worker env. Only the database and the non-queue providers are fakes.
 */

const fake = vi.hoisted(() => ({
  failNextUpdate: false,
  inserted: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@lumibase/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/database')>();
  return { ...actual, createDb: vi.fn() };
});
vi.mock('@lumibase/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/runtime')>();
  return {
    ...actual,
    // The queue provider is the REAL Cloudflare one built from the Worker env;
    // the other providers are markers so the test can check they are passed on.
    createCloudflareRuntime: vi.fn((workerEnv: Record<string, unknown>) => ({
      cache: { marker: 'cache' },
      search: { marker: 'search' },
      storage: { marker: 'storage' },
      keys: { marker: 'keys' },
      queue: actual.createCloudflareRuntime(workerEnv).queue,
    })),
  };
});
vi.mock('../services/ai-chat-run-worker', () => ({ executeAiChatRun: vi.fn(async () => {}) }));

const CAPTURE = 'test:cf-flow-capture';
const DECIDE = 'test:cf-flow-decision';
const seen: Array<Record<string, unknown>> = [];
registerHandler(CAPTURE, async (c) => {
  seen.push(c.env);
  return { ok: true };
});

let flowGraph: { entry: string; nodes: FlowNode[] } = { entry: 'a', nodes: [{ id: 'a', key: CAPTURE }] };

function fakeDb(): Database {
  return {
    select: () => ({ from: () => ({ where: async () => [{ id: 'flw_1', siteId: SITE, status: 'active', graph: flowGraph }] }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        fake.inserted.push(v);
        return { returning: async () => [{ id: `run_${fake.inserted.length}`, ...v }] };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        if (fake.failNextUpdate) {
          fake.failNextUpdate = false;
          throw new Error('db down');
        }
        fake.updates.push(set);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
}

const env: Bindings = {
  LUMIBASE_ENV: 'production',
  HYPERDRIVE: { connectionString: 'postgres://test.invalid/flow-queue' } as Hyperdrive,
  ENCRYPTION_KEY: 'enc-test-only',
  DECISION_PROVIDER: 'typesafe',
  FLOW_RUNS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
} as Bindings;

function message(body: unknown, id = 'msg_1') {
  return { id, timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn(), body } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}
function batch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
  return { queue, messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() } as MessageBatch<unknown>;
}
const RUNS = 'lumibase-flow-runs-production';
const EVENTS = 'lumibase-flow-events-production';
function flowRun(siteId: string, runId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `env_${runId}`,
    jobName: 'flow:run',
    data: { kind: 'flow', siteId, runId, flowId: 'flw_1', input: { secret: 'top-secret-input' }, principal: { ...editorRef, siteId }, ...extra },
  };
}
const runtimeOf = () => vi.mocked(createCloudflareRuntime).mock.results.at(-1)!.value as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createDb).mockImplementation(() => fakeDb() as never);
  seen.length = 0;
  fake.inserted.length = 0;
  fake.updates.length = 0;
  fake.failNextUpdate = false;
  flowGraph = { entry: 'a', nodes: [{ id: 'a', key: CAPTURE }] };
});

describe('flow-runs on Workers (B118)', () => {
  it('runs a manual flow with the job principal, the runtime cache/keys and string-only provider env', async () => {
    const m = message(flowRun(SITE, 'run_a'));
    await processCloudflareFlowRunsQueue(batch(RUNS, [m]), env);
    const runtime = runtimeOf();
    expect(createDb).toHaveBeenCalledWith(env.HYPERDRIVE!.connectionString);
    expect(seen).toHaveLength(1);
    const runEnv = seen[0]!;
    expect(runEnv).toMatchObject({ siteId: SITE, runId: 'run_a', principal: editorRef });
    expect(runEnv['cache']).toBe(runtime['cache']);
    expect(runEnv['keys']).toBe(runtime['keys']);
    const processEnv = runEnv['processEnv'] as Record<string, unknown>;
    expect(processEnv).toMatchObject({ DECISION_PROVIDER: 'typesafe', ENCRYPTION_KEY: 'enc-test-only', LUMIBASE_ENV: 'production' });
    expect(processEnv).not.toHaveProperty('HYPERDRIVE');
    expect(processEnv).not.toHaveProperty('FLOW_RUNS_QUEUE');
    expect(Object.values(processEnv).every((v) => typeof v === 'string')).toBe(true);
    expect(Object.keys(runEnv['principal'] as object)).not.toContain('capabilities');
    // markRunRunning → persistRunOutcome, as on Docker.
    expect(fake.updates.map((u) => u['status'])).toEqual(['running', 'success']);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('builds the J10 decision runtime from the Workers env and runs ai:decision for the job principal', async () => {
    const h = await decisionHarness();
    h.upstream.answers.spam = { type: 'noul', noul: 0.99 };
    const options = { profileKey: PROFILE_KEY, profileVersion: 1, collection: 'posts', questionKey: 'spam', noulThreshold: 0.8 };
    const decisionNode: FlowNode = { id: 'decide', key: DECIDE, options, branches: { true: 'yes', false: null, unknown: null, error: null } };
    let built: { siteId: string; db: unknown } | null = null;
    registerHandler(DECIDE, async (c, opts, node) => {
      // The production runtime builds from this env (db + siteId + cache + keys + processEnv).
      const fromEnv = aiDecisionRuntimeFromEnv(c.env);
      built = { siteId: fromEnv.siteId, db: fromEnv.db };
      // The harness swaps only the edges (store, provider), not the governed path.
      return runAiDecisionNode(c, opts, node, h.runtime);
    });
    flowGraph = { entry: 'decide', nodes: [decisionNode, { id: 'yes', key: CAPTURE }] };
    const m = message(flowRun(SITE, 'run_d', { input: { itemId: 'itm_1' } }));
    await processCloudflareFlowRunsQueue(batch(RUNS, [m]), env);
    expect(built).toMatchObject({ siteId: SITE });
    expect(built!.db).toBe(vi.mocked(createDb).mock.results.at(-1)!.value);
    expect(h.provider.provider.decide).toHaveBeenCalledOnce();
    // The `true` branch ran.
    expect(seen).toHaveLength(1);
    expect(fake.updates.at(-1)?.['status']).toBe('success');
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('routes ai:chat to the shared chat executor with the same providers as Docker', async () => {
    const data = { kind: 'ai_chat', siteId: SITE, runId: 'run_c', conversationId: 'conv_1', message: 'hello', principal: editorRef, userId: 'usr_editor' };
    const m = message({ id: 'env_c', jobName: 'ai:chat', data });
    await processCloudflareFlowRunsQueue(batch(RUNS, [m]), env);
    const runtime = runtimeOf();
    expect(executeAiChatRun).toHaveBeenCalledWith(
      vi.mocked(createDb).mock.results.at(-1)!.value,
      data,
      runtime['keys'],
      expect.objectContaining({ ENCRYPTION_KEY: 'enc-test-only', DECISION_PROVIDER: 'typesafe' }),
      runtime['cache'],
    );
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('keeps each tenant of a batch on its own siteId', async () => {
    const a = message(flowRun('site-a', 'run_a'), 'a');
    const b = message(flowRun('site-b', 'run_b'), 'b');
    await processCloudflareFlowRunsQueue(batch(RUNS, [a, b]), env);
    expect(seen.map((e) => [e['siteId'], e['runId'], (e['principal'] as { siteId: string }).siteId])).toEqual([
      ['site-a', 'run_a', 'site-a'],
      ['site-b', 'run_b', 'site-b'],
    ]);
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
  });

  it('retries only the failed message and never logs bodies or credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failNextUpdate = true;
    const bad = message(flowRun(SITE, 'run_bad'), 'bad');
    const good = message(flowRun(SITE, 'run_good'), 'good');
    await processCloudflareFlowRunsQueue(batch(RUNS, [bad, good]), env);
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(bad.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalledOnce();
    expect(good.retry).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('bad');
    expect(logged).not.toContain('top-secret-input');
    expect(logged).not.toContain('enc-test-only');
    log.mockRestore();
  });

  it('retries malformed or foreign envelopes without executing them', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrongJob = message({ ...flowRun(SITE, 'r1'), jobName: 'execute' }, 'w');
    const noSite = flowRun(SITE, 'r2') as { data: Record<string, unknown> };
    delete noSite.data['siteId'];
    const missing = message(noSite, 'm');
    await processCloudflareFlowRunsQueue(batch(RUNS, [wrongJob, missing]), env);
    expect(seen).toHaveLength(0);
    expect(wrongJob.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(missing.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    log.mockRestore();
  });

  it('acknowledges the shared health probe without opening the database', async () => {
    const health = message({ id: 'h', jobName: 'health_check', data: { ts: Date.now() } });
    await processCloudflareFlowRunsQueue(batch(RUNS, [health]), { LUMIBASE_ENV: 'development' });
    expect(health.ack).toHaveBeenCalledOnce();
    expect(createDb).not.toHaveBeenCalled();
  });

  it('fails before claiming anything without a production database; development accepts DATABASE_URL', async () => {
    const m = message(flowRun(SITE, 'run_x'));
    await expect(
      processCloudflareFlowRunsQueue(batch(RUNS, [m]), { LUMIBASE_ENV: 'production', DATABASE_URL: 'postgres://local/test' }),
    ).rejects.toThrow('HYPERDRIVE');
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    await processCloudflareFlowRunsQueue(batch(RUNS, [m]), { LUMIBASE_ENV: 'development', DATABASE_URL: 'postgres://local/test' });
    expect(createDb).toHaveBeenCalledWith('postgres://local/test');
    expect(m.ack).toHaveBeenCalledOnce();
  });
});

describe('flow-events on Workers (B118)', () => {
  it('runs a scheduled flow for the payload site with cache, keys and provider env, and no principal', async () => {
    const m = message({
      id: 'env_s',
      jobName: 'flow:scheduled',
      data: { siteId: 'site-b', flowId: 'flw_1', input: { trigger: 'schedule', scheduledAt: '2026-10-16T00:00:00.000Z' } },
    });
    await processCloudflareFlowEventsQueue(batch(EVENTS, [m]), env);
    const runtime = runtimeOf();
    expect(fake.inserted).toEqual([expect.objectContaining({ siteId: 'site-b', flowId: 'flw_1', status: 'running' })]);
    const runEnv = seen[0]!;
    expect(runEnv['siteId']).toBe('site-b');
    expect(runEnv['cache']).toBe(runtime['cache']);
    expect(runEnv['keys']).toBe(runtime['keys']);
    expect(runEnv['processEnv']).toMatchObject({ DECISION_PROVIDER: 'typesafe' });
    expect(runEnv['principal']).toBeUndefined();
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('runs an event-triggered flow with the item event as input', async () => {
    const event = { collection: 'posts', action: 'update', itemId: 'itm_1', payload: { title: 'x' } };
    const m = message({ id: 'env_e', jobName: 'flow:event', data: { siteId: SITE, flowId: 'flw_1', event } });
    await processCloudflareFlowEventsQueue(batch(EVENTS, [m]), env);
    expect(fake.inserted[0]).toMatchObject({ siteId: SITE, input: { event } });
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('retries an envelope meant for another queue', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = message(flowRun(SITE, 'run_wrong'));
    await processCloudflareFlowEventsQueue(batch(EVENTS, [m]), env);
    expect(seen).toHaveLength(0);
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    log.mockRestore();
  });
});
