import { auditLog, fieldAccessLog, type Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/shared/utils';
import { v7 as uuidv7 } from 'uuid';
import type { AuditLogWriteInput } from './logger';

/**
 * Async audit-log worker (high-load-cache-readiness design §7; Req 11.1).
 *
 * Consumes the `audit-log` queue, batches up to 100 events or 1s (whichever
 * comes first), and flushes with multi-row INSERT. Audit ids use uuidv7 for
 * time-orderable audit-grade rows.
 */

export const AUDIT_LOG_QUEUE = 'audit-log';

export const AUDIT_BATCH_MAX = 100;
export const AUDIT_BATCH_FLUSH_MS = 1000;

/** Field-access log row input (regulated-content-readiness Req 6). */
export interface FieldAccessLogWriteInput {
  readonly collection: string;
  readonly recordIds: string[];
  readonly fields: string[];
  readonly actor: string | null;
  readonly action: string;
  readonly requestId?: string | null;
}

export type AuditQueueJob =
  | { readonly kind: 'audit'; readonly siteId: string; readonly entry: AuditLogWriteInput }
  | {
      readonly kind: 'field_access';
      readonly siteId: string;
      readonly entry: FieldAccessLogWriteInput;
    };

export interface AuditLogWorkerDeps {
  readonly db: Database;
  readonly queue?: QueueProvider;
}

let sharedAuditQueue: QueueProvider | undefined;

/** Wire the process-wide queue used by {@link AuditLogger} when no per-call queue is passed. */
export function setAuditLogQueue(queue: QueueProvider | undefined): void {
  sharedAuditQueue = queue;
}

export function getAuditLogQueue(): QueueProvider | undefined {
  return sharedAuditQueue;
}

export async function enqueueAuditJob(
  queue: QueueProvider,
  job: AuditQueueJob,
): Promise<void> {
  await queue.enqueue(AUDIT_LOG_QUEUE, job.kind, job);
}

/**
 * In-process batch accumulator shared by the queue consumer. Each job is
 * appended; flush runs on size (100) or after 1s idle.
 */
export class AuditLogBatcher {
  private buffer: AuditQueueJob[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database) {}

  push(job: AuditQueueJob): void {
    this.buffer.push(job);
    if (this.buffer.length >= AUDIT_BATCH_MAX) {
      void this.scheduleFlush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.scheduleFlush();
      }, AUDIT_BATCH_FLUSH_MS);
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  async flush(): Promise<void> {
    await this.scheduleFlush();
  }

  private scheduleFlush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.runFlush());
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;

    const auditRows = batch
      .filter((j): j is Extract<AuditQueueJob, { kind: 'audit' }> => j.kind === 'audit')
      .map((j) => ({
        id: uuidv7(),
        siteId: j.siteId,
        event: j.entry.event,
        actorEmail: j.entry.actorEmail ?? null,
        targetEmail: j.entry.targetEmail ?? null,
        ip: j.entry.ip ?? null,
        userAgent: j.entry.userAgent ?? null,
        countryCode: j.entry.countryCode ?? null,
        metadata: j.entry.metadata ?? {},
        requestId: j.entry.requestId ?? null,
      }));

    const fieldRows = batch
      .filter((j): j is Extract<AuditQueueJob, { kind: 'field_access' }> => j.kind === 'field_access')
      .map((j) => ({
        id: uuidv7(),
        siteId: j.siteId,
        collection: j.entry.collection,
        recordIds: j.entry.recordIds,
        fields: j.entry.fields,
        actor: j.entry.actor,
        action: j.entry.action,
        requestId: j.entry.requestId ?? null,
      }));

    try {
      if (auditRows.length > 0) {
        await this.db.insert(auditLog).values(auditRows);
      }
      if (fieldRows.length > 0) {
        await this.db.insert(fieldAccessLog).values(fieldRows);
      }
    } catch (err) {
      console.error('[audit-log-worker] batch insert failed', formatSafeError(err));
      throw err;
    }
  }
}

export function registerAuditLogWorker(deps: AuditLogWorkerDeps): AuditLogBatcher | undefined {
  const { db, queue } = deps;
  if (!queue) return undefined;

  setAuditLogQueue(queue);
  const batcher = new AuditLogBatcher(db);

  queue.process<AuditQueueJob>(AUDIT_LOG_QUEUE, async (job) => {
    batcher.push(job.data);
  });

  return batcher;
}

/** Test hook: process one job synchronously without the queue transport. */
export function pushAuditJobForTest(batcher: AuditLogBatcher, job: AuditQueueJob): void {
  batcher.push(job);
}
