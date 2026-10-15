/**
 * Retention for draft review runs (Jev J05, #512). Runs carry decision
 * answers about content, so they are not kept forever: the hourly scheduled
 * job (Node cron in `serve.ts`, Cron Trigger in `cloudflare.ts`) deletes runs
 * older than `DECISION_REVIEW_RETENTION_DAYS` (default 180). Feedback is
 * deleted with its run by the foreign key cascade. Profiles are kept.
 *
 * The review tables are under the `site_isolation` RLS policy
 * (`packages/database/migrations/rls-policies.sql`), so a DELETE without
 * `app.site_id` would remove nothing on a deployment that applied it. The
 * purge therefore runs one transaction per site with that site's scope set
 * (`runSiteTransaction`), and every DELETE also filters by `site_id`.
 * `lumibase_sites` itself is not under RLS, so listing sites works unscoped.
 */

import { reviewRuns, sites, type Database } from '@lumibase/database';
import { and, eq, lt } from 'drizzle-orm';
import { runSiteTransaction } from './rls-transaction';

export const DEFAULT_REVIEW_RETENTION_DAYS = 180;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const DAY_MS = 86_400_000;

/** Empty or invalid → the default; out of range → the default. Never throws. */
export function resolveReviewRetentionDays(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_REVIEW_RETENTION_DAYS;
  const days = Number.parseInt(trimmed, 10);
  return days >= MIN_DAYS && days <= MAX_DAYS ? days : DEFAULT_REVIEW_RETENTION_DAYS;
}

/**
 * Deletes runs created before `now - days`, site by site, each in its own
 * RLS-scoped transaction. Returns the number of runs deleted.
 */
export async function purgeExpiredReviewRuns(db: Database, now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const siteRows = await db.select({ id: sites.id }).from(sites);
  let total = 0;
  for (const { id: siteId } of siteRows) {
    const deleted = await runSiteTransaction(db, siteId, (tx) =>
      tx
        .delete(reviewRuns)
        .where(and(eq(reviewRuns.siteId, siteId), lt(reviewRuns.createdAt, cutoff)))
        .returning({ id: reviewRuns.id }),
    );
    total += deleted.length;
  }
  return total;
}

/** Scheduled wrapper. NEVER throws: a cron tick must not surface a runtime error. */
export async function runScheduledReviewRunPurge(
  db: Database,
  retentionDays: string | undefined,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<{ deleted: number }> {
  try {
    const deleted = await purgeExpiredReviewRuns(db, new Date(), resolveReviewRetentionDays(retentionDays));
    log.log(`[lumibase-cms] review-run retention removed ${deleted} expired run(s).`);
    return { deleted };
  } catch (err) {
    log.error('[lumibase-cms] review-run retention failed:', err);
    return { deleted: 0 };
  }
}
