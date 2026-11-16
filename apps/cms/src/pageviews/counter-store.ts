/**
 * Storage logic for the `PageviewCounter` Durable Object, kept free of
 * `cloudflare:workers` so it can run under Node tests against any SQLite that
 * matches {@link CounterSql}.
 *
 * Counters carry an optional `expires_at` (epoch ms). Like Redis
 * `INCRBY` + `EXPIRE NX`, the window is armed when a key is created and never
 * extended by later increments; an increment on an expired key starts a fresh
 * window. Expired rows are pruned on every increment and drain, so windowed keys
 * (`rl:`, `dq:`, `pv:`) cannot accumulate in the DO.
 */

/** Cursor subset shared by `ctx.storage.sql.exec` and the test adapter. */
export interface CounterSqlCursor<T> {
  one(): T;
  toArray(): T[];
}

/** Minimal `SqlStorage` surface the store needs. */
export interface CounterSql {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): CounterSqlCursor<T>;
}

export interface DrainResult {
  counters: Array<{ key: string; value: number }>;
  uniques: Array<{ key: string; value: number }>;
}

export class CounterStore {
  constructor(
    private readonly sql: CounterSql,
    private readonly now: () => number = Date.now,
  ) {
    // `IF NOT EXISTS` keeps this idempotent across the DO's lifetime and after
    // hibernation wake-ups.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS uniques (key TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (key, member));`,
    );
    // DOs created before counters had an expiry lack the column. Legacy rows
    // keep `NULL` until their next TTL-carrying increment arms a window.
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(counters);`).toArray();
    if (!columns.some((column) => column.name === 'expires_at')) {
      this.sql.exec(`ALTER TABLE counters ADD COLUMN expires_at INTEGER;`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS counters_expires_at ON counters (expires_at);`);
  }

  /**
   * Atomic increment. Single-threaded DO execution makes the read-modify-write
   * inside `ON CONFLICT ... DO UPDATE` race-free with respect to other requests
   * to this same instance.
   */
  increment(key: string, by: number, ttlSeconds?: number): number {
    const now = this.now();
    this.pruneExpired(now);
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
    // Expired rows were just pruned, so a conflict is always a live window:
    // add to it and arm an expiry only if the row has none yet.
    return this.sql
      .exec<{ value: number }>(
        `INSERT INTO counters (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = value + excluded.value,
           expires_at = COALESCE(expires_at, excluded.expires_at)
         RETURNING value;`,
        key,
        by,
        expiresAt,
      )
      .one().value;
  }

  /** Exact unique add; returns 1 if the member was new, 0 if already present. */
  addUnique(key: string, member: string): number {
    const before = this.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM uniques WHERE key = ? AND member = ?;`, key, member)
      .one().n;
    if (before > 0) return 0;
    this.sql.exec(`INSERT OR IGNORE INTO uniques (key, member) VALUES (?, ?);`, key, member);
    return 1;
  }

  countUnique(key: string): number {
    return this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM uniques WHERE key = ?;`, key).one().n;
  }

  /**
   * Return all live counters and unique-cardinalities whose key starts with
   * `prefix`, then delete them (read-and-reset). The flush job persists the
   * returned values into Postgres; deleting here prevents double-counting on
   * the next flush. An empty prefix drains everything.
   */
  drain(prefix: string): DrainResult {
    this.pruneExpired(this.now());
    const like = `${prefix}%`;
    const counters = this.sql
      .exec<{ key: string; value: number }>(`SELECT key, value FROM counters WHERE key LIKE ?;`, like)
      .toArray()
      .map(({ key, value }) => ({ key, value }));
    const uniqueKeys = this.sql
      .exec<{ key: string }>(`SELECT DISTINCT key FROM uniques WHERE key LIKE ?;`, like)
      .toArray();
    const uniques = uniqueKeys.map(({ key }) => ({ key, value: this.countUnique(key) }));
    if (counters.length > 0) {
      this.sql.exec(`DELETE FROM counters WHERE key LIKE ?;`, like);
    }
    if (uniques.length > 0) {
      this.sql.exec(`DELETE FROM uniques WHERE key LIKE ?;`, like);
    }
    return { counters, uniques };
  }

  /** Number of counter rows currently stored, expired or not. */
  counterRows(): number {
    return this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM counters;`).one().n;
  }

  private pruneExpired(now: number): void {
    this.sql.exec(`DELETE FROM counters WHERE expires_at IS NOT NULL AND expires_at <= ?;`, now);
  }
}

interface IncrBody {
  key: string;
  by?: number;
  ttl?: number;
}

interface PfAddBody {
  key: string;
  member: string;
}

/**
 * Internal HTTP protocol (called by the CF counter forwarder):
 *   POST /incr   { key, by, ttl? }  -> { value }        atomic INCRBY (+ EXPIRE NX)
 *   POST /pfadd  { key, member }    -> { added }        exact set add (dedup)
 *   GET  /count?key=...             -> { value }        distinct members
 *   GET  /drain?prefix=...          -> { counters, uniques }  read-and-reset
 */
export async function handleCounterRequest(store: CounterStore, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/incr' && request.method === 'POST') {
    const body = (await request.json()) as IncrBody;
    const by = typeof body.by === 'number' && Number.isFinite(body.by) ? body.by : 1;
    const ttl = typeof body.ttl === 'number' && Number.isFinite(body.ttl) && body.ttl > 0 ? body.ttl : undefined;
    return Response.json({ value: store.increment(body.key, by, ttl) });
  }
  if (url.pathname === '/pfadd' && request.method === 'POST') {
    const body = (await request.json()) as PfAddBody;
    return Response.json({ added: store.addUnique(body.key, body.member) });
  }
  if (url.pathname === '/count' && request.method === 'GET') {
    return Response.json({ value: store.countUnique(url.searchParams.get('key') ?? '') });
  }
  if (url.pathname === '/drain' && request.method === 'GET') {
    return Response.json(store.drain(url.searchParams.get('prefix') ?? ''));
  }
  return new Response('Not found', { status: 404 });
}
