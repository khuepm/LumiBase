/**
 * Site-scoped postgres.js client for the request path (B130,
 * `.kiro/specs/rls-request-scope/` design §3c).
 *
 * `rls-policies.sql` filters rows by `current_setting('app.site_id', true)`.
 * That setting only reaches a query when it is set with `is_local = true`
 * inside the SAME transaction, on the SAME connection, as the query. A
 * standalone `set_config` statement autocommits and its value is gone before
 * the next statement runs (possibly on another pooled connection), which is
 * the bug B130 records.
 *
 * `createSiteScopedSql(base, siteId)` returns a client that drizzle can use in
 * place of `base`. Every statement it runs is wrapped as
 *
 *   BEGIN; SELECT set_config('app.site_id', $1, true); <query>; COMMIT
 *
 * on one reserved connection. The scope and the query are pipelined, so the
 * cost is BEGIN + (scope, query) + COMMIT. Because `is_local = true` dies with
 * the transaction, the scope can never leak to another request through the
 * pool. `begin(cb)` sets the scope before `cb` runs, so every
 * `db.transaction(...)` of a request is scoped too; savepoints inside it use
 * the outer transaction's scope.
 *
 * `siteId` is always sent as a bound parameter, never interpolated into SQL.
 *
 * APIs that would run SQL outside that wrapper (`reserve`, `listen`, `notify`,
 * `subscribe`, `file`, top-level `savepoint`, and the cursor/stream style query
 * methods) throw instead of silently running unscoped. drizzle uses none of
 * them: its postgres-js session only calls `unsafe`, `unsafe().values()`,
 * `begin`, and `savepoint` on the transaction handle.
 *
 * Worker-safe: `postgres` is imported as a type only.
 */
import type postgres from 'postgres';

/** Marker so callers can tell a scoped client from a plain pool. */
export const SITE_SCOPED_SQL: unique symbol = Symbol.for('lumibase.siteScopedSql');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySql = postgres.Sql<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = postgres.TransactionSql<any>;

/** Client APIs that would bypass the per-statement scope. */
const UNSUPPORTED_CLIENT_MEMBERS = new Set([
  'reserve',
  'listen',
  'notify',
  'subscribe',
  'savepoint',
  'file',
]);

/** Query APIs other than `await` / `.values()` (streaming, describe, raw). */
const UNSUPPORTED_QUERY_MEMBERS = ['cursor', 'forEach', 'raw', 'describe', 'simple', 'execute'] as const;

function unsupported(name: string): never {
  throw new Error(
    `SCOPED_SQL_UNSUPPORTED: ${name} is not available on a site-scoped client; ` +
      'it would run SQL outside the app.site_id transaction.',
  );
}

type Mode = 'rows' | 'values';

/**
 * Lazy thenable standing in for a postgres.js `PendingQuery`. Nothing runs
 * until it is awaited, so `.values()` can still switch the result format, as
 * with the real driver.
 */
class ScopedQuery<T = unknown> implements PromiseLike<T> {
  private mode: Mode = 'rows';
  private promise: Promise<T> | undefined;

  constructor(private readonly start: (mode: Mode) => Promise<T>) {
    for (const name of UNSUPPORTED_QUERY_MEMBERS) {
      Object.defineProperty(this, name, { value: () => unsupported(`query.${name}()`) });
    }
  }

  values(): this {
    this.mode = 'values';
    return this;
  }

  private run(): Promise<T> {
    if (!this.promise) this.promise = this.start(this.mode);
    return this.promise;
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }

  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.run().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.run().finally(onFinally);
  }

  get [Symbol.toStringTag](): string {
    return 'ScopedQuery';
  }
}

function setScope(tx: AnyTx, siteId: string) {
  // Tagged template: `siteId` becomes parameter $1, never part of the SQL text.
  return tx`SELECT set_config('app.site_id', ${siteId}, true)`;
}

/**
 * Run `run(tx)` in its own transaction with the scope set first. The scope
 * and the query are started together so they pipeline on the connection; the
 * scope query is created first, so it executes first.
 *
 * The result is boxed because postgres.js `Promise.all`s a callback result
 * that is an Array, which would turn a RowList into a plain array and drop
 * `.count` / `.columns`.
 */
function runScoped<T>(base: AnySql, siteId: string, run: (tx: AnyTx) => PromiseLike<T>): Promise<T> {
  return (
    base.begin(async (tx) => {
      const scope = setScope(tx, siteId);
      const query = run(tx);
      const [, r] = await Promise.all([scope, query]);
      return { r };
    }) as unknown as Promise<{ r: T }>
  ).then((box) => box.r);
}

/**
 * Wrap `base` so that every statement and transaction runs with
 * `app.site_id = siteId`. See the file header.
 */
export function createSiteScopedSql<S extends AnySql>(base: S, siteId: string): S {
  if (typeof siteId !== 'string' || siteId.length === 0) {
    throw new Error('createSiteScopedSql: siteId must be a non-empty string');
  }

  const unsafe = (query: string, params?: unknown[], options?: unknown) =>
    new ScopedQuery((mode) =>
      runScoped(base, siteId, (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q = (tx.unsafe as any)(query, params, options);
        return mode === 'values' ? q.values() : q;
      }),
    );

  const begin = (optionsOrCb: unknown, maybeCb?: unknown) => {
    const hasOptions = typeof optionsOrCb !== 'function';
    const cb = (hasOptions ? maybeCb : optionsOrCb) as (tx: AnyTx) => unknown;
    if (typeof cb !== 'function') throw new TypeError('begin: a callback is required');
    const scoped = async (tx: AnyTx) => {
      await setScope(tx, siteId);
      const x = cb(tx);
      // Same contract as postgres.js: an Array result is awaited element-wise.
      return Array.isArray(x) ? Promise.all(x) : x;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = base.begin as any;
    return hasOptions ? b(optionsOrCb, scoped) : b(scoped);
  };

  // The target must be callable for the `apply` trap (tagged-template calls).
  const target = function siteScopedSql() {} as unknown as S;

  return new Proxy(target, {
    apply(_t, _this, args: unknown[]) {
      const [first, ...rest] = args;
      // Tagged template `sql\`...\`` → a scoped query. Any other call is a
      // helper (`sql('identifier')`, `sql(rows, 'col')`) that builds a
      // fragment and runs nothing, so it goes to the base client.
      if (Array.isArray(first) && Array.isArray((first as { raw?: unknown }).raw)) {
        return new ScopedQuery((mode) =>
          runScoped(base, siteId, (tx) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const q = (tx as any)(first, ...rest);
            return mode === 'values' ? q.values() : q;
          }),
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (base as any)(...args);
    },
    get(_t, prop) {
      if (prop === SITE_SCOPED_SQL) return siteId;
      if (prop === 'unsafe') return unsafe;
      if (prop === 'begin') return begin;
      if (typeof prop === 'string' && UNSUPPORTED_CLIENT_MEMBERS.has(prop)) {
        return () => unsupported(`sql.${prop}()`);
      }
      return Reflect.get(base, prop);
    },
    set(_t, prop, value) {
      return Reflect.set(base, prop, value);
    },
    has(_t, prop) {
      return prop === SITE_SCOPED_SQL || Reflect.has(base, prop);
    },
  });
}

/** True when `x` is a client returned by `createSiteScopedSql`. */
export function isSiteScopedSql(x: unknown): boolean {
  return (
    (typeof x === 'function' || (typeof x === 'object' && x !== null)) &&
    typeof (x as Record<symbol, unknown>)[SITE_SCOPED_SQL] === 'string'
  );
}

/** The site a scoped client is bound to, or `undefined` for a plain client. */
export function scopedSiteIdOf(x: unknown): string | undefined {
  if (!isSiteScopedSql(x)) return undefined;
  return (x as Record<symbol, string>)[SITE_SCOPED_SQL];
}
