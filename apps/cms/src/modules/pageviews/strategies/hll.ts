import { pageviewEvents } from '@lumibase/database';
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from '../strategy';
import { dayKey } from '../strategy';
import { readStats } from '../rollup';
import { DbRollupStrategy } from './db-rollup';
import { hasUniqueCounter, uniqueKey } from './hot-counter';

const COUNTER_TTL_S = 2 * 24 * 60 * 60;

/**
 * HyperLogLog strategy — approximate unique-visitor counting. Views are counted
 * durably (raw event rows, same as db-rollup); uniques go into a HLL/DO
 * cardinality set (Redis PFADD/PFCOUNT on Docker, PageviewCounter DO set on
 * Cloudflare). When no unique-counter capability is available, it degrades to
 * the exact DB dedup set (via {@link DbRollupStrategy}) so uniques are never
 * silently dropped.
 *
 * The flush job reads the HLL cardinalities and writes them into the daily
 * rollup; reads come from the rollup.
 */
export class HllStrategy implements PageviewStrategy {
  readonly name = 'hll' as const;

  private readonly fallback: DbRollupStrategy;

  constructor(private readonly deps: StrategyDeps) {
    this.fallback = new DbRollupStrategy(deps);
  }

  async recordHit(siteId: string, ctx: HitContext): Promise<void> {
    const cache = this.deps.runtime.cache;
    if (!hasUniqueCounter(cache)) {
      // No approximate-counter backend — use the exact DB dedup path.
      await this.fallback.recordHit(siteId, ctx);
      return;
    }

    const day = dayKey(ctx.occurredAt);
    // Durable view event (uniques handled by the HLL set, not the dedup table).
    await this.deps.db.insert(pageviewEvents).values({
      siteId,
      path: ctx.path,
      userId: ctx.userId ?? null,
      sessionHash: ctx.userId ? null : ctx.visitorHash,
      referrer: ctx.referrer ?? null,
      userAgent: ctx.userAgent ?? null,
      countryCode: ctx.countryCode ?? null,
      occurredAt: ctx.occurredAt,
    });
    await cache.addUnique(uniqueKey(siteId, day, ctx.path), ctx.visitorHash, {
      ttl: COUNTER_TTL_S,
    });
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    return readStats(this.deps.db, siteId, range);
  }
}
