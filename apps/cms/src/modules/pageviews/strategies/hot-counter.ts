import type { UniqueCounterProvider } from '@lumibase/runtime';
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from '../strategy';
import { dayKey } from '../strategy';
import { readStats } from '../rollup';

/** TTL guards against counters lingering if a flush window is ever missed. */
const COUNTER_TTL_S = 2 * 24 * 60 * 60;

/**
 * Counter key layout (also parsed by the flush job's drain):
 *   pv:{siteId}:{day}:{path}   → view count
 *   pvu:{siteId}:{day}:{path}  → unique visitor set (HLL / DO set)
 * The siteId is the 2nd segment so the Cloudflare cache provider can address
 * the per-site PageviewCounter DO.
 */
export function viewKey(siteId: string, day: string, path: string): string {
  return `pv:${siteId}:${day}:${path}`;
}
export function uniqueKey(siteId: string, day: string, path: string): string {
  return `pvu:${siteId}:${day}:${path}`;
}

/**
 * Hot-counter strategy — increments atomic counters in the runtime cache (Redis
 * INCRBY on Docker, PageviewCounter Durable Object on Cloudflare) on the hot
 * path; the scheduled flush drains them into the daily rollup. Reads come from
 * the rollup, so freshly-counted-but-unflushed hits appear after the next
 * 5-minute flush (accepted staleness).
 */
export class HotCounterStrategy implements PageviewStrategy {
  readonly name = 'hot-counter' as const;

  constructor(private readonly deps: StrategyDeps) {}

  async recordHit(siteId: string, ctx: HitContext): Promise<void> {
    const day = dayKey(ctx.occurredAt);
    const cache = this.deps.runtime.cache;
    await cache.increment(viewKey(siteId, day, ctx.path), 1, { ttl: COUNTER_TTL_S });
    // Uniques only when the provider supports a cardinality set; otherwise the
    // flush job backfills exact uniques from the DB dedup table.
    if (hasUniqueCounter(cache)) {
      await cache.addUnique(uniqueKey(siteId, day, ctx.path), ctx.visitorHash, {
        ttl: COUNTER_TTL_S,
      });
    }
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    return readStats(this.deps.db, siteId, range);
  }
}

/** Feature-detect the optional unique-cardinality capability. */
export function hasUniqueCounter(
  cache: unknown,
): cache is UniqueCounterProvider {
  return (
    typeof cache === 'object' &&
    cache !== null &&
    typeof (cache as UniqueCounterProvider).addUnique === 'function'
  );
}
