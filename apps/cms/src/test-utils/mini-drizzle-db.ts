/**
 * A tiny in-memory stand-in for the Drizzle query builder, for unit tests
 * that need real row state (insert → read back → update) without Postgres.
 *
 * Supported, and nothing more:
 *   - `select(fields?).from(t).where(c)[.orderBy()][.limit(n)]`, where a
 *     `count(*)` field returns the matching row count;
 *   - `insert(t).values(v)[.onConflictDoUpdate()][.returning()]`;
 *   - `update(t).set(v).where(c)[.returning()]`;
 *   - `delete(t).where(c)[.returning()]`;
 *   - `transaction(fn)` (no isolation — runs `fn` against the same store).
 *
 * Conditions are compiled with the real Postgres dialect and evaluated for the
 * shapes the auth services use: `col = $n`, `col is null`, `col is not null`,
 * joined by `and`. Anything else throws, so a test cannot silently pass on a
 * predicate the fake does not understand. Fields selected with a raw SQL
 * expression (other than count) come back `undefined`.
 */

import { getTableName, isSQLWrapper, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

type Row = Record<string, unknown>;

interface ColumnLike {
  name: string;
  hasDefault?: boolean;
  defaultFn?: () => unknown;
  default?: unknown;
}

const dialect = new PgDialect();

function columnsOf(table: PgTable): Record<string, ColumnLike> {
  const out: Record<string, ColumnLike> = {};
  for (const [key, value] of Object.entries(table as unknown as Record<string, unknown>)) {
    if (value && typeof value === 'object' && 'name' in value && 'columnType' in value) {
      out[key] = value as ColumnLike;
    }
  }
  return out;
}

function compilePredicate(table: PgTable, cond: SQL | undefined): (row: Row) => boolean {
  if (!cond) return () => true;
  const { sql, params } = dialect.sqlToQuery(cond);
  const byColumn = new Map(Object.entries(columnsOf(table)).map(([k, c]) => [c.name, k]));
  const body = sql.replace(/^\((.*)\)$/s, '$1');
  const parts = body.split(/ and /i);
  const checks = parts.map((part) => {
    const m = /^"[^"]+"\."([^"]+)" (= \$(\d+)|is null|is not null)$/i.exec(part.trim());
    if (!m) throw new Error(`mini-drizzle-db: unsupported predicate: ${part}`);
    const key = byColumn.get(m[1]!);
    if (!key) throw new Error(`mini-drizzle-db: unknown column ${m[1]}`);
    if (m[3]) {
      const value = params[Number(m[3]) - 1];
      return (row: Row) => row[key] === value;
    }
    return /not null/i.test(m[2]!) ? (row: Row) => row[key] != null : (row: Row) => row[key] == null;
  });
  return (row) => checks.every((check) => check(row));
}

function project(row: Row, fields: Record<string, unknown> | undefined, count: number): Row {
  if (!fields) return { ...row };
  const out: Row = {};
  for (const [alias, field] of Object.entries(fields)) {
    if (field && typeof field === 'object' && 'name' in field && 'columnType' in field) {
      // Rows are keyed by property name (camelCase); columns carry the SQL name.
      const col = field as ColumnLike;
      const key = Object.keys(row).find((k) => snake(k) === col.name);
      out[alias] = key !== undefined ? row[key] : undefined;
    } else if (isSQLWrapper(field) && /count\(\*\)/i.test(dialect.sqlToQuery(field.getSQL()).sql)) {
      out[alias] = count;
    } else {
      out[alias] = undefined;
    }
  }
  return out;
}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

export interface MiniDb {
  /** Rows by table name, for seeding and assertions. */
  tables: Map<string, Row[]>;
  rows(table: PgTable): Row[];
  seed(table: PgTable, rows: Row[]): void;
  db: unknown;
}

export function createMiniDb(): MiniDb {
  const tables = new Map<string, Row[]>();
  const rows = (table: PgTable): Row[] => {
    const name = getTableName(table);
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  const withDefaults = (table: PgTable, value: Row): Row => {
    const out: Row = { ...value };
    for (const [key, col] of Object.entries(columnsOf(table))) {
      if (out[key] !== undefined) continue;
      if (typeof col.defaultFn === 'function') out[key] = col.defaultFn();
      else if (col.default !== undefined && !isSQLWrapper(col.default)) out[key] = col.default;
      else if (col.hasDefault && /_at$/.test(col.name)) out[key] = new Date();
      else if (col.hasDefault && col.name === 'transports') out[key] = [];
      else out[key] = key === 'id' ? nanoid() : null;
    }
    return out;
  };

  const thenable = <T>(run: () => T) => ({
    then<R1 = T, R2 = never>(ok?: ((v: T) => R1 | PromiseLike<R1>) | null, err?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
      return Promise.resolve().then(run).then(ok, err);
    },
  });

  const db = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: PgTable) {
          let pred: (row: Row) => boolean = () => true;
          let limit = Infinity;
          const run = () => {
            const matched = rows(table).filter(pred);
            const isCount = fields && Object.values(fields).some(
              (f) => isSQLWrapper(f) && /count\(\*\)/i.test(dialect.sqlToQuery(f.getSQL()).sql),
            );
            if (isCount) return [project({}, fields, matched.length)];
            return matched.slice(0, limit).map((r) => project(r, fields, matched.length));
          };
          const chain = {
            where(cond: SQL | undefined) {
              pred = compilePredicate(table, cond);
              return chain;
            },
            orderBy() {
              return chain;
            },
            limit(n: number) {
              limit = n;
              return chain;
            },
            ...thenable(run),
          };
          return chain;
        },
      };
    },
    insert(table: PgTable) {
      return {
        values(value: Row | Row[]) {
          const inserted = (Array.isArray(value) ? value : [value]).map((v) => withDefaults(table, v));
          const run = () => {
            rows(table).push(...inserted);
            return inserted;
          };
          const chain = {
            onConflictDoUpdate() {
              return chain;
            },
            onConflictDoNothing() {
              return chain;
            },
            returning() {
              return thenable(run);
            },
            ...thenable(() => {
              run();
              return [];
            }),
          };
          return chain;
        },
      };
    },
    update(table: PgTable) {
      return {
        set(patch: Row) {
          let pred: (row: Row) => boolean = () => true;
          const run = () => {
            const hit = rows(table).filter(pred);
            for (const r of hit) Object.assign(r, patch);
            return hit.map((r) => ({ ...r }));
          };
          const chain = {
            where(cond: SQL | undefined) {
              pred = compilePredicate(table, cond);
              return chain;
            },
            returning() {
              return thenable(run);
            },
            ...thenable(() => {
              run();
              return [];
            }),
          };
          return chain;
        },
      };
    },
    delete(table: PgTable) {
      let pred: (row: Row) => boolean = () => true;
      const run = () => {
        const all = rows(table);
        const removed = all.filter(pred);
        const kept = all.filter((r) => !pred(r));
        all.length = 0;
        all.push(...kept);
        return removed;
      };
      const chain = {
        where(cond: SQL | undefined) {
          pred = compilePredicate(table, cond);
          return chain;
        },
        returning() {
          return thenable(run);
        },
        ...thenable(() => {
          run();
          return [];
        }),
      };
      return chain;
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };

  return {
    tables,
    rows,
    seed(table, seedRows) {
      rows(table).push(...seedRows.map((r) => withDefaults(table, r)));
    },
    db,
  };
}
