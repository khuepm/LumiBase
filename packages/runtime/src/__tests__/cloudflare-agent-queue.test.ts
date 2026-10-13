import { describe, expect, it, vi } from 'vitest';
import { createCloudflareRuntime } from '../adapters/cloudflare';

const binding = () => ({ send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) });
describe('Cloudflare logical agent-runs routing', () => {
  it('routes agent jobs to AGENT_RUNS_QUEUE without using the realtime/default queue', async () => {
    const agent = binding(); const realtime = binding();
    const runtime = createCloudflareRuntime({ AGENT_RUNS_QUEUE: agent, REALTIME_QUEUE: realtime });
    expect(runtime.queue.supportsQueue?.('agent-runs')).toBe(true);
    const payload = { siteId: 'a', runId: 'r' };
    await runtime.queue.enqueue('agent-runs', 'execute', payload);
    expect(agent.send).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'execute', data: payload }), expect.anything());
    expect(realtime.send).not.toHaveBeenCalled();
  });
  it('reports missing agent binding even when another queue is configured', () => {
    const runtime = createCloudflareRuntime({ REALTIME_QUEUE: binding() });
    expect(runtime.queue.supportsQueue?.('agent-runs')).toBe(false);
  });
  it('preserves legacy logical maps and allows the dedicated binding alongside them', async () => {
    const legacy = binding(); const agent = binding();
    const runtime = createCloudflareRuntime({ QUEUES: { legacy }, AGENT_RUNS_QUEUE: agent });
    await runtime.queue.enqueue('legacy', 'test', {});
    await runtime.queue.enqueue('agent-runs', 'execute', {});
    expect(legacy.send).toHaveBeenCalledOnce(); expect(agent.send).toHaveBeenCalledOnce();
  });
});
