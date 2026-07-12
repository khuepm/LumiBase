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
 * and isolates tenants.
 *
 * Storage is SQLite-backed (`ctx.storage.sql`), which on the free plan requires
 * the `new_sqlite_classes` wrangler migration. State lives here only between
 * flushes: the every-5-minute cron drains it into `lumibase_pageview_daily` (durable),
 * so a DO eviction loses at most one flush window.
 *
 * Internal HTTP protocol (called by the CF counter forwarder):
 *   POST /incr   { key, by }        -> { value }        atomic INCRBY
 *   POST /pfadd  { key, member }    -> { added }        exact set add (dedup)
 *   GET  /count?key=...             -> { value }        distinct members
 *   GET  /drain?prefix=...          -> { counters, uniques }  read-and-reset
 *
 * IMPORTANT: this file imports `cloudflare:workers` and must never be pulled
 * into the Node/Docker bundle (same rule as `realtime/site-room.ts`).
 */

import { DurableObject } from 'cloudflare:workers';

interface IncrBody {
  key: string;
  by?: number;
}
interface PfAddBody {
  key: string;
  member: string;
}
interface DrainResult {
  counters: Array<{ key: string; value: number }>;
  uniques: Array<{ key: string; value: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PageviewCounter extends DurableObject<any> {
  constructor(ctx: DurableObjectState, env: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(ctx, env as any);
    // Create tables once per instance. `IF NOT EXISTS` keeps this idempotent
    // across the DO's lifetime and after hibernation wake-ups.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS uniques (key TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (key, member));`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/incr' && request.method === 'POST') {
      const body = (await request.json()) as IncrBody;
      const by = typeof body.by === 'number' && Number.isFinite(body.by) ? body.by : 1;
      const value = this.increment(body.key, by);
      return Response.json({ value });
    }

    if (url.pathname === '/pfadd' && request.method === 'POST') {
      const body = (await request.json()) as PfAddBody;
      const added = this.addUnique(body.key, body.member);
      return Response.json({ added });
    }

    if (url.pathname === '/count' && request.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      return Response.json({ value: this.countUnique(key) });
    }

    if (url.pathname === '/drain' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      return Response.json(this.drain(prefix));
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Atomic increment. Single-threaded DO execution makes the read-modify-write
   * inside `ON CONFLICT ... DO UPDATE` race-free with respect to other requests
   * to this same instance.
   */
  private increment(key: string, by: number): number {
    const cursor = this.ctx.storage.sql.exec<{ value: number }>(
      `INSERT INTO counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
       RETURNING value;`,
      key,
      by,
    );
    return cursor.one().value;
  }

  /** Exact unique add; returns 1 if the member was new, 0 if already present. */
  private addUnique(key: string, member: string): number {
    const before = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT count(*) AS n FROM uniques WHERE key = ? AND member = ?;`,
      key,
      member,
    ).one().n;
    if (before > 0) return 0;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO uniques (key, member) VALUES (?, ?);`,
      key,
      member,
    );
    return 1;
  }

  private countUnique(key: string): number {
    return this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT count(*) AS n FROM uniques WHERE key = ?;`,
      key,
    ).one().n;
  }

  /**
   * Return all counters and unique-cardinalities whose key starts with `prefix`,
   * then delete them (read-and-reset). The flush job persists the returned
   * values into Postgres; deleting here prevents double-counting on the next
   * flush. An empty prefix drains everything.
   */
  private drain(prefix: string): DrainResult {
    const like = `${prefix}%`;

    const counters = this.ctx.storage.sql
      .exec<{ key: string; value: number }>(
        `SELECT key, value FROM counters WHERE key LIKE ?;`,
        like,
      )
      .toArray();

    const uniqueKeys = this.ctx.storage.sql
      .exec<{ key: string }>(
        `SELECT DISTINCT key FROM uniques WHERE key LIKE ?;`,
        like,
      )
      .toArray();
    const uniques = uniqueKeys.map(({ key }) => ({ key, value: this.countUnique(key) }));

    if (counters.length > 0) {
      this.ctx.storage.sql.exec(`DELETE FROM counters WHERE key LIKE ?;`, like);
    }
    if (uniques.length > 0) {
      this.ctx.storage.sql.exec(`DELETE FROM uniques WHERE key LIKE ?;`, like);
    }

    return { counters, uniques };
  }
}
