import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { QueueProvider, SearchProvider } from '@lumibase/runtime';
import { dispatchItemRevalidation } from '../content-invalidation';
import { ItemService } from '../item-service';
import { dispatchRevalidation } from '../revalidation';

/**
 * B131: on Workers a queue exists as a provider even when the logical queue
 * has no producer binding, and `enqueue` then throws `Queue binding not found`.
 * Before B131 that error was logged and swallowed, so the search index and the
 * ISR targets silently missed every write. Both paths now check
 * `supportsQueue` first and fall back to their inline path.
 */

vi.mock('../revalidation', () => ({
  parseTargets: (raw: unknown) => (Array.isArray(raw) ? raw : []),
  dispatchRevalidation: vi.fn(async () => []),
}));

function queueWithout(missing: string): QueueProvider & { enqueue: ReturnType<typeof vi.fn> } {
  return {
    enqueue: vi.fn(async () => 'job_1'),
    process: vi.fn(),
    getStatus: vi.fn(async () => null),
    supportsQueue: (name: string) => name !== missing,
  } as unknown as QueueProvider & { enqueue: ReturnType<typeof vi.fn> };
}

function settingsDb(rows: Array<{ value: unknown }>): Database {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Database;
}

describe('dispatchItemRevalidation without a revalidation-dispatch binding (B131)', () => {
  it('dispatches inline instead of enqueueing', async () => {
    const queue = queueWithout('revalidation-dispatch');
    const db = settingsDb([{ value: [{ id: 't1', status: 'active' }] }]);
    await dispatchItemRevalidation({ db, queue, siteId: 'site_a', collection: 'posts' });
    await vi.waitFor(() => expect(dispatchRevalidation).toHaveBeenCalledWith([{ id: 't1', status: 'active' }], ['posts']));
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('still enqueues when the binding exists', async () => {
    const queue = queueWithout('other-queue');
    await dispatchItemRevalidation({ db: settingsDb([]), queue, siteId: 'site_a', collection: 'posts' });
    expect(queue.enqueue).toHaveBeenCalledWith('revalidation-dispatch', 'dispatch', { siteId: 'site_a', collection: 'posts' });
  });
});

describe('ItemService search indexing without a content-indexing binding (B131)', () => {
  function service(queue: QueueProvider) {
    const search = { index: vi.fn(async () => {}), delete: vi.fn(async () => {}) } as unknown as SearchProvider & {
      index: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    const svc = new ItemService({ siteId: 'site_a', queue, search } as unknown as ConstructorParameters<typeof ItemService>[0]);
    const internals = svc as unknown as {
      indexItem(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
      deindexItem(collection: string, id: string): Promise<void>;
    };
    return { internals, search };
  }

  it('indexes and de-indexes inline in the tenant index', async () => {
    const queue = queueWithout('content-indexing');
    const { internals, search } = service(queue);
    await internals.indexItem('posts', 'p1', { title: 'Hello' });
    await internals.deindexItem('posts', 'p2');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(search.index.mock.calls[0]![0]).toBe('site_a__posts');
    expect(search.delete).toHaveBeenCalledWith('site_a__posts', ['p2']);
  });

  it('enqueues when the binding exists', async () => {
    const queue = queueWithout('other-queue');
    const { internals, search } = service(queue);
    await internals.indexItem('posts', 'p1', { title: 'Hello' });
    expect(queue.enqueue).toHaveBeenCalledWith('content-indexing', 'search:index', {
      siteId: 'site_a', collection: 'posts', id: 'p1', data: { title: 'Hello' },
    });
    expect(search.index).not.toHaveBeenCalled();
  });
});
