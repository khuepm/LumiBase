import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@lumibase/database';
import { createCloudflareRuntime } from '@lumibase/runtime';
import { processCloudflareContentIndexingQueue, processCloudflareRevalidationQueue } from '../cloudflare-content-queue';
import type { Bindings } from '../env';
import { searchSnapshotHash } from '../services/content-indexing-worker';
import { dispatchRevalidation } from '../services/revalidation';

/**
 * Cloudflare Workers consumers for `content-indexing` and
 * `revalidation-dispatch` (B131). The handlers run the SAME registration code
 * Docker runs (`registerContentIndexingWorker`, `registerRevalidationWorker`)
 * on a real `CloudflareQueueProvider`; only the search provider, the database
 * and the outbound revalidation call are fakes.
 */

const search = vi.hoisted(() => ({
  configureIndex: vi.fn(async () => {}),
  index: vi.fn(async (_index: string, _docs: unknown[]) => {}),
  delete: vi.fn(async () => {}),
}));
const fake = vi.hoisted(() => ({
  settingsRows: [] as Array<{ value: unknown }>,
  /** The item row the indexing consumer re-reads (`null`: hard-deleted / unknown). */
  itemRows: [] as Array<{ data: unknown; deletedAt: Date | null }>,
}));

vi.mock('@lumibase/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/database')>();
  return { ...actual, createDb: vi.fn() };
});
vi.mock('@lumibase/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/runtime')>();
  return {
    ...actual,
    createCloudflareRuntime: vi.fn((workerEnv: Record<string, unknown>) => ({
      search,
      queue: actual.createCloudflareRuntime(workerEnv).queue,
    })),
  };
});
vi.mock('../services/revalidation', () => ({
  parseTargets: (raw: unknown) => (Array.isArray(raw) ? raw : []),
  dispatchRevalidation: vi.fn(async () => []),
}));

function fakeDb(): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => fake.settingsRows,
        innerJoin: () => ({ where: () => ({ limit: async () => fake.itemRows }) }),
      }),
    }),
  } as unknown as Database;
}

const env: Bindings = {
  LUMIBASE_ENV: 'production',
  HYPERDRIVE: { connectionString: 'postgres://test.invalid/content-queue' } as Hyperdrive,
  MEILISEARCH_HOST: 'https://search.test.invalid',
  CONTENT_INDEXING_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
  REVALIDATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
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
const INDEXING = 'lumibase-content-indexing-production';
const REVALIDATION = 'lumibase-revalidation-dispatch-production';

beforeEach(() => {
  vi.clearAllMocks();
  // Drop queued one-shot failures a test left unconsumed.
  for (const fn of [search.configureIndex, search.index, search.delete]) fn.mockReset().mockImplementation(async () => {});
  vi.mocked(createDb).mockImplementation(() => fakeDb() as never);
  fake.settingsRows = [];
  fake.itemRows = [];
});

describe('content-indexing on Workers (B131)', () => {
  it('indexes into the tenant index and removes from it, then acks each message', async () => {
    fake.itemRows = [{ data: { title: 'Hello' }, deletedAt: null }];
    const index = message({ id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: { title: 'Hello' } } }, 'm1');
    const remove = message({ id: 'j2', jobName: 'search:remove', data: { siteId: 'site_a', collection: 'posts', id: 'p2' } }, 'm2');
    await processCloudflareContentIndexingQueue(batch(INDEXING, [index, remove]), env);
    expect(search.index).toHaveBeenCalledOnce();
    expect(search.index.mock.calls[0]![0]).toBe('site_a__posts');
    expect(search.delete).toHaveBeenCalledWith('site_a__posts', ['p2']);
    expect(index.ack).toHaveBeenCalledOnce();
    expect(remove.ack).toHaveBeenCalledOnce();
  });

  it('configures each index once per isolate, not once per batch (#863)', async () => {
    // Live item rows: the consumer re-reads the item before indexing (#857).
    fake.itemRows = [{ data: { title: 'x' }, deletedAt: null }];
    const job = (id: string) => ({ id, jobName: 'search:index', data: { siteId: 'site_863', collection: 'posts', id, data: { title: 'x' } } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [message(job('a'), 'm1')]), env);
    await processCloudflareContentIndexingQueue(batch(INDEXING, [message(job('b'), 'm2')]), env);
    const configuredFor863 = search.configureIndex.mock.calls.filter((call: unknown[]) => call[0] === 'site_863__posts');
    expect(configuredFor863).toHaveLength(1);
    expect(search.index).toHaveBeenCalledTimes(2);
  });

  it('retries a failing or malformed message without logging its body, and keeps going', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.itemRows = [{ data: { title: 'secret-title' }, deletedAt: null }];
    search.index.mockRejectedValueOnce(new Error('meili down'));
    const failing = message({ id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: { title: 'secret-title' } } }, 'm1');
    const malformed = message({ id: 'j2', jobName: 'search:index', data: { collection: 'posts' } }, 'm2');
    const ok = message({ id: 'j3', jobName: 'search:remove', data: { siteId: 'site_a', collection: 'posts', id: 'p3' } }, 'm3');
    await processCloudflareContentIndexingQueue(batch(INDEXING, [failing, malformed, ok]), env);
    expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(malformed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-title');
    log.mockRestore();
  });

  it('acks without indexing when search is not configured', async () => {
    const m = message({ id: 'j1', jobName: 'search:remove', data: { siteId: 'site_a', collection: 'posts', id: 'p1' } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [m]), { ...env, MEILISEARCH_HOST: '' } as Bindings);
    expect(search.delete).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
    expect(createCloudflareRuntime).not.toHaveBeenCalled();
  });

  it('acks a health probe without building providers', async () => {
    const probe = message({ id: 'h', jobName: 'health_check', data: { ts: 1 } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [probe]), env);
    expect(probe.ack).toHaveBeenCalledOnce();
    expect(createCloudflareRuntime).not.toHaveBeenCalled();
  });
});

describe('content-indexing never applies a stale snapshot on retry (#857)', () => {
  const v1 = { title: 'v1' };
  const v2 = { title: 'v2' };

  it('a retried search:index after search:remove does not resurrect the deleted item', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const indexJob = { id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: v1, dataHash: await searchSnapshotHash(v1) } };
    const removeJob = { id: 'j2', jobName: 'search:remove', data: { siteId: 'site_a', collection: 'posts', id: 'p1' } };

    // Batch 1: the item is already soft-deleted; the index write hits a
    // transient 5xx and is retried, the later remove succeeds.
    fake.itemRows = [{ data: v1, deletedAt: new Date() }];
    search.index.mockRejectedValueOnce(new Error('meili 503'));
    search.delete.mockRejectedValueOnce(new Error('meili 503'));
    const first = message(indexJob, 'm1');
    const remove = message(removeJob, 'm2');
    await processCloudflareContentIndexingQueue(batch(INDEXING, [first, remove]), env);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(remove.ack).toHaveBeenCalledOnce();

    // 30 s later the retry is delivered again.
    vi.clearAllMocks();
    const retried = message(indexJob, 'm1');
    await processCloudflareContentIndexingQueue(batch(INDEXING, [retried]), env);
    expect(search.index).not.toHaveBeenCalled();
    expect(search.delete).toHaveBeenCalledWith('site_a__posts', ['p1']);
    expect(retried.ack).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('a retried search:index for a hard-deleted item removes instead of indexing', async () => {
    fake.itemRows = [];
    const retried = message({ id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: v1, dataHash: await searchSnapshotHash(v1) } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [retried]), env);
    expect(search.index).not.toHaveBeenCalled();
    expect(search.delete).toHaveBeenCalledWith('site_a__posts', ['p1']);
    expect(retried.ack).toHaveBeenCalledOnce();
  });

  it('retrying v1 after v2 was applied leaves v2 in the index', async () => {
    // The row already holds v2 (and v2's own job has been applied).
    fake.itemRows = [{ data: v2, deletedAt: null }];
    const retriedV1 = message({ id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: v1, dataHash: await searchSnapshotHash(v1) } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [retriedV1]), env);
    expect(search.index).not.toHaveBeenCalled();
    expect(search.delete).not.toHaveBeenCalled();
    expect(retriedV1.ack).toHaveBeenCalledOnce();
  });

  it('a legacy hash-less job retried after an upgrade does not overwrite a newer update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Enqueued before the upgrade (no dataHash) with v1; v2 has been written since.
    fake.itemRows = [{ data: v2, deletedAt: null }];
    const legacyV1 = message({ id: 'j1', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: v1 } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [legacyV1]), env);
    expect(search.index).not.toHaveBeenCalled();
    expect(legacyV1.ack).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('still applies a snapshot that matches the current row', async () => {
    fake.itemRows = [{ data: v2, deletedAt: null }];
    const current = message({ id: 'j2', jobName: 'search:index', data: { siteId: 'site_a', collection: 'posts', id: 'p1', data: v2, dataHash: await searchSnapshotHash(v2) } });
    await processCloudflareContentIndexingQueue(batch(INDEXING, [current]), env);
    expect(search.index).toHaveBeenCalledOnce();
    expect(search.index.mock.calls[0]![1]).toEqual([expect.objectContaining({ id: 'p1', title: 'v2' })]);
    expect(current.ack).toHaveBeenCalledOnce();
  });

  it('throws before claiming anything when no database is configured', async () => {
    const m = message({ id: 'j1', jobName: 'search:remove', data: { siteId: 'site_a', collection: 'posts', id: 'p1' } });
    const noDb = { ...env, HYPERDRIVE: undefined } as Bindings;
    await expect(processCloudflareContentIndexingQueue(batch(INDEXING, [m]), noDb)).rejects.toThrow('Content indexing queue');
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe('revalidation-dispatch on Workers (B131)', () => {
  it("dispatches the site's targets for the changed collection and acks", async () => {
    fake.settingsRows = [{ value: [{ id: 't1', status: 'active' }] }];
    const m = message({ id: 'j1', jobName: 'dispatch', data: { siteId: 'site_a', collection: 'posts' } });
    await processCloudflareRevalidationQueue(batch(REVALIDATION, [m]), env);
    expect(createDb).toHaveBeenCalledWith(env.HYPERDRIVE!.connectionString);
    expect(dispatchRevalidation).toHaveBeenCalledWith([{ id: 't1', status: 'active' }], ['posts']);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('acks without dispatching when the site has no targets', async () => {
    const m = message({ id: 'j1', jobName: 'dispatch', data: { siteId: 'site_a', collection: 'posts' } });
    await processCloudflareRevalidationQueue(batch(REVALIDATION, [m]), env);
    expect(dispatchRevalidation).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('throws before claiming anything when no database is configured', async () => {
    const m = message({ id: 'j1', jobName: 'dispatch', data: { siteId: 'site_a', collection: 'posts' } });
    const noDb = { ...env, HYPERDRIVE: undefined } as Bindings;
    await expect(processCloudflareRevalidationQueue(batch(REVALIDATION, [m]), noDb)).rejects.toThrow('Revalidation queue');
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});
