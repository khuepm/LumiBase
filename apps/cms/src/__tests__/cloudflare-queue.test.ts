import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import { processCloudflareAgentQueue } from '../cloudflare-agent-queue';
import { processCloudflareFlowEventsQueue, processCloudflareFlowRunsQueue } from '../cloudflare-flow-queue';
import { processCloudflareQueue, resolveLogicalQueue, WORKER_QUEUE_CONSUMERS } from '../cloudflare-queue';
import type { Bindings } from '../env';

/** Worker `queue()` dispatcher (B118): strict routing by physical queue name. */

vi.mock('../cloudflare-agent-queue', () => ({ processCloudflareAgentQueue: vi.fn(async () => {}) }));
vi.mock('../cloudflare-flow-queue', () => ({
  processCloudflareFlowRunsQueue: vi.fn(async () => {}),
  processCloudflareFlowEventsQueue: vi.fn(async () => {}),
}));

const PROFILES = ['local', 'staging', 'production', 'dev', 'demo'];
const LOGICAL = Object.keys(WORKER_QUEUE_CONSUMERS) as Array<keyof typeof WORKER_QUEUE_CONSUMERS>;
const env = { LUMIBASE_ENV: 'production' } as Bindings;

function message(body: unknown, id = 'm1') {
  return { id, timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn(), body } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}
function batch(queue: string, messages: Message<unknown>[] = [message({ id: 'x', jobName: 'flow:run', data: {} })]): MessageBatch<unknown> {
  return { queue, messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() } as MessageBatch<unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('resolveLogicalQueue', () => {
  it.each(LOGICAL.flatMap((logical) => PROFILES.map((profile) => [`lumibase-${logical}-${profile}`, logical])))(
    '%s → %s',
    (name, logical) => {
      expect(resolveLogicalQueue(name)).toBe(logical);
    },
  );

  it.each(['lumibase-flow-runs-production-dlq', 'lumibase-agent-runs-local-dlq', 'lumibase-realtime', 'other', 'flow-runner', ''])(
    '%s has no consumer',
    (name) => {
      expect(resolveLogicalQueue(name)).toBeNull();
    },
  );

  it('maps every profile-suffixed name to its logical queue and every DLQ to none', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LOGICAL), fc.stringMatching(/^[a-z0-9]{1,12}$/), fc.boolean(), (logical, suffix, prefixed) => {
        const name = `${prefixed ? 'lumibase-' : ''}${logical}-${suffix}`;
        expect(resolveLogicalQueue(name)).toBe(logical);
        expect(resolveLogicalQueue(`${name}-dlq`)).toBeNull();
      }),
    );
  });
});

describe('processCloudflareQueue routing', () => {
  const handlers = {
    'agent-runs': processCloudflareAgentQueue,
    'flow-runs': processCloudflareFlowRunsQueue,
    'flow-events': processCloudflareFlowEventsQueue,
  } as const;

  it.each(LOGICAL)('a %s batch reaches exactly its own handler', async (logical) => {
    const b = batch(`lumibase-${logical}-production`);
    await processCloudflareQueue(b, env);
    for (const [name, handler] of Object.entries(handlers)) {
      if (name === logical) expect(handler).toHaveBeenCalledWith(b, env);
      else expect(handler).not.toHaveBeenCalled();
    }
  });

  it('propagates a handler failure so Cloudflare retries the batch', async () => {
    vi.mocked(processCloudflareFlowRunsQueue).mockRejectedValueOnce(new Error('requires HYPERDRIVE'));
    await expect(processCloudflareQueue(batch('lumibase-flow-runs-dev'), env)).rejects.toThrow('HYPERDRIVE');
  });

  it('acks health probes and retries everything else on a queue with no consumer, without logging bodies', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = message({ id: 'h', jobName: 'health_check', data: { ts: 1 } }, 'h');
    const job = message({ id: 'j', jobName: 'flow:run', data: { secret: 'body-secret' } }, 'j');
    await processCloudflareQueue(batch('lumibase-realtime', [health, job]), env);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    expect(health.ack).toHaveBeenCalledOnce();
    expect(health.retry).not.toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(job.ack).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('lumibase-realtime');
    expect(logged).not.toContain('body-secret');
    log.mockRestore();
  });
});
