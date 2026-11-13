import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@lumibase/database';
import { createCloudflareRuntime } from '@lumibase/runtime';
import { processCloudflareEnvelopeMigrationQueue, WORKER_MAX_BATCHES } from '../cloudflare-envelope-queue';
import type { Bindings } from '../env';
import { runEnvelopeMigration } from '../services/envelope-migration-worker';

/**
 * Workers consumer for `encryption-envelope-migration` (B131): bounded passes
 * with a continuation, resuming from the cursor persisted in the site setting.
 */

const sent = vi.hoisted(() => [] as unknown[]);

vi.mock('@lumibase/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/database')>();
  return { ...actual, createDb: vi.fn(() => ({ marker: 'db' })) };
});
vi.mock('@lumibase/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumibase/runtime')>();
  return {
    ...actual,
    createCloudflareRuntime: vi.fn((workerEnv: Record<string, unknown>) => ({
      keys: { marker: 'keys' },
      queue: actual.createCloudflareRuntime(workerEnv).queue,
    })),
  };
});
vi.mock('../services/envelope-migration-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/envelope-migration-worker')>();
  return { ...actual, runEnvelopeMigration: vi.fn() };
});

const env = {
  LUMIBASE_ENV: 'production',
  HYPERDRIVE: { connectionString: 'postgres://test.invalid/envelope' } as Hyperdrive,
  ENVELOPE_MIGRATION_QUEUE: { send: vi.fn(async (m: unknown) => void sent.push(m)), sendBatch: vi.fn() } as unknown as Queue,
} as Bindings;

function message(body: unknown, id = 'msg_1') {
  return { id, timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn(), body } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}
function batch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: 'lumibase-encryption-envelope-migration-production',
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as MessageBatch<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
});

describe('encryption-envelope-migration on Workers (B131)', () => {
  it('runs a bounded pass for the job site and acks when the scan is done', async () => {
    vi.mocked(runEnvelopeMigration).mockResolvedValueOnce({ scanned: 10, migrated: 10, done: true });
    const m = message({ id: 'j1', jobName: 'migrate', data: { siteId: 'site_a' } });
    await processCloudflareEnvelopeMigrationQueue(batch([m]), env);
    expect(runEnvelopeMigration).toHaveBeenCalledWith(
      { db: { marker: 'db' }, siteId: 'site_a', keyProvider: { marker: 'keys' } },
      { maxBatches: WORKER_MAX_BATCHES },
    );
    expect(createDb).toHaveBeenCalledWith(env.HYPERDRIVE!.connectionString);
    expect(sent).toHaveLength(0);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('enqueues a continuation for the same site when the scan is not done', async () => {
    vi.mocked(runEnvelopeMigration).mockResolvedValueOnce({ scanned: 5000, migrated: 5000, done: false });
    const m = message({ id: 'j1', jobName: 'migrate', data: { siteId: 'site_a' } });
    await processCloudflareEnvelopeMigrationQueue(batch([m]), env);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ jobName: 'migrate', data: { siteId: 'site_a' } });
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('retries a failing or malformed message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runEnvelopeMigration).mockRejectedValueOnce(new Error('kms down'));
    const failing = message({ id: 'j1', jobName: 'migrate', data: { siteId: 'site_a' } }, 'm1');
    const malformed = message({ id: 'j2', jobName: 'migrate', data: {} }, 'm2');
    await processCloudflareEnvelopeMigrationQueue(batch([failing, malformed]), env);
    expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(malformed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(failing.ack).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('acks a health probe without opening the database', async () => {
    const probe = message({ id: 'h', jobName: 'health_check', data: { ts: 1 } });
    await processCloudflareEnvelopeMigrationQueue(batch([probe]), env);
    expect(probe.ack).toHaveBeenCalledOnce();
    expect(createCloudflareRuntime).not.toHaveBeenCalled();
  });
});
