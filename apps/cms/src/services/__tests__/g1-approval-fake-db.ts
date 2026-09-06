import type { Database } from '@lumibase/database';
import { getTableName } from 'drizzle-orm';

/**
 * Multi-table drizzle stand-in for the G1 approval-execution tests (#453).
 *
 * Follows the single-table idiom in `agent-run-state-machine.test.ts` but
 * routes by table so one stub can back the whole approval round-trip
 * (ai_approvals + agent_approvals + agent_runs + agent_goals + agent_tool_calls).
 *
 * Deliberately dumb: `where` is not interpreted. Each table exposes a
 * `match` predicate the test sets, so a test states exactly which rows a
 * query sees. This keeps the stub honest — it cannot accidentally "pass" a
 * query it does not understand, and every filter a test relies on is visible
 * in the test itself.
 */

export type Row = Record<string, unknown>;

export interface TableState {
  rows: Row[];
  /** Rows a select/update sees. Defaults to every row. */
  match: (row: Row) => boolean;
  /**
   * Compare-and-set guard for UPDATEs, keyed by the status the patch writes.
   * The stub does not parse `where`, so a test exercising a conditional update
   * declares the precondition here: `{ deciding: ['pending'] }` means "an
   * update setting status='deciding' only affects rows currently 'pending'".
   * Without this the stub would let every concurrent update succeed and a
   * serialization assertion would be accidentally true.
   */
  updateGuards?: Record<string, string[]>;
}

export interface FakeDb {
  db: Database;
  /** Rows by table name, e.g. `tables.ai_approvals.rows`. */
  tables: Record<string, TableState>;
  /** Ordered log of every write, for side-effect counting. */
  writes: Array<{ op: 'insert' | 'update'; table: string; patch: Row; affected: number }>;
}

/**
 * Collects the literal values an `eq(<column>, value)` compares against, at any
 * depth of a drizzle condition tree.
 *
 * Drizzle builds conditions as nested `queryChunks`; an equality reads as
 * `[..., <column>, " = ", <param>]`, where the param carries the bound `value`.
 * Walking for that triple is enough to resolve by-id reads; every other
 * predicate is left to the table's `match`.
 */
function collectEqValues(condition: unknown, columnName: string): string[] {
  const found: string[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown }).queryChunks;
    if (!Array.isArray(chunks)) return;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] as Record<string, unknown> | null;
      const isTargetColumn =
        chunk !== null &&
        typeof chunk === 'object' &&
        chunk['name'] === columnName &&
        'columnType' in chunk;

      if (isTargetColumn) {
        const operator = chunks[i + 1] as Record<string, unknown> | undefined;
        const param = chunks[i + 2] as Record<string, unknown> | undefined;
        const isEquality =
          Array.isArray(operator?.['value']) &&
          String((operator!['value'] as unknown[])[0]).trim() === '=';
        if (isEquality && param && 'value' in param) {
          found.push(String(param['value']));
        }
      }
      visit(chunk);
    }
  };

  visit(condition);
  return found;
}

/** SQL name of a drizzle table, via drizzle's own public helper. */
function tableName(table: unknown): string {
  return getTableName(table as never);
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, TableState> = {};
  const writes: FakeDb['writes'] = [];

  const stateFor = (name: string): TableState => {
    tables[name] ??= { rows: [], match: () => true };
    return tables[name]!;
  };
  for (const [name, rows] of Object.entries(seed)) {
    stateFor(name).rows = rows;
  }

  const db = {
    select: (_projection?: unknown) => ({
      from: (table: unknown) => {
        const state = stateFor(tableName(table));
        const read = () => state.rows.filter(state.match).map((row) => ({ ...row }));
        const result = () =>
          Object.assign(Promise.resolve(read()), {
            limit: async () => read(),
            orderBy: () => Object.assign(Promise.resolve(read()), { limit: async () => read() }),
          });
        // Interpret the `where` expression well enough to resolve by-id
        // lookups: drizzle's `eq(col, value)` exposes both sides, so a walk
        // like goal→parent resolves correctly without per-test sequencing.
        return Object.assign(result(), {
          where: (condition?: unknown) => {
            const ids = collectEqValues(condition, 'id');
            if (ids.length > 0) {
              const rows = state.rows
                .filter((row) => state.match(row) && ids.includes(String(row['id'])))
                .map((row) => ({ ...row }));
              return Object.assign(Promise.resolve(rows), {
                limit: async () => rows,
                orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
              });
            }
            return result();
          },
        });
      },
    }),

    insert: (table: unknown) => {
      const name = tableName(table);
      const state = stateFor(name);
      return {
        values: (values: Row) => {
          const row = { id: `${name}_${state.rows.length + 1}`, createdAt: new Date(), ...values };
          state.rows.push(row);
          writes.push({ op: 'insert', table: name, patch: values, affected: 1 });
          return Object.assign(Promise.resolve([{ ...row }]), {
            returning: async () => [{ ...row }],
            onConflictDoNothing: () => Object.assign(Promise.resolve([{ ...row }]), {
              returning: async () => [{ ...row }],
            }),
          });
        },
      };
    },

    update: (table: unknown) => {
      const name = tableName(table);
      const state = stateFor(name);
      return {
        set: (patch: Row) => ({
          where: () => {
            const required = state.updateGuards?.[String(patch['status'])];
            const targets = state.rows.filter(
              (row) =>
                state.match(row) &&
                (!required || required.includes(String(row['status']))),
            );
            for (const row of targets) Object.assign(row, patch);
            writes.push({ op: 'update', table: name, patch, affected: targets.length });
            const rows = targets.map((row) => ({ ...row }));
            return Object.assign(Promise.resolve(rows), { returning: async () => rows });
          },
        }),
      };
    },
  };

  return { db: db as unknown as Database, tables, writes };
}
