import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  buildClickHouseTableSchema,
  mapPgTypeToClickHouse,
  clickHouseColumnType,
  detectSchemaDrift,
  PG_TO_CLICKHOUSE_TYPE_MAP,
  type PgColumn,
  type PgTableSchema,
  type SchemaChangeType,
} from '../modules/cdc/connectors/materialized-engine';

/**
 * Feature: clickhouse-cdc, Property 7: PostgreSQL-to-ClickHouse schema mapping
 *
 * For any valid PostgreSQL table schema (columns with supported types), the
 * Materialized Engine connector SHALL generate a ClickHouse table definition
 * that preserves all column names and maps each PostgreSQL type to its
 * correct ClickHouse equivalent.
 *
 * **Validates: Requirements 3.3**
 */

/**
 * Feature: clickhouse-cdc, Property 8: Schema drift detection
 *
 * For any schema change (column addition, column removal, or type
 * alteration) on a replicated table, the CDC pipeline SHALL detect the
 * change and report both the affected table name and the type of schema
 * modification.
 *
 * **Validates: Requirements 3.6**
 */

// ── Arbitraries ──────────────────────────────────────────────────────────

/** Supported PostgreSQL type names (the keys of the canonical mapping). */
const SUPPORTED_PG_TYPES = Object.keys(PG_TO_CLICKHOUSE_TYPE_MAP);

/** A supported PostgreSQL type name. */
const arbSupportedPgType = fc.constantFrom(...SUPPORTED_PG_TYPES);

/** A valid, non-empty column identifier. */
const arbColumnName = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,30}$/)
  .filter((s) => s.length >= 1);

/** A fully-qualified-ish table name. */
const arbTableName = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
  fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/),
      fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/),
    )
    .map(([schema, table]) => `${schema}.${table}`),
);

/** A single column with a supported type and a nullability flag. */
const arbColumn: fc.Arbitrary<PgColumn> = fc.record({
  name: arbColumnName,
  type: arbSupportedPgType,
  nullable: fc.boolean(),
});

/** A table schema with distinct column names (1–12 columns). */
const arbTableSchema: fc.Arbitrary<PgTableSchema> = fc
  .tuple(
    arbTableName,
    fc.uniqueArray(arbColumn, {
      minLength: 1,
      maxLength: 12,
      selector: (c) => c.name,
    }),
  )
  .map(([table, columns]) => ({ table, columns }));

// ── Property 7 ───────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 7: PostgreSQL-to-ClickHouse schema mapping', () => {
  it('preserves all column names verbatim and in order', () => {
    fc.assert(
      fc.property(arbTableSchema, (pg) => {
        const ch = buildClickHouseTableSchema(pg);

        // Same number of columns, in the same order, with identical names.
        expect(ch.columns.map((c) => c.name)).toEqual(
          pg.columns.map((c) => c.name),
        );
        expect(ch.table).toBe(pg.table);
        expect(ch.engine).toBe('MaterializedPostgreSQL');
      }),
      { numRuns: 100 },
    );
  });

  it('maps each PostgreSQL type to its correct ClickHouse equivalent', () => {
    fc.assert(
      fc.property(arbTableSchema, (pg) => {
        const ch = buildClickHouseTableSchema(pg);

        for (let i = 0; i < pg.columns.length; i += 1) {
          const pgCol = pg.columns[i]!;
          const chCol = ch.columns[i]!;
          const expectedBase = PG_TO_CLICKHOUSE_TYPE_MAP[pgCol.type]!;
          const expected = pgCol.nullable
            ? `Nullable(${expectedBase})`
            : expectedBase;
          expect(chCol.type).toBe(expected);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('mapping is deterministic and case/whitespace insensitive', () => {
    fc.assert(
      fc.property(arbSupportedPgType, (pgType) => {
        const base = mapPgTypeToClickHouse(pgType);
        // Same input → same output.
        expect(mapPgTypeToClickHouse(pgType)).toBe(base);
        // Upper-cased / padded variants resolve identically.
        expect(mapPgTypeToClickHouse(`  ${pgType.toUpperCase()}  `)).toBe(base);
      }),
      { numRuns: 100 },
    );
  });

  it('nullable columns wrap the mapped base type in Nullable(...)', () => {
    fc.assert(
      fc.property(arbSupportedPgType, fc.boolean(), (pgType, nullable) => {
        const base = mapPgTypeToClickHouse(pgType);
        const resolved = clickHouseColumnType(pgType, nullable);
        expect(resolved).toBe(nullable ? `Nullable(${base})` : base);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 8 ───────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 8: Schema drift detection', () => {
  it('detects and reports an added column with the table name and change type', () => {
    fc.assert(
      fc.property(
        arbTableSchema,
        arbColumn,
        (pg, newColumn) => {
          // Ensure the new column name is genuinely new.
          fc.pre(!pg.columns.some((c) => c.name === newColumn.name));

          const current = [...pg.columns, newColumn];
          const drifts = detectSchemaDrift(pg.table, pg.columns, current);

          const added = drifts.find(
            (d) => d.changeType === 'column_added' && d.column === newColumn.name,
          );
          expect(added).toBeDefined();
          expect(added!.table).toBe(pg.table);
          expect(added!.currentType).toBe(newColumn.type);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('detects and reports a removed column with the table name and change type', () => {
    fc.assert(
      fc.property(
        arbTableSchema.filter((pg) => pg.columns.length >= 2),
        fc.nat(),
        (pg, idxSeed) => {
          const removeIdx = idxSeed % pg.columns.length;
          const removed = pg.columns[removeIdx]!;
          const current = pg.columns.filter((_, i) => i !== removeIdx);

          const drifts = detectSchemaDrift(pg.table, pg.columns, current);

          const removal = drifts.find(
            (d) =>
              d.changeType === 'column_removed' && d.column === removed.name,
          );
          expect(removal).toBeDefined();
          expect(removal!.table).toBe(pg.table);
          expect(removal!.previousType).toBe(removed.type);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('detects and reports a type alteration with the table name and change type', () => {
    fc.assert(
      fc.property(
        arbTableSchema,
        fc.nat(),
        arbSupportedPgType,
        (pg, idxSeed, newType) => {
          const idx = idxSeed % pg.columns.length;
          const target = pg.columns[idx]!;

          // The new type must actually differ from the original (under
          // normalisation) AND map to a different ClickHouse type, so the
          // change is observable as drift rather than a cosmetic rename.
          fc.pre(
            mapPgTypeToClickHouse(newType) !== mapPgTypeToClickHouse(target.type),
          );

          const current = pg.columns.map((c, i) =>
            i === idx ? { ...c, type: newType } : c,
          );

          const drifts = detectSchemaDrift(pg.table, pg.columns, current);

          const altered = drifts.find(
            (d) =>
              d.changeType === 'column_type_altered' &&
              d.column === target.name,
          );
          expect(altered).toBeDefined();
          expect(altered!.table).toBe(pg.table);
          expect(altered!.previousType).toBe(target.type);
          expect(altered!.currentType).toBe(newType);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reports no drift when the schema is unchanged', () => {
    fc.assert(
      fc.property(arbTableSchema, (pg) => {
        const drifts = detectSchemaDrift(pg.table, pg.columns, [...pg.columns]);
        expect(drifts).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('every reported drift carries the table name and a valid change type', () => {
    const VALID_CHANGE_TYPES: SchemaChangeType[] = [
      'column_added',
      'column_removed',
      'column_type_altered',
    ];

    fc.assert(
      fc.property(
        arbTableSchema,
        arbTableSchema,
        (before, afterRaw) => {
          // Reuse `before.table` so both sides describe the same table.
          const after = afterRaw.columns;
          const drifts = detectSchemaDrift(before.table, before.columns, after);

          for (const drift of drifts) {
            expect(drift.table).toBe(before.table);
            expect(VALID_CHANGE_TYPES).toContain(drift.changeType);
            expect(typeof drift.column).toBe('string');
            expect(drift.column.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
