/**
 * PageviewCounter — Cloudflare Durable Object providing atomic counters and
 * exact unique-cardinality sets for the pageview module's hot-counter and HLL
 * strategies.
 *
 * Cloudflare KV cannot do atomic increments (get→+1→put races, and KV caps
 * writes near one per second per key), so the hot-counter/HLL strategies route
 * through this DO instead. One DO instance is addressed per site via
 * `idFromName(siteId)` (mirroring the realtime `SiteRoom`), which both bounds a
 * site's counters to a single serialized actor — making increments race-free —
 * and isolates tenants. The same DO also backs every other `increment()` caller
 * for the site (API rate limits, decision quotas); those rely on the counter
 * TTLs the store enforces, not on the pageview drain.
 *
 * Storage is SQLite-backed (`ctx.storage.sql`), which on the free plan requires
 * the `new_sqlite_classes` wrangler migration. Pageview state lives here only
 * between flushes: the every-5-minute cron drains `pv`-prefixed keys into
 * `lumibase_pageview_daily` (durable), so a DO eviction loses at most one flush
 * window. The storage logic and HTTP protocol live in `counter-store.ts`.
 *
 * IMPORTANT: this file imports `cloudflare:workers` and must never be pulled
 * into the Node/Docker bundle (same rule as `realtime/site-room.ts`).
 */
import { DurableObject } from 'cloudflare:workers';
import { CounterStore, handleCounterRequest, type CounterSql } from './counter-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PageviewCounter extends DurableObject<any> {
  private readonly store: CounterStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(ctx, env as any);
    this.store = new CounterStore(this.ctx.storage.sql as unknown as CounterSql);
  }

  async fetch(request: Request): Promise<Response> {
    return handleCounterRequest(this.store, request);
  }
}
