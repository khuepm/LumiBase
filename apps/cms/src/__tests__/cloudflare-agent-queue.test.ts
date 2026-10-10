import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@lumibase/database';
import { createCloudflareRuntime } from '@lumibase/runtime';
import { processCloudflareAgentQueue } from '../cloudflare-agent-queue';
import { processAgentRunJob } from '../services/agent-run-worker';
import type { Bindings } from '../env';

vi.mock('@lumibase/database', () => ({ createDb: vi.fn(() => ({ marker: 'db' })) }));
vi.mock('@lumibase/runtime', () => ({ createCloudflareRuntime: vi.fn(() => ({
  cache: { marker: 'cache' }, search: { marker: 'search' }, queue: { marker: 'queue' }, keys: { marker: 'keys' },
})) }));
vi.mock('../services/agent-run-worker', () => ({ processAgentRunJob: vi.fn() }));

const env: Bindings = {
  LUMIBASE_ENV: 'production',
  HYPERDRIVE: { connectionString: 'postgres://test.invalid/queue-test' } as Hyperdrive,
  ENCRYPTION_KEY: 'test-only',
};
function message(siteId: string, runId: string) {
  return {
    id: runId, timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn(),
    body: { id: runId, jobName: 'execute', data: {
      siteId, runId, goalId: `goal-${runId}`, skillName: 'listCollections', arguments: {},
      principal: { type: 'user', siteId, userId: `user-${siteId}` },
      budget: { maxToolCalls: 1 }, autonomyCap: 1, origin: 'user',
    } },
  };
}
function batch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return { queue: 'lumibase-agent-runs-production', messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(processAgentRunJob).mockReset();
});

describe('Cloudflare agent queue entrypoint (B10)', () => {
  it('awaits each job with tenant/governance intact and all runtime providers', async () => {
    const a = message('site-a', 'run-a'); const b = message('site-b', 'run-b');
    vi.mocked(processAgentRunJob).mockImplementation(async (_deps, payload) => {
      expect(payload.siteId === 'site-a' ? a.ack : b.ack).not.toHaveBeenCalled();
    });
    await processCloudflareAgentQueue(batch([a, b]), env);
    const runtime = vi.mocked(createCloudflareRuntime).mock.results[0]!.value;
    expect(createDb).toHaveBeenCalledWith(env.HYPERDRIVE!.connectionString);
    for (const job of [a, b]) {
      expect(processAgentRunJob).toHaveBeenCalledWith({ db: { marker: 'db' }, cache: runtime.cache,
        search: runtime.search, queue: runtime.queue, keys: runtime.keys,
        env: { LUMIBASE_ENV: 'production', ENCRYPTION_KEY: 'test-only' },
      }, job.body.data);
      expect(job.ack).toHaveBeenCalledOnce(); expect(job.retry).not.toHaveBeenCalled();
    }
  });
  it('retries only the failed message and continues the batch', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = message('site-a', 'bad'); const b = message('site-b', 'good');
    vi.mocked(processAgentRunJob).mockRejectedValueOnce(new Error('transient provider failure'));
    await processCloudflareAgentQueue(batch([a, b]), env);
    expect(a.retry).toHaveBeenCalledWith({ delaySeconds: 30 }); expect(a.ack).not.toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalledOnce(); expect(b.retry).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-only');
    log.mockRestore();
  });
  it('malformed/foreign job envelopes never reach the worker and are retried toward DLQ', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = message('site-a', 'bad'); bad.body.jobName = 'different-job';
    await processCloudflareAgentQueue(batch([bad]), env);
    expect(processAgentRunJob).not.toHaveBeenCalled(); expect(bad.retry).toHaveBeenCalledOnce();
    log.mockRestore();
  });
  it('missing production DB fails before claiming anything; development accepts DATABASE_URL', async () => {
    const job = message('site-a', 'a');
    await expect(processCloudflareAgentQueue(batch([job]), { LUMIBASE_ENV: 'production', DATABASE_URL: 'postgres://local/test' })).rejects.toThrow('HYPERDRIVE');
    expect(processAgentRunJob).not.toHaveBeenCalled(); expect(job.ack).not.toHaveBeenCalled();
    await processCloudflareAgentQueue(batch([job]), { LUMIBASE_ENV: 'development', DATABASE_URL: 'postgres://local/test' });
    expect(createDb).toHaveBeenCalledWith('postgres://local/test');
  });
  it('acknowledges the shared health probe without opening the database or running a skill', async () => {
    const health = { ...message('site-a', 'health'), body: { id: 'health', jobName: 'health_check', data: { ts: Date.now() } } };
    await processCloudflareAgentQueue(batch([health]), { LUMIBASE_ENV: 'development' });
    expect(health.ack).toHaveBeenCalledOnce(); expect(health.retry).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled(); expect(processAgentRunJob).not.toHaveBeenCalled();
  });
  it('Worker exports the handler and every deployment profile pairs its producer/consumer', () => {
    const root = resolve(import.meta.dirname, '../..');
    const entry = readFileSync(resolve(root, 'src/cloudflare.ts'), 'utf8');
    expect(entry).toContain('queue: processCloudflareAgentQueue');
    expect(entry).toContain('sweepStaleRuns({ db })');
    const config = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');
    for (const name of ['local', 'staging', 'production', 'dev', 'demo']) {
      const prefix = name === 'local' ? '' : `env.${name}.`;
      const queue = `lumibase-agent-runs-${name}`;
      expect(config).toContain(`[[${prefix}queues.producers]]\nbinding = "AGENT_RUNS_QUEUE"\nqueue = "${queue}"`);
      expect(config).toContain(`[[${prefix}queues.consumers]]\nqueue = "${queue}"`);
      expect(config).toContain(`dead_letter_queue = "${queue}-dlq"`);
    }
  });
});
