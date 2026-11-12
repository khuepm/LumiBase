import { describe, expect, it, vi } from 'vitest';
import { createCloudflareRuntime } from '../adapters/cloudflare';

/**
 * B131: search indexing and ISR revalidation have dedicated producer bindings
 * on Workers. Business code enqueues on the logical names `content-indexing` /
 * `revalidation-dispatch`; without this mapping `enqueue` threw `Queue binding
 * not found` on every item write and neither job ever ran.
 */
const binding = () => ({ send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) });

describe('Cloudflare logical content queue routing (B131)', () => {
  it.each([
    ['content-indexing', 'CONTENT_INDEXING_QUEUE', 'search:index'],
    ['revalidation-dispatch', 'REVALIDATION_QUEUE', 'dispatch'],
  ] as const)('routes %s jobs to %s only', async (logical, bindingName, jobName) => {
    const target = binding(); const flows = binding(); const other = binding();
    const otherName = bindingName === 'CONTENT_INDEXING_QUEUE' ? 'REVALIDATION_QUEUE' : 'CONTENT_INDEXING_QUEUE';
    const runtime = createCloudflareRuntime({ FLOW_RUNS_QUEUE: flows, [bindingName]: target, [otherName]: other });
    expect(runtime.queue.supportsQueue?.(logical)).toBe(true);
    const data = { siteId: 'site-a', collection: 'posts' };
    const id = await runtime.queue.enqueue(logical, jobName, data);
    expect(target.send).toHaveBeenCalledWith({ id, jobName, data, options: undefined }, expect.anything());
    for (const untouched of [flows, other]) expect(untouched.send).not.toHaveBeenCalled();
  });

  it('reports the content queues as missing when they are not bound', () => {
    const runtime = createCloudflareRuntime({ FLOW_RUNS_QUEUE: binding() });
    expect(runtime.queue.supportsQueue?.('content-indexing')).toBe(false);
    expect(runtime.queue.supportsQueue?.('revalidation-dispatch')).toBe(false);
  });
});
