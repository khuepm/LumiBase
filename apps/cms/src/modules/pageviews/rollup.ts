import { and, between, eq, sql } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { pageviewDaily } from '@lumibase/database';
import type { PageviewStats, StatsRange } from './strategy';

/**
 * Shared read model helpers over `lumibase_pageview_daily`. Every strategy
 * converges here so the Studio panel reads one table regardless of how hits
 * were counted.
 */

/** Add `views`/`uniques` deltas to the (site, day, path) rollup row (upsert). */
export async function addToDaily(
  db: Database,
  siteId: string,
  day: string,
  path: string,
  views: number,
  uniques: number,
): Promise<void> {
  await db
    .insert(pageviewDaily)
    .values({ siteId, day, path, views, uniques })
    .onConflictDoUpdate({
      target: [pageviewDaily.siteId, pageviewDaily.day, pageviewDaily.path],
      set: {
        views: sql`${pageviewDaily.views} + ${views}`,
        uniques: sql`${pageviewDaily.uniques} + ${uniques}`,
        updatedAt: sql`now()`,
      },
    });
}

/** Set (not add) the uniques count for a (site, day, path) — used when the
 * unique total is computed exactly from a distinct set rather than accumulated. */
export async function setDailyUniques(
  db: Database,
  siteId: string,
  day: string,
  path: string,
  uniques: number,
): Promise<void> {
  await db
    .insert(pageviewDaily)
    .values({ siteId, day, path, uniques })
    .onConflictDoUpdate({
      target: [pageviewDaily.siteId, pageviewDaily.day, pageviewDaily.path],
      set: { uniques, updatedAt: sql`now()` },
    });
}

/** Read the rollup for a range, site-scoped, optionally filtered by path. */
export async function readStats(
  db: Database,
  siteId: string,
  range: StatsRange,
): Promise<PageviewStats> {
  const where = range.path
    ? and(
        eq(pageviewDaily.siteId, siteId),
        eq(pageviewDaily.path, range.path),
        between(pageviewDaily.day, range.from, range.to),
      )
    : and(
        eq(pageviewDaily.siteId, siteId),
        between(pageviewDaily.day, range.from, range.to),
      );

  const rows = await db
    .select({
      day: pageviewDaily.day,
      path: pageviewDaily.path,
      views: pageviewDaily.views,
      uniques: pageviewDaily.uniques,
    })
    .from(pageviewDaily)
    .where(where);

  let totalViews = 0;
  let totalUniques = 0;
  for (const r of rows) {
    totalViews += r.views;
    totalUniques += r.uniques;
  }
  return { totalViews, totalUniques, rows };
}
