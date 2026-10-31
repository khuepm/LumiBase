import { describe, expect, it } from 'vitest';
import {
  createSiteScopedSql,
  isSiteScopedSql,
  scopedSiteIdOf,
  SITE_SCOPED_SQL,
  unscopedSqlOf,
} from '../scoped-sql';

/**
 * Fake postgres.js client. It records every statement with the transaction
 * handle it ran on, and mimics the parts of the driver the wrapper relies on:
 * lazy queries (run on `then`), `.values()`, `begin(cb)` / `begin(opts, cb)`,
 * and a RowList-like result with `.count` / `.columns`.
 */
interface Event {
  tx: number | 'pool';
  kind: 'begin' | 'commit' | 'rollback' | 'template' | 'unsafe';
  text?: string;
  values?: unknown[];
  mode?: 'rows' | 'values';
  options?: unknown;
}

function makeFakeSql(opts: { failUnsafe?: boolean } = {}) {
  const events: Event[] = [];
  let txSeq = 0;

  function rowList(rows: unknown[]) {
    const list = [...rows] as unknown[] & { count: number; columns: string[] };
    list.count = rows.length;
    list.columns = ['id'];
    return list;
  }

  function lazy(record: () => Event, result: () => unknown) {
    let mode: 'rows' | 'values' = 'rows';
    let p: Promise<unknown> | undefined;
    const run = () => {
      if (!p) {
        p = Promise.resolve().then(() => {
          const e = record();
          e.mode = mode;
          events.push(e);
          if (opts.failUnsafe && e.kind === 'unsafe') throw new Error('boom');
          return result();
        });
      }
      return p;
    };
    const q = {
      values() {
        mode = 'values';
        return q;
      },
      then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => run().then(a, b),
      catch: (b?: (e: unknown) => unknown) => run().catch(b),
    };
    return q;
  }

  function makeTx(id: number) {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      lazy(
        () => ({ tx: id, kind: 'template', text: strings.join('?'), values }),
        () => rowList([]),
      )) as unknown as Record<string, unknown>;
    tx.unsafe = (text: string, values?: unknown[], options?: unknown) =>
      lazy(
        () => ({ tx: id, kind: 'unsafe', text, values, options }),
        () => rowList([{ id: 'r1' }, { id: 'r2' }]),
      );
    tx.savepoint = (cb: (t: unknown) => unknown) => cb(tx);
    return tx;
  }

  const base = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    lazy(
      () => ({ tx: 'pool', kind: 'template', text: strings.join('?'), values }),
      () => rowList([]),
    )) as unknown as Record<string, unknown>;
  base.unsafe = () => {
    throw new Error('unscoped unsafe must not be called');
  };
  base.begin = async (a: unknown, b?: unknown) => {
    const cb = (typeof a === 'function' ? a : b) as (tx: unknown) => unknown;
    const id = ++txSeq;
    events.push({ tx: id, kind: 'begin', options: typeof a === 'function' ? undefined : a });
    const tx = makeTx(id);
    try {
      const x = cb(tx);
      const r = await (Array.isArray(x) ? Promise.all(x) : x);
      events.push({ tx: id, kind: 'commit' });
      return r;
    } catch (e) {
      events.push({ tx: id, kind: 'rollback' });
      throw e;
    }
  };
  base.options = { parsers: {}, serializers: {} };
  base.end = async () => undefined;
  base.reserve = async () => ({});
  base.listen = async () => ({});
  base.notify = async () => ({});
  base.subscribe = async () => ({});
  base.file = () => ({});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { base: base as any, events };
}

type FakeTx = { unsafe: (text: string, values?: unknown[]) => PromiseLike<unknown> };

const SCOPE_TEXT = "SELECT set_config('app.site_id', ?, true)";

describe('createSiteScopedSql', () => {
  it('runs the scope then the query in one transaction on the same handle', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    const rows = await sql.unsafe('select * from t where x = $1', [1]);

    expect(rows).toHaveLength(2);
    expect(events.map((e) => `${e.tx}:${e.kind}`)).toEqual(['1:begin', '1:template', '1:unsafe', '1:commit']);
    expect(events[1]).toMatchObject({ text: SCOPE_TEXT, values: ['site_a'] });
    expect(events[2]).toMatchObject({ text: 'select * from t where x = $1', values: [1], mode: 'rows' });
  });

  it('opens a fresh transaction for every statement', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    await sql.unsafe('select 1', []);
    await sql.unsafe('select 2', []);

    const scopes = events.filter((e) => e.kind === 'template');
    expect(scopes.map((e) => e.tx)).toEqual([1, 2]);
    expect(events.filter((e) => e.kind === 'unsafe').map((e) => e.tx)).toEqual([1, 2]);
  });

  it('supports .values() and forwards query options', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    await sql.unsafe('select 1', [], { prepare: false }).values();

    const q = events.find((e) => e.kind === 'unsafe');
    expect(q).toMatchObject({ mode: 'values', options: { prepare: false } });
  });

  it('preserves RowList .count and .columns', async () => {
    const { base } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    const rows = (await sql.unsafe('select 1', [])) as unknown as { count: number; columns: string[] };

    expect(rows.count).toBe(2);
    expect(rows.columns).toEqual(['id']);
  });

  it('is lazy: nothing runs until the query is awaited', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    const pending = sql.unsafe('select 1', []);
    await Promise.resolve();
    expect(events).toEqual([]);
    await pending;
    expect(events).toHaveLength(4);
  });

  it('begin(cb) sets the scope before the callback runs', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_b');

    const out = await sql.begin(async (tx: FakeTx) => {
      await tx.unsafe('insert into t values ($1)', ['v']);
      return 'done';
    });

    expect(out).toBe('done');
    expect(events.map((e) => `${e.tx}:${e.kind}`)).toEqual(['1:begin', '1:template', '1:unsafe', '1:commit']);
    expect(events[1]).toMatchObject({ text: SCOPE_TEXT, values: ['site_b'] });
  });

  it('begin(options, cb) keeps the options and sets the scope first', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_b');

    await sql.begin('read write', async (tx: FakeTx) => {
      await tx.unsafe('select 1', []);
    });

    expect(events[0]).toMatchObject({ kind: 'begin', options: 'read write' });
    expect(events[1]).toMatchObject({ kind: 'template', values: ['site_b'] });
  });

  it('a tagged-template call runs scoped; a helper call goes to the base client', async () => {
    const { base, events } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    await sql`select ${42}`;
    expect(events.map((e) => `${e.tx}:${e.kind}`)).toEqual(['1:begin', '1:template', '1:template', '1:commit']);
    expect(events[2]).toMatchObject({ text: 'select ?', values: [42] });
  });

  it('never puts the site id in the SQL text', async () => {
    const { base, events } = makeFakeSql();
    const evil = "x' OR '1'='1";
    const sql = createSiteScopedSql(base, evil);

    await sql.unsafe('select 1', []);
    await sql.begin(async () => undefined);

    for (const e of events) {
      if (e.text) expect(e.text).not.toContain(evil);
    }
    expect(events.filter((e) => e.kind === 'template').map((e) => e.values)).toEqual([[evil], [evil]]);
  });

  it('rejects when the inner query fails, and rolls back', async () => {
    const { base, events } = makeFakeSql({ failUnsafe: true });
    const sql = createSiteScopedSql(base, 'site_a');

    await expect(sql.unsafe('select 1', [])).rejects.toThrow('boom');
    expect(events.at(-1)).toMatchObject({ kind: 'rollback' });
  });

  it('throws for client APIs that would bypass the scope', () => {
    const { base } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a') as unknown as Record<string, () => unknown>;

    for (const name of ['reserve', 'listen', 'notify', 'subscribe', 'savepoint', 'file']) {
      expect(() => sql[name]!(), name).toThrow(/SCOPED_SQL_UNSUPPORTED/);
    }
  });

  it('throws for streaming query APIs', () => {
    const { base } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');
    const q = sql.unsafe('select 1', []) as unknown as Record<string, () => unknown>;

    for (const name of ['cursor', 'forEach', 'raw', 'describe', 'simple', 'execute']) {
      expect(() => q[name]!(), name).toThrow(/SCOPED_SQL_UNSUPPORTED/);
    }
  });

  it('forwards other members (options, end) to the base client', () => {
    const { base } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    expect(sql.options).toBe(base.options);
    expect(sql.end).toBe(base.end);
  });

  it('rejects an empty or non-string site id', () => {
    const { base } = makeFakeSql();
    expect(() => createSiteScopedSql(base, '')).toThrow(/non-empty/);
    expect(() => createSiteScopedSql(base, undefined as unknown as string)).toThrow(/non-empty/);
  });

  it('is detectable and reports its site', () => {
    const { base } = makeFakeSql();
    const sql = createSiteScopedSql(base, 'site_a');

    expect(isSiteScopedSql(sql)).toBe(true);
    expect(scopedSiteIdOf(sql)).toBe('site_a');
    expect((sql as unknown as Record<symbol, unknown>)[SITE_SCOPED_SQL]).toBe('site_a');
    expect(isSiteScopedSql(base)).toBe(false);
    expect(scopedSiteIdOf(base)).toBeUndefined();
    expect(isSiteScopedSql(undefined)).toBe(false);
    expect(unscopedSqlOf(sql)).toBe(base);
    expect(unscopedSqlOf(base)).toBe(base);
  });
});
