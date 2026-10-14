/**
 * Retention for draft review runs (Jev J05, #512). Runs carry decision
 * answers about content, so they are not kept forever: the hourly scheduled
 * job (Node cron in `serve.ts`, Cron Trigger in `cloudflare.ts`) deletes runs
 * older than `DECISION_REVIEW_RETENTION_DAYS` (default 180). Feedback is
 * deleted with its run by the foreign key cascade. Profiles are kept.
 */

import { reviewRuns, type Database } from '@lumibase/database';
import { lt } from 'drizzle-orm';

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

/** Deletes runs created before `now - days` on every site. Returns the number of runs deleted. */
export async function purgeExpiredReviewRuns(db: Database, now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const deleted = await db
    .delete(reviewRuns)
    .where(lt(reviewRuns.createdAt, cutoff))
    .returning({ id: reviewRuns.id });
  return deleted.length;
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
