import { getTableName } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, fieldAccessLog } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { AuditLogger } from '../logger';
import {
  AuditLogBatcher,
  AUDIT_BATCH_MAX,
  enqueueAuditJob,
  pushAuditJobForTest,
  setAuditLogQueue,
} from '../worker';
import { writeFieldAccessLog } from '../field-access';

function makeBatchDb() {
  const rows: Array<{ table: string; rows: Record<string, unknown>[] }> = [];

  const db = {
    insert(table: unknown) {
      const name = getTableName(table as never);
      return {
        values: (batch: Record<string, unknown> | Record<string, unknown>[]) => {
          const list = Array.isArray(batch) ? batch : [batch];
          rows.push({ table: name, rows: list });
          return Promise.resolve();
        },
      };
    },
  };

  return { db: db as never, rows };
}

function makeQueue(failing = false): QueueProvider {
  return {
    enqueue: failing
      ? vi.fn().mockRejectedValue(new Error('queue unavailable'))
      : vi.fn().mockResolvedValue('job-1'),
    process: vi.fn(),
    getStatus: vi.fn().mockResolvedValue(null),
  };
}

describe('audit-log async worker (task 12.1 / 12.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setAuditLogQueue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    setAuditLogQueue(undefined);
  });

  it('flushes 100 enqueued audit events into one multi-row INSERT', async () => {
    const { db, rows } = makeBatchDb();
    const batcher = new AuditLogBatcher(db);

    for (let i = 0; i < AUDIT_BATCH_MAX; i++) {
      pushAuditJobForTest(batcher, {
        kind: 'audit',
        siteId: 'site_1',
        entry: { event: 'login_success', actorEmail: `user${i}@example.com` },
      });
    }

    await batcher.flush();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe(getTableName(auditLog));
    expect(rows[0]!.rows).toHaveLength(100);
    for (const row of rows[0]!.rows) {
      expect(typeof row.id).toBe('string');
      expect((row.id as string).length).toBeGreaterThan(10);
      expect(row.siteId).toBe('site_1');
    }
  });

  it('batches field-access events on the same topic', async () => {
    const { db, rows } = makeBatchDb();
    const batcher = new AuditLogBatcher(db);

    pushAuditJobForTest(batcher, {
      kind: 'field_access',
      siteId: 'site_1',
      entry: {
        collection: 'patients',
        recordIds: ['rec_1'],
        fields: ['ssn'],
        actor: 'dr@example.com',
        action: 'read_decrypted',
      },
    });
    await batcher.flush();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe(getTableName(fieldAccessLog));
    expect(rows[0]!.rows[0]).toMatchObject({
      siteId: 'site_1',
      collection: 'patients',
      action: 'read_decrypted',
    });
  });

  it('flushes on the 1s timer when the batch is smaller than 100', async () => {
    const { db, rows } = makeBatchDb();
    const batcher = new AuditLogBatcher(db);

    pushAuditJobForTest(batcher, {
      kind: 'audit',
      siteId: 'site_1',
      entry: { event: 'login_failed' },
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.rows).toHaveLength(1);
  });
});

describe('audit enqueue fallback (task 12.2 / 12.4)', () => {
  it('falls back to synchronous INSERT when enqueue fails', async () => {
    const { db, rows } = makeBatchDb();
    const queue = makeQueue(true);
    setAuditLogQueue(queue);

    const logger = new AuditLogger({ db, siteId: 'site_1', queue });
    await logger.write({ event: 'user_locked', actorEmail: 'a@example.com' });

    expect(queue.enqueue).toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe(getTableName(auditLog));
  });

  it('field-access log sync-fallback writes directly when queue is dead', async () => {
    const { db, rows } = makeBatchDb();
    const queue = makeQueue(true);

    await writeFieldAccessLog(
      { db, siteId: 'site_1', queue },
      {
        collection: 'patients',
        recordIds: ['rec_1'],
        fields: ['diagnosis'],
        actor: 'nurse@example.com',
        action: 'read_decrypted',
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe(getTableName(fieldAccessLog));
  });

  it('AuditLogger prefers enqueue when the queue is healthy', async () => {
    const { db, rows } = makeBatchDb();
    const queue = makeQueue(false);
    setAuditLogQueue(queue);

    const logger = new AuditLogger({ db, siteId: 'site_1' });
    await logger.write({ event: 'setup_completed' });

    expect(queue.enqueue).toHaveBeenCalledWith(
      'audit-log',
      'audit',
      expect.objectContaining({ kind: 'audit', siteId: 'site_1' }),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('enqueueAuditJob', () => {
  it('routes jobs to the audit-log topic', async () => {
    const queue = makeQueue(false);
    await enqueueAuditJob(queue, {
      kind: 'audit',
      siteId: 'site_x',
      entry: { event: 'ip_blocked' },
    });
    expect(queue.enqueue).toHaveBeenCalledWith(
      'audit-log',
      'audit',
      expect.objectContaining({ siteId: 'site_x' }),
    );
  });
});
