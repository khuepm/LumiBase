import type { Database } from '@lumibase/database';
import type { BackendTemplate, SeedRecord } from '@lumibase/contracts/backend-templates';
import type { ItemService } from '../item-service';
import type { SeedHook } from './installer';

/**
 * Seed pack writer (#905, BT05) — the `SeedHook` the installer calls inside
 * its transaction.
 *
 * - Every record is created through the caller's ItemService, bound to the
 *   install transaction: the caller's item permissions, field validation and
 *   normal id generation apply. A record the caller may not create fails the
 *   whole install (nothing commits).
 * - Logical record keys become fresh ids; no id from the template (or any
 *   other site) is ever used.
 * - References are resolved in two passes: records are created in an order
 *   where every REQUIRED reference already exists (required cycles are
 *   refused by the contract before any write), and optional references to a
 *   record created later are set by a patch in the second pass.
 * - No user accounts, credentials, files or URL fetches: values are plain
 *   JSON written as item data.
 *
 * The transaction-bound ItemService must have no queue, search, realtime,
 * cache or extension hooks (see `routes/backend-templates.ts`), so flows,
 * webhooks and indexing do not see uncommitted seed content.
 */

/** Fields of a record that hold m2o references, with whether each is required. */
function referenceFields(template: BackendTemplate, collection: string): Map<string, boolean> {
  const required = new Set(
    template.config.fields.filter((f) => f.collection === collection && f.required === true).map((f) => f.field),
  );
  const out = new Map<string, boolean>();
  for (const r of template.config.relations) {
    if (r.manyCollection !== collection) continue;
    if ((r.type ?? (r.junctionCollection ? 'm2m' : 'm2o')) !== 'm2o') continue;
    out.set(r.manyField, required.has(r.manyField));
  }
  return out;
}

/** Creation order in which every required reference points to an earlier record. */
export function seedCreationOrder(template: BackendTemplate, records: SeedRecord[]): SeedRecord[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const done = new Set<string>();
  const order: SeedRecord[] = [];
  const visit = (record: SeedRecord, trail: Set<string>) => {
    if (done.has(record.key)) return;
    if (trail.has(record.key)) {
      throw new Error(`Required references form a cycle at "${record.key}".`);
    }
    trail.add(record.key);
    const refs = referenceFields(template, record.collection);
    for (const [field, target] of Object.entries(record.references ?? {})) {
      if (target && refs.get(field) === true) {
        const next = byKey.get(target);
        if (next) visit(next, trail);
      }
    }
    trail.delete(record.key);
    done.add(record.key);
    order.push(record);
  };
  for (const record of records) visit(record, new Set());
  return order;
}

export function createSeedWriter(itemsFor: (tx: Database) => ItemService): SeedHook {
  return async ({ tx, template, pack }) => {
    const records = template.seedPacks?.[pack]?.records;
    if (!records) throw new Error(`Seed pack "${pack}" is not part of the template.`);
    const items = itemsFor(tx);
    const ids: Record<string, string> = {};
    const deferred: Array<{ record: SeedRecord; field: string; target: string }> = [];

    for (const record of seedCreationOrder(template, records)) {
      const data: Record<string, unknown> = { ...record.values };
      for (const [field, target] of Object.entries(record.references ?? {})) {
        if (target === null) {
          data[field] = null;
        } else if (ids[target]) {
          data[field] = ids[target];
        } else {
          // Optional reference to a record created later: second pass.
          deferred.push({ record, field, target });
        }
      }
      const created = (await items.create(record.collection, { data })) as { id: string };
      ids[record.key] = created.id;
    }
    for (const { record, field, target } of deferred) {
      await items.patch(record.collection, ids[record.key]!, { data: { [field]: ids[target] } });
    }
    return { records: records.length, keys: ids };
  };
}
