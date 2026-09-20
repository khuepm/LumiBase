import { auditLog, fieldAccessLog, type Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
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
      this.flushDetached();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushDetached();
      }, AUDIT_BATCH_FLUSH_MS);
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Fire-and-forget flush. Nobody awaits these, so the rejection handler is
   * mandatory — without it a failing INSERT (e.g. an FK violation from a bad
   * `site_id`) becomes an unhandled rejection and takes the process down.
   * Audit logging must never be able to crash request handling.
   */
  private flushDetached(): void {
    this.scheduleFlush().catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.scheduleFlush();
  }

  /**
   * Chain a flush after any in-flight one.
   *
   * The stored `flushing` promise MUST always be settled-or-fulfilled, never
   * rejected: it is both (a) the tail every subsequent flush chains onto and
   * (b) reachable from the fire-and-forget `flushDetached()` path, whose
   * callers have no way to observe it. A rejection stored here would both
   * poison every later flush and surface as an unhandled rejection that kills
   * the process. `runFlush` already logs its own failure, so swallowing here
   * loses no diagnostics.
   *
   * The returned promise still rejects, so `flush()` callers that DO await can
   * observe the error.
   */
  private scheduleFlush(): Promise<void> {
    const next = this.flushing.then(() => this.runFlush());
    this.flushing = next.catch(() => undefined);
    return next;
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

    // Each table is attempted independently so a failure in one cannot cause
    // the other's rows to be retried — and therefore written twice.
    const auditErr = await this.insertWithSalvage(auditLog, auditRows, 'audit_log');
    const fieldErr = await this.insertWithSalvage(fieldAccessLog, fieldRows, 'field_access_log');

    const firstErr = auditErr ?? fieldErr;
    if (firstErr) {
      // Still rethrow: a caller that awaits `flush()` asked to know, and
      // `flushDetached` already contains this for the fire-and-forget path.
      throw firstErr;
    }
  }

  /**
   * Insert a batch, and if the multi-row statement is rejected, retry row by
   * row so that one bad row cannot take the others with it.
   *
   * ## Why this exists (#469)
   *
   * A multi-row INSERT is atomic: one rejected row means **nothing** is written.
   * `withTenant` only shape-checks `X-Lumi-Site`, so a well-formed id for a site
   * that does not exist still becomes the request's `siteId`, and two audit
   * paths write under it (`external_auth_denied`, and the security-guard
   * denials). `audit_log.site_id` has an FK to `sites.id`, so that row is
   * rejected — and it used to erase up to 99 other rows batched alongside it.
   * Those rows are real tenants' denied-access, rejected-upload and failed-auth
   * events: the records most worth keeping. An unauthenticated request could
   * delete them by naming a site that does not exist, and it failed silently.
   *
   * The retry is deliberately only on the failure path. Doing it always would
   * turn the batching this worker exists for into one round trip per row.
   *
   * @returns the first error seen, or undefined when everything was written
   */
  private async insertWithSalvage<T extends Record<string, unknown>>(
    table: typeof auditLog | typeof fieldAccessLog,
    rows: T[],
    label: string,
  ): Promise<unknown> {
    if (rows.length === 0) return undefined;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.db.insert(table as any).values(rows as any);
      return undefined;
    } catch (batchErr) {
      console.error(
        `[audit-log-worker] batch insert failed for ${label}; retrying rows individually`,
        formatSafeError(batchErr),
      );
      if (rows.length === 1) {
        // Nothing to salvage — the single row is the failure.
        return batchErr;
      }

      let firstRowErr: unknown;
      let written = 0;
      const dropped: Array<{ siteId: unknown; event: unknown }> = [];
      for (const row of rows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await this.db.insert(table as any).values(row as any);
          written += 1;
        } catch (rowErr) {
          firstRowErr ??= rowErr;
          // Identify the dropped row without echoing its metadata: an audit
          // entry can carry request detail, and this line goes to plain logs.
          dropped.push({ siteId: row['siteId'], event: row['event'] ?? row['collection'] });
        }
      }
      console.error(
        `[audit-log-worker] ${label}: salvaged ${written}/${rows.length} rows`,
        JSON.stringify({ dropped }),
      );
      return firstRowErr ?? batchErr;
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
