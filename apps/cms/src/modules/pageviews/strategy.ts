import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import type { PageviewStrategyName } from '@lumibase/contracts/schemas';

/**
 * Normalised context for a single recorded hit. Built by the service from the
 * request + settings before handing to a strategy. Identity is either an
 * authenticated `userId` or an anonymous `visitorHash` (salted) — never a raw IP.
 */
export interface HitContext {
  path: string;
  userId?: string;
  /** Salted hash used both for anonymous attribution and daily-unique dedup. */
  visitorHash: string;
  referrer?: string;
  userAgent?: string;
  countryCode?: string;
  occurredAt: Date;
}

export interface StatsRange {
  /** Inclusive start day (YYYY-MM-DD). */
  from: string;
  /** Inclusive end day (YYYY-MM-DD). */
  to: string;
  /** Optional path filter. */
  path?: string;
}

export interface PageviewStatsRow {
  day: string;
  path: string;
  views: number;
  uniques: number;
}

export interface PageviewStats {
  totalViews: number;
  totalUniques: number;
  rows: PageviewStatsRow[];
}

/** Dependencies every strategy is constructed with. */
export interface StrategyDeps {
  db: Database;
  runtime: RuntimeContext;
}

/**
 * A pluggable counting approach. `recordHit` is on the hot path (called per
 * request) and must be cheap; `getStats` serves the Studio panel and reads the
 * durable rollup. All four concrete strategies converge on the same read model
 * (`lumibase_pageview_daily`) so the panel is strategy-agnostic.
 */
export interface PageviewStrategy {
  readonly name: PageviewStrategyName;
  recordHit(siteId: string, ctx: HitContext): Promise<void>;
  getStats(siteId: string, range: StatsRange): Promise<PageviewStats>;
}

/** UTC day string (YYYY-MM-DD) for a Date — the rollup bucket key. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
