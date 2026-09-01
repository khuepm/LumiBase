import type { Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import {
  enqueueAuditJob,
  getAuditLogQueue,
  type FieldAccessLogWriteInput,
} from './worker';

export interface FieldAccessLoggerDeps {
  readonly db: Database;
  readonly siteId: string;
  readonly queue?: QueueProvider;
}

/**
 * Best-effort field-access log writer (Req 11.3). Prefers the shared
 * `audit-log` queue; falls back to a direct INSERT when the queue is
 * unavailable — mirroring {@link AuditLogger}'s fallback chain.
 */
export async function writeFieldAccessLog(deps: FieldAccessLoggerDeps, entry: FieldAccessLogWriteInput): Promise<void> {
  const queue = deps.queue ?? getAuditLogQueue();
  if (queue) {
    try {
      await enqueueAuditJob(queue, {
        kind: 'field_access',
        siteId: deps.siteId,
        entry,
      });
      return;
    } catch {
      // fall through to sync insert
    }
  }

  try {
    const { fieldAccessLog } = await import('@lumibase/database');
    await deps.db.insert(fieldAccessLog).values({
      siteId: deps.siteId,
      collection: entry.collection,
      recordIds: entry.recordIds,
      fields: entry.fields,
      actor: entry.actor,
      action: entry.action,
      requestId: entry.requestId ?? null,
    });
  } catch (err) {
    console.error('[field-access-log] sync fallback failed', err);
  }
}

export type { FieldAccessLogWriteInput };
