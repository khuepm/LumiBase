/**
 * Insights service — executes a `PanelQuery` safely and manages dashboards/panels.
 *
 * SECURITY MODEL (see `.kiro/specs/insights-dashboard`, Req 3):
 *   - No user-supplied identifier ever reaches SQL. Rows are fetched with a
 *     fully parameterized Drizzle query scoped to `siteId` + the resolved
 *     collection id, then the aggregate runs IN-MEMORY in JS. This makes
 *     identifier injection structurally impossible.
 *   - Every field referenced by the query (`field`, `groupBy`, `dateRange.field`,
 *     and every key in `filter`) must be in the collection's field whitelist
 *     (schema fields + a fixed set of system columns), else `INVALID_FIELD`.
 *   - `filter` is evaluated with the shared `evaluateRule`, the same evaluator
 *     used elsewhere — no bespoke condition logic.
 *
 * In-memory aggregation is the safe v1. Panels over very large collections can
 * later be pointed at a materialized source (Req 9); the security invariants
 * above still apply there.
 */

import { items, materializedCollections } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import {
  PANEL_DEFAULT_LIMIT,
  PANEL_MAX_LIMIT,
  type PanelQuery,
  type PanelResult,
} from '@lumibase/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type ConditionRule, evaluateRule } from './conditions';
import { sanitizeTableName } from './materialize-service';
import { SchemaService } from './schema-service';

/** Where a panel reads its rows from. `items` (default) or a materialized projection. */
export type PanelSource = 'items' | 'materialized';

/** System columns always queryable in addition to the collection's own fields. */
const SYSTEM_FIELDS = new Set(['id', 'status', 'sort', 'created_at', 'updated_at']);

export class InsightsServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'InsightsServiceError';
  }
}

interface Deps {
  db: Database;
  siteId: string;
  schema: SchemaService;
}

export class InsightsService {
  constructor(private readonly deps: Deps) {}

  /**
   * Run a PanelQuery and return the computed result. `source` selects the row
   * source (options.source in the design): `items` (default, the JSONB store)
   * or `materialized` (the collection's `mat_*` projection). Both apply the
   * SAME security invariants — field whitelist, `WHERE site_id`, and (for items)
   * `deleted_at IS NULL` — so switching sources can't widen access.
   */
  async runPanel(
    query: PanelQuery,
    override?: Partial<Pick<PanelQuery, 'filter' | 'dateRange'>>,
    options?: { source?: PanelSource },
  ): Promise<PanelResult> {
    const start = Date.now();
    const q: PanelQuery = { ...query, ...override };

    const collection = await this.assertCollection(q.collection);
    const allowed = await this.fieldWhitelist(q.collection);
    this.assertFields(q, allowed);

    const records = await this.loadRecords(q.collection, collection.id, options?.source ?? 'items');

    const filtered = q.filter
      ? records.filter((rec) => evaluateRule(q.filter as ConditionRule, rec))
      : records;

    const data = this.aggregate(q, filtered);
    return {
      data,
      meta: { executedAt: new Date(start).toISOString(), rowCount: filtered.length, durationMs: Date.now() - start },
    };
  }

  // ---------- internals ----------

  private async assertCollection(name: string) {
    const collection = await this.deps.schema.getCollection(name);
    if (!collection) {
      throw new InsightsServiceError('INVALID_COLLECTION', `Collection "${name}" not found.`, 404);
    }
    return collection;
  }

  /**
   * Load the queryable records for a collection from the requested source.
   * `items`: the JSONB store, site-scoped + not-deleted. `materialized`: the
   * collection's `mat_*` projection (same flat `{ data JSONB }` shape),
   * site-scoped. The materialized table name comes from the caller-owned
   * `materialized_collections.id` (never user input) and is re-validated via
   * `sanitizeTableName` before it touches SQL, so the identifier is safe.
   */
  private async loadRecords(
    collectionName: string,
    collectionId: string,
    source: PanelSource,
  ): Promise<Record<string, unknown>[]> {
    if (source === 'materialized') {
      const [mat] = await this.deps.db
        .select({ id: materializedCollections.id })
        .from(materializedCollections)
        .where(
          and(
            eq(materializedCollections.siteId, this.deps.siteId),
            eq(materializedCollections.collection, collectionName),
          ),
        )
        .limit(1);
      if (!mat) {
        throw new InsightsServiceError(
          'NO_MATERIALIZED_SOURCE',
          `No materialized projection for collection "${collectionName}".`,
          404,
        );
      }
      const table = sql.identifier(sanitizeTableName(mat.id));
      // site_id is bound; the table identifier is validated above. Only `data`
      // is projected — the same field the items path aggregates.
      const result = await this.deps.db.execute<{ data: Record<string, unknown> | null }>(
        sql`SELECT data FROM ${table} WHERE site_id = ${this.deps.siteId}`,
      );
      const rows = (result as unknown as { rows?: { data: Record<string, unknown> | null }[] }).rows
        ?? (result as unknown as { data: Record<string, unknown> | null }[]);
      return rows.map((r) => (r.data ?? {}) as Record<string, unknown>);
    }

    // Default: the JSONB item store.
    const rows = await this.deps.db
      .select({ data: items.data })
      .from(items)
      .where(
        and(
          eq(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          isNull(items.deletedAt),
        ),
      );
    // Each item's queryable record = its JSONB data. For v1 only data fields are
    // aggregated; system fields are whitelisted so filters validate, but values
    // come from data.
    return rows.map((r) => (r.data ?? {}) as Record<string, unknown>);
  }

  private async fieldWhitelist(collectionName: string): Promise<Set<string>> {
    const fieldRows = await this.deps.schema.listFields(collectionName);
    const set = new Set<string>(SYSTEM_FIELDS);
    for (const f of fieldRows) set.add(f.name);
    return set;
  }

  private assertFields(q: PanelQuery, allowed: Set<string>): void {
    const referenced: string[] = [];
    if (q.field) referenced.push(q.field);
    if (q.groupBy) referenced.push(q.groupBy);
    if (q.dateRange?.field) referenced.push(q.dateRange.field);
    for (const k of this.filterFields(q.filter)) referenced.push(k);

    for (const f of referenced) {
      if (!allowed.has(f)) {
        throw new InsightsServiceError('INVALID_FIELD', `Field "${f}" is not allowed for this collection.`);
      }
    }
  }

  /** Collect the leaf field keys referenced by a condition rule. */
  private filterFields(filter: PanelQuery['filter']): string[] {
    if (!filter || typeof filter !== 'object') return [];
    const out: string[] = [];
    const walk = (node: Record<string, unknown>): void => {
      for (const [key, val] of Object.entries(node)) {
        if (key === '_and' || key === '_or') {
          if (Array.isArray(val)) for (const child of val) walk(child as Record<string, unknown>);
        } else {
          out.push(key);
        }
      }
    };
    walk(filter as Record<string, unknown>);
    return out;
  }

  private aggregate(q: PanelQuery, records: Record<string, unknown>[]): PanelResult['data'] {
    const limit = Math.min(q.limit ?? PANEL_DEFAULT_LIMIT, PANEL_MAX_LIMIT);

    // Grouped → series of { label, value }.
    if (q.groupBy) {
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const rec of records) {
        const label = String(rec[q.groupBy] ?? '∅');
        const arr = groups.get(label) ?? [];
        arr.push(rec);
        groups.set(label, arr);
      }
      const series = [...groups.entries()]
        .map(([label, recs]) => ({ label, value: this.reduce(q.aggregate, q.field, recs) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
      return { series };
    }

    // Ungrouped → a single scalar value.
    return { value: this.reduce(q.aggregate, q.field, records) };
  }

  private reduce(aggregate: PanelQuery['aggregate'], field: string | undefined, records: Record<string, unknown>[]): number {
    if (aggregate === 'count') return records.length;
    if (!field) return 0;
    const nums = records
      .map((r) => Number(r[field]))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0) return 0;
    switch (aggregate) {
      case 'sum':
        return nums.reduce((a, b) => a + b, 0);
      case 'avg':
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'min':
        return Math.min(...nums);
      case 'max':
        return Math.max(...nums);
      default:
        return 0;
    }
  }
}
