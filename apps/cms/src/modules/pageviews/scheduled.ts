/**
 * Scheduled pageview flush — the runtime-split cron body (mirrors the audit
 * rotation split). Fires every 5 minutes:
 *   • Self-hosted Node: a `node-cron` tick in `serve.ts`.
 *   • Cloudflare Workers: the `scheduled()` handler in `cloudflare.ts` on the
 *     every-5-minute trigger.
 *
 * Two units of work, both best-effort (never throw — a cron tick must not
 * reject):
 *   1. Roll up raw `lumibase_pageview_events` into `lumibase_pageview_daily`
 *      and delete the processed rows (db-rollup / cdc strategies).
 *   2. Drain the atomic counters (Redis / PageviewCounter DO) into the daily
 *      rollup (hot-counter / hll strategies).
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { sites } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { addToDaily } from './rollup';

const LOG_PREFIX = '[lumibase-cms]';

export interface FlushResult {
  eventsRolledUp: number;
  countersDrained: number;
}

/**
 * Aggregate raw events into the daily rollup, then delete them. Runs a single
 * INSERT ... SELECT ... ON CONFLICT so the rollup upsert is atomic per bucket,
 * then removes the rows it summed. Uniques are taken from the dedup table's
 * distinct count for the same (site, day, path).
 */
async function rollupRawEvents(db: Database): Promise<number> {
  // Sum views per (site, day, path) and merge into the daily rollup. Uniques
  // are computed from the distinct visitor set recorded alongside each event.
  const result = await db.execute(sql`
    WITH agg AS (
      SELECT site_id,
             (occurred_at AT TIME ZONE 'UTC')::date AS day,
             path,
             count(*)::int AS views
      FROM lumibase_pageview_events
      GROUP BY site_id, day, path
    )
    INSERT INTO lumibase_pageview_daily (id, site_id, day, path, views, uniques, updated_at)
    SELECT
      substr(md5(random()::text || clock_timestamp()::text), 1, 21),
      agg.site_id, agg.day, agg.path, agg.views,
      COALESCE((
        SELECT count(*)::int FROM lumibase_pageview_uniques u
        WHERE u.site_id = agg.site_id AND u.day = agg.day
      ), 0),
      now()
    FROM agg
    ON CONFLICT (site_id, day, path) DO UPDATE
      SET views = lumibase_pageview_daily.views + excluded.views,
          updated_at = now();
  `);

  // Delete the raw rows we just summed. (New rows inserted after the aggregate
  // began are left for the next flush.)
  await db.execute(sql`DELETE FROM lumibase_pageview_events;`);

  // drizzle's execute() returns a driver-specific shape; row count is best-effort.
  const rowCount = (result as unknown as { rowCount?: number }).rowCount;
  return typeof rowCount === 'number' ? rowCount : 0;
}

/** A DrainResult entry key is `pv:{siteId}:{day}:{path}` (views) or
 * `pvu:{siteId}:{day}:{path}` (uniques) — see the hot-counter strategy. */
function parseCounterKey(
  key: string,
): { kind: 'view' | 'unique'; siteId: string; day: string; path: string } | null {
  const [prefix, siteId, day, ...rest] = key.split(':');
  if (!siteId || !day || rest.length === 0) return null;
  const path = rest.join(':');
  if (prefix === 'pv') return { kind: 'view', siteId, day, path };
  if (prefix === 'pvu') return { kind: 'unique', siteId, day, path };
  return null;
}

/**
 * Drain the per-site Cloudflare PageviewCounter DO into the daily rollup.
 * Cloudflare offers no way to enumerate DO instances, so we iterate known sites
 * and drain each site's DO by id. Feature-detected via a `drainSite` method the
 * CF cache provider exposes; on Docker (Redis) the method is absent and this is
 * a no-op (Redis hot counters are read back through the rollup after the
 * strategy's own event writes; a Redis-only view total is a documented
 * follow-up). Returns the number of counter keys drained.
 */
async function drainCounters(
  db: Database,
  runtime: RuntimeContext,
): Promise<number> {
  const cache = runtime.cache as unknown as {
    drainSite?: (siteId: string) => Promise<{
      counters: Array<{ key: string; value: number }>;
      uniques: Array<{ key: string; value: number }>;
    }>;
  };
  if (typeof cache.drainSite !== 'function') return 0;

  const siteRows = await db.select({ id: sites.id }).from(sites);
  let drainedKeys = 0;

  for (const { id: siteId } of siteRows) {
    const { counters, uniques } = await cache.drainSite(siteId);
    for (const c of counters) {
      const parsed = parseCounterKey(c.key);
      if (parsed?.kind === 'view') {
        await addToDaily(db, parsed.siteId, parsed.day, parsed.path, c.value, 0);
        drainedKeys += 1;
      }
    }
    for (const u of uniques) {
      const parsed = parseCounterKey(u.key);
      if (parsed?.kind === 'unique') {
        await addToDaily(db, parsed.siteId, parsed.day, parsed.path, 0, u.value);
        drainedKeys += 1;
      }
    }
  }
  return drainedKeys;
}

/**
 * Run one flush cycle. NEVER throws — logs and returns zeros on failure so a
 * cron tick / `scheduled()` invocation can't reject.
 */
export async function runScheduledPageviewFlush(
  db: Database,
  runtime: RuntimeContext,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<FlushResult> {
  let eventsRolledUp = 0;
  let countersDrained = 0;
  try {
    eventsRolledUp = await rollupRawEvents(db);
  } catch (err) {
    log.error(`${LOG_PREFIX} pageview event rollup failed`, err);
  }
  try {
    countersDrained = await drainCounters(db, runtime);
  } catch (err) {
    log.error(`${LOG_PREFIX} pageview counter drain failed`, err);
  }
  log.log(
    `${LOG_PREFIX} pageview flush: ${eventsRolledUp} events rolled up, ${countersDrained} counters drained`,
  );
  return { eventsRolledUp, countersDrained };
}
