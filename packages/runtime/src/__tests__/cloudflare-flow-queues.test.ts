import { describe, expect, it, vi } from 'vitest';
import { createCloudflareRuntime } from '../adapters/cloudflare';

/**
 * B118: the Flows queues have dedicated producer bindings on Workers. Business
 * code enqueues on the logical names `flow-runs` / `flow-events`; without this
 * mapping `supportsQueue` was false and `enqueue` threw `Queue binding not found`.
 */
const binding = () => ({ send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) });

describe('Cloudflare logical Flows queue routing (B118)', () => {
  it.each([
    ['flow-runs', 'FLOW_RUNS_QUEUE', 'flow:run'],
    ['flow-events', 'FLOW_EVENTS_QUEUE', 'flow:event'],
  ] as const)('routes %s jobs to %s only', async (logical, bindingName, jobName) => {
    const target = binding(); const agent = binding(); const realtime = binding(); const other = binding();
    const otherName = bindingName === 'FLOW_RUNS_QUEUE' ? 'FLOW_EVENTS_QUEUE' : 'FLOW_RUNS_QUEUE';
    const runtime = createCloudflareRuntime({
      REALTIME_QUEUE: realtime, AGENT_RUNS_QUEUE: agent, [bindingName]: target, [otherName]: other,
    });
    expect(runtime.queue.supportsQueue?.(logical)).toBe(true);
    const data = { siteId: 'site-a', flowId: 'flow-1' };
    const id = await runtime.queue.enqueue(logical, jobName, data);
    expect(target.send).toHaveBeenCalledWith({ id, jobName, data, options: undefined }, expect.anything());
    for (const untouched of [agent, realtime, other]) expect(untouched.send).not.toHaveBeenCalled();
  });

  it('reports the Flows queues as missing when only other queues are bound', async () => {
    const runtime = createCloudflareRuntime({ AGENT_RUNS_QUEUE: binding(), REALTIME_QUEUE: binding() });
    expect(runtime.queue.supportsQueue?.('flow-runs')).toBe(false);
    expect(runtime.queue.supportsQueue?.('flow-events')).toBe(false);
    await expect(runtime.queue.enqueue('flow-runs', 'flow:run', {})).rejects.toThrow('Queue binding not found: flow-runs');
  });

  it('adds the dedicated bindings alongside a legacy QUEUES map', async () => {
    const legacy = binding(); const runs = binding(); const events = binding();
    const runtime = createCloudflareRuntime({ QUEUES: { legacy }, FLOW_RUNS_QUEUE: runs, FLOW_EVENTS_QUEUE: events });
    await runtime.queue.enqueue('legacy', 'test', {});
    await runtime.queue.enqueue('flow-runs', 'flow:run', {});
    await runtime.queue.enqueue('flow-events', 'flow:scheduled', {});
    expect(legacy.send).toHaveBeenCalledOnce();
    expect(runs.send).toHaveBeenCalledOnce();
    expect(events.send).toHaveBeenCalledOnce();
  });
});
