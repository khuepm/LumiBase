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

import { items } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import {
  PANEL_DEFAULT_LIMIT,
  PANEL_MAX_LIMIT,
  type PanelQuery,
  type PanelResult,
} from '@lumibase/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type ConditionRule, evaluateRule } from './conditions';
import { SchemaService } from './schema-service';

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

  /** Run a PanelQuery and return the computed result. */
  async runPanel(query: PanelQuery, override?: Partial<Pick<PanelQuery, 'filter' | 'dateRange'>>): Promise<PanelResult> {
    const start = Date.now();
    const q: PanelQuery = { ...query, ...override };

    const collection = await this.assertCollection(q.collection);
    const allowed = await this.fieldWhitelist(q.collection);
    this.assertFields(q, allowed);

    const rows = await this.deps.db
      .select({ data: items.data })
      .from(items)
      .where(
        and(
          eq(items.siteId, this.deps.siteId),
          eq(items.collectionId, collection.id),
          isNull(items.deletedAt),
        ),
      );

    // Each item's queryable record = its JSONB data merged with system columns
    // we expose. For v1 only data fields are aggregated; system fields are
    // whitelisted so filters referencing them validate, but values come from data.
    const records = rows.map((r) => (r.data ?? {}) as Record<string, unknown>);

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
