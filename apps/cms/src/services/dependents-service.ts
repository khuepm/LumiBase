/**
 * dependents-service.ts — reverse foreign-key dependency resolution
 * (spec: .kiro/specs/fk-dependent-records).
 *
 * LumiBase stores item references in JSONB (`items.data->>field`), not physical
 * FK columns, so `relations.on_delete` is APPLICATION-enforced metadata. This
 * service finds records that reference a given item (the reverse of
 * ItemService's forward relation expansion) and applies batch resolutions
 * (set_null / delete / reassign). Delete delegates to ItemService so hooks /
 * search-deindex / realtime fire as usual.
 *
 * Decision (design §7): only `restrict` blocks a delete (application-level);
 * `set null` / `cascade` are NOT auto-run on soft-delete — the editor clears
 * them explicitly via resolveAction.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { collections, fields, items, relations, scopeSite, type Database } from '@lumibase/database';
import { ItemService } from './item-service';

export class DependentsError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'DependentsError';
  }
}

export interface DependentGroup {
  relation: string;
  collection: string; // manyCollection
  field: string; // manyField
  onDelete: string;
  count: number;
  sample: Array<{ id: string }>;
}

export interface DependentsReport {
  blocking: boolean;
  dependents: DependentGroup[];
}

export type ResolveAction = 'set_null' | 'delete' | 'reassign';

export interface DependentsServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  /** Factory for an ItemService bound to the same db/site (for delete delegation). */
  itemServiceFactory?: (db: Database) => ItemService;
}

const SAMPLE_LIMIT = 10;

export class DependentsService {
  constructor(private readonly deps: DependentsServiceDeps) {}

  private itemService(db: Database = this.deps.db): ItemService {
    if (this.deps.itemServiceFactory) return this.deps.itemServiceFactory(db);
    return new ItemService({ db, siteId: this.deps.siteId, userId: this.deps.userId ?? null });
  }

  private async collectionIdByName(name: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    return row?.id ?? null;
  }

  /** Find records that reference `(collection, itemId)`. Only groups with count>0. */
  async resolveDependents(collection: string, itemId: string, limit = SAMPLE_LIMIT): Promise<DependentGroup[]> {
    // Relations where this collection is the "one" side (others point at it).
    const rels = await this.deps.db
      .select()
      .from(relations)
      .where(and(scopeSite(relations.siteId, this.deps.siteId), eq(relations.oneCollection, collection)));

    const groups: DependentGroup[] = [];
    for (const rel of rels) {
      const manyCollectionId = await this.collectionIdByName(rel.manyCollection);
      if (!manyCollectionId) continue;

      const whereRef = and(
        scopeSite(items.siteId, this.deps.siteId),
        eq(items.collectionId, manyCollectionId),
        isNull(items.deletedAt),
        sql`${items.data}->>${sql.raw(`'${escapeIdent(rel.manyField)}'`)} = ${itemId}`,
      );

      const countRows = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(whereRef);
      const count = countRows[0]?.count ?? 0;
      if (count === 0) continue;

      const sample = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(whereRef)
        .limit(limit);

      groups.push({
        relation: rel.id,
        collection: rel.manyCollection,
        field: rel.manyField,
        onDelete: rel.onDelete,
        count,
        sample,
      });
    }
    return groups;
  }

  /** A delete is blocked iff a `restrict` relation has dependents. */
  isBlocking(groups: DependentGroup[]): boolean {
    return groups.some((g) => g.count > 0 && g.onDelete === 'restrict');
  }

  /** Convenience: report for an item (groups + blocking). */
  async report(collection: string, itemId: string, limit = SAMPLE_LIMIT): Promise<DependentsReport> {
    const dependents = await this.resolveDependents(collection, itemId, limit);
    return { dependents, blocking: this.isBlocking(dependents) };
  }

  /**
   * Batch-resolve one relation's dependents. Transactional; delete delegates to
   * ItemService.softDelete (or hardDelete when `hard`). Returns affected count.
   */
  async applyResolution(
    targetCollection: string,
    itemId: string,
    action: ResolveAction,
    relationId: string,
    opts: { newTargetId?: string; hard?: boolean } = {},
  ): Promise<{ action: ResolveAction; relation: string; affected: number; policyOverridden: boolean }> {
    const [rel] = await this.deps.db
      .select()
      .from(relations)
      .where(and(scopeSite(relations.siteId, this.deps.siteId), eq(relations.id, relationId)))
      .limit(1);
    if (!rel || rel.oneCollection !== targetCollection) {
      throw new DependentsError('RELATION_NOT_FOUND', 'Relation not found for this item.', 404);
    }
    const manyCollectionId = await this.collectionIdByName(rel.manyCollection);
    if (!manyCollectionId) throw new DependentsError('RELATION_NOT_FOUND', 'Dependent collection not found.', 404);

    // Guards.
    if (action === 'set_null') {
      const [f] = await this.deps.db
        .select({ required: fields.required })
        .from(fields)
        .where(and(scopeSite(fields.siteId, this.deps.siteId), eq(fields.collectionId, manyCollectionId), eq(fields.name, rel.manyField)))
        .limit(1);
      if (f?.required) {
        throw new DependentsError('FIELD_REQUIRED', `Field "${rel.manyField}" is required; cannot set it null.`, 409);
      }
    }
    if (action === 'reassign') {
      const target = opts.newTargetId;
      if (!target || target === itemId) {
        throw new DependentsError('INVALID_TARGET', 'A distinct newTargetId is required for reassign.', 422);
      }
      const oneCollectionId = await this.collectionIdByName(rel.oneCollection);
      const [exists] = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, oneCollectionId ?? '__none__'), eq(items.id, target), isNull(items.deletedAt)))
        .limit(1);
      if (!exists) throw new DependentsError('INVALID_TARGET', 'Reassign target does not exist.', 422);
    }

    // Collect the dependent ids (in the request db, before the tx).
    const whereRef = and(
      scopeSite(items.siteId, this.deps.siteId),
      eq(items.collectionId, manyCollectionId),
      isNull(items.deletedAt),
      sql`${items.data}->>${sql.raw(`'${escapeIdent(rel.manyField)}'`)} = ${itemId}`,
    );
    const dependentIds = (await this.deps.db.select({ id: items.id }).from(items).where(whereRef)).map((r) => r.id);

    const db = this.deps.db as Database & { transaction?: <T>(cb: (tx: Database) => Promise<T>) => Promise<T> };
    let affected = 0;
    const run = async (tx: Database) => {
      if (action === 'set_null' || action === 'reassign') {
        const value = action === 'reassign' ? opts.newTargetId! : null;
        // jsonb_set on each dependent's manyField.
        const res = await tx
          .update(items)
          .set({
            data: sql`jsonb_set(${items.data}, ${sql.raw(`'{${escapeIdent(rel.manyField)}}'`)}, ${value === null ? sql`'null'::jsonb` : sql`to_jsonb(${value}::text)`}, true)`,
            updatedAt: new Date(),
          })
          .where(whereRef)
          .returning({ id: items.id });
        affected = res.length;
      } else {
        // delete: delegate per-item so hooks/deindex fire; bind ItemService to tx.
        const svc = this.itemService(tx);
        for (const depId of dependentIds) {
          if (opts.hard) await svc.hardDelete(rel.manyCollection, depId);
          else await svc.softDelete(rel.manyCollection, depId);
          affected++;
        }
      }
    };
    if (typeof db.transaction === 'function') await db.transaction(run);
    else await run(this.deps.db);

    const defaultForOnDelete: Record<string, ResolveAction | undefined> = {
      'set null': 'set_null',
      cascade: 'delete',
      restrict: undefined,
      'no action': undefined,
    };
    const policyOverridden = defaultForOnDelete[rel.onDelete] !== action;

    return { action, relation: relationId, affected, policyOverridden };
  }
}

/** Reject identifiers that could break out of the quoted JSON path. */
function escapeIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new DependentsError('INVALID_FIELD', `Unsafe field name "${name}".`, 400);
  }
  return name;
}
