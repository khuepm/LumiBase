import { pageviewEvents, pageviewUniques } from '@lumibase/database';
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from '../strategy';
import { dayKey } from '../strategy';
import { readStats } from '../rollup';

/**
 * Default strategy — durable and runtime-agnostic. Each hit writes a raw event
 * row and records the visitor in the daily-uniques dedup set. The scheduled
 * flush aggregates raw events into `lumibase_pageview_daily`; reads come from
 * that rollup.
 */
export class DbRollupStrategy implements PageviewStrategy {
  readonly name = 'db-rollup' as const;

  constructor(private readonly deps: StrategyDeps) {}

  async recordHit(siteId: string, ctx: HitContext): Promise<void> {
    const day = dayKey(ctx.occurredAt);
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
    // Dedup set for exact daily uniques; ignore repeat visitors within the day.
    await this.deps.db
      .insert(pageviewUniques)
      .values({ siteId, day, visitorHash: ctx.visitorHash })
      .onConflictDoNothing({
        target: [
          pageviewUniques.siteId,
          pageviewUniques.day,
          pageviewUniques.visitorHash,
        ],
      });
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    return readStats(this.deps.db, siteId, range);
  }
}
