import { collections, items, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Insert items with fixed ids into `siteId` (creating `collection` when it is
 * missing), so DB fixtures can reference them by `item_id`. Since migration
 * 0041 every table that references an item carries a same-site foreign key
 * `(site_id, item_id) → lumibase_items (site_id, id)` (#868); a fixture row
 * naming an item that does not exist in its site is refused.
 */
export async function seedItems(
  db: Database,
  siteId: string,
  ids: readonly string[],
  collection = 'posts',
): Promise<void> {
  await db.insert(collections).values({ siteId, name: collection, label: collection }).onConflictDoNothing();
  const [row] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.name, collection)))
    .limit(1);
  if (!row) throw new Error(`seedItems: collection "${collection}" missing in site "${siteId}"`);
  if (ids.length === 0) return;
  await db
    .insert(items)
    .values(ids.map((id) => ({ id, siteId, collectionId: row.id, data: {} })))
    .onConflictDoNothing();
}
