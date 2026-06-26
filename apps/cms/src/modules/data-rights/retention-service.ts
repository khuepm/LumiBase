/**
 * General data-retention pruning (storage-minimization; GDPR Art. 5(1)(e)).
 *
 * Extends the audit-rotator concept (`modules/audit/rotator.ts`) to other
 * PII-bearing, monotonically-growing tables:
 *   - `activity`      — operation log; pruned past `activityRetentionDays`.
 *   - `notifications` — only already-handled (`read`/`archived`) rows are
 *                       pruned, past `notificationRetentionDays`.
 *
 * Horizons are resolved once at the wiring layer and passed in. A horizon of
 * `0` (or any non-positive value) **disables** pruning for that table — the
 * safe default, so nothing is deleted unless an operator opts in. Best-effort
 * and per-table: a failure on one table is logged and swallowed so the others
 * still run.
 */

import type { Database } from '@lumibase/database';
import { activity, notifications } from '@lumibase/database';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { formatSafeError } from '@lumibase/shared/utils';

export interface RetentionHorizons {
  activityRetentionDays?: number;
  notificationRetentionDays?: number;
}

export interface RetentionServiceDeps extends RetentionHorizons {
  db: Database;
  now?: () => Date;
}

export interface RetentionResult {
  activity: number;
  notifications: number;
}

/** Parse a free-text day count; returns 0 (disabled) for anything invalid. */
export function resolveRetentionDays(raw: string | undefined, max = 3650): number {
  if (raw == null) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > max) return 0;
  return n;
}

export class RetentionService {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly activityDays: number;
  private readonly notificationDays: number;

  constructor(deps: RetentionServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.activityDays = deps.activityRetentionDays ?? 0;
    this.notificationDays = deps.notificationRetentionDays ?? 0;
  }

  private cutoff(days: number): Date {
    return new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
  }

  /** Prune expired rows for a site. Best-effort, per-table. */
  async purge(params: { siteId: string }): Promise<RetentionResult> {
    const result: RetentionResult = { activity: 0, notifications: 0 };

    if (this.activityDays > 0) {
      try {
        const deleted = await this.db
          .delete(activity)
          .where(and(eq(activity.siteId, params.siteId), lt(activity.createdAt, this.cutoff(this.activityDays))))
          .returning({ id: activity.id });
        result.activity = deleted.length;
      } catch (err) {
        console.warn('[retention] activity prune failed', formatSafeError(err));
      }
    }

    if (this.notificationDays > 0) {
      try {
        const deleted = await this.db
          .delete(notifications)
          .where(
            and(
              eq(notifications.siteId, params.siteId),
              inArray(notifications.status, ['read', 'archived']),
              lt(notifications.createdAt, this.cutoff(this.notificationDays)),
            ),
          )
          .returning({ id: notifications.id });
        result.notifications = deleted.length;
      } catch (err) {
        console.warn('[retention] notifications prune failed', formatSafeError(err));
      }
    }

    return result;
  }
}
