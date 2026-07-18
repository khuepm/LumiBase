import { nanoid } from 'nanoid';
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from '../strategy';
import { DbRollupStrategy } from './db-rollup';

/** Queue the pageview change feed is emitted on (consumed by CDC pipelines). */
const PAGEVIEW_CDC_QUEUE = 'pageview-cdc';

/**
 * Shape mirrors `CdcChangeEvent` from the CDC module's cache-invalidator so
 * downstream connectors (Debezium/ClickHouse) see a familiar envelope. We do
 * not import that type to avoid coupling the pageview module to the CDC module.
 */
interface PageviewChangeEvent {
  table: 'lumibase_pageview_events';
  recordId: string;
  operation: 'INSERT';
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * CDC strategy — emits a change event per hit for an external pipeline to
 * aggregate (e.g. in ClickHouse), AND writes the local daily rollup so the
 * Studio panel still has a read model without a ClickHouse read client
 * (per the product decision: panel reads local rollup, ClickHouse is external).
 *
 * Delegates the durable-write half to {@link DbRollupStrategy} to avoid
 * duplicating the event + uniques writes.
 */
export class CdcEventStrategy implements PageviewStrategy {
  readonly name = 'cdc' as const;

  private readonly local: DbRollupStrategy;

  constructor(private readonly deps: StrategyDeps) {
    this.local = new DbRollupStrategy(deps);
  }

  async recordHit(siteId: string, ctx: HitContext): Promise<void> {
    // Keep the local read model current.
    await this.local.recordHit(siteId, ctx);

    // Best-effort emit to the change feed; never fail the hit on queue error.
    const event: PageviewChangeEvent = {
      table: 'lumibase_pageview_events',
      recordId: nanoid(),
      operation: 'INSERT',
      payload: {
        siteId,
        path: ctx.path,
        userId: ctx.userId ?? null,
        visitorHash: ctx.userId ? null : ctx.visitorHash,
        referrer: ctx.referrer ?? null,
        countryCode: ctx.countryCode ?? null,
        occurredAt: ctx.occurredAt.toISOString(),
      },
      timestamp: ctx.occurredAt.toISOString(),
    };
    try {
      await this.deps.runtime.queue.enqueue(PAGEVIEW_CDC_QUEUE, 'pageview', event);
    } catch (err) {
      console.warn('[pageviews/cdc] change-feed emit failed (non-fatal)', err);
    }
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    return this.local.getStats(siteId, range);
  }
}
