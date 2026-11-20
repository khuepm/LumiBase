/**
 * Mirrors provider content into ordinary collections (#764):
 * `commerce_products` and `commerce_promotions`, plus two block templates
 * (`block_product_card`, `block_promotion`) for dynamic zones.
 *
 * Every write goes through the ItemService, so validation, revisions, CDC
 * events (webhooks, search, cache invalidation) and delivery behave exactly as
 * for an editor's change. Rows are keyed by `(provider, external_id)`; a
 * synced row is the provider's, and a re-sync overwrites it.
 */
import type { FieldInput, SchemaService } from '../../services/schema-service';
import type { ItemService } from '../../services/item-service';
import { priceFrom, type CommerceAdapter, type CommerceProduct, type CommercePromotion, type CommerceProviderName } from './types';

export const PRODUCTS_COLLECTION = 'commerce_products';
export const PROMOTIONS_COLLECTION = 'commerce_promotions';
export const PRODUCT_CARD_BLOCK = 'block_product_card';
export const PROMOTION_BLOCK = 'block_promotion';
/** Full-sync safety bound (pages of 50 products). */
export const MAX_SYNC_PAGES = 200;

const f = (name: string, type: string, iface: string, extra: Partial<FieldInput> = {}): FieldInput => ({
  name,
  type,
  interface: iface,
  nullable: true,
  ...extra,
});

const PRODUCT_FIELDS: FieldInput[] = [
  f('title', 'string', 'input'),
  f('handle', 'string', 'input', { note: 'Provider handle; product cards reference products by it.' }),
  f('description', 'text', 'input-multiline'),
  f('thumbnail', 'string', 'input'),
  f('variants', 'json', 'input-code', { note: 'Variants with prices; a price with min/max quantity is a tier.' }),
  f('price_from', 'decimal', 'input', { note: 'Lowest price (any tier) in `currency`.' }),
  f('currency', 'string', 'input'),
  f('provider', 'string', 'input', { readonly: true }),
  f('external_id', 'string', 'input', { readonly: true }),
  f('synced_at', 'timestamp', 'datetime', { readonly: true }),
];

const PROMOTION_FIELDS: FieldInput[] = [
  f('title', 'string', 'input'),
  f('code', 'string', 'input'),
  f('kind', 'string', 'input', { note: '`percentage` or `fixed`.' }),
  f('value', 'decimal', 'input'),
  f('currency', 'string', 'input'),
  f('starts_at', 'timestamp', 'datetime'),
  f('ends_at', 'timestamp', 'datetime'),
  f('provider', 'string', 'input', { readonly: true }),
  f('external_id', 'string', 'input', { readonly: true }),
  f('synced_at', 'timestamp', 'datetime', { readonly: true }),
];

const PRODUCT_CARD_FIELDS: FieldInput[] = [
  f('product_handle', 'string', 'input', { note: 'Handle of a product in commerce_products.' }),
  f('show_tiers', 'boolean', 'boolean', { defaultValue: true }),
  f('currency', 'string', 'input', { note: 'Prices in this currency (default: the product currency).' }),
  f('cta_label', 'string', 'input'),
  f('cta_url', 'string', 'input'),
];

const PROMOTION_BLOCK_FIELDS: FieldInput[] = [
  f('promotion_code', 'string', 'input', { note: 'Code (or external id) of a promotion in commerce_promotions.' }),
  f('headline', 'string', 'input'),
  f('body', 'text', 'input-multiline'),
  f('cta_label', 'string', 'input'),
  f('cta_url', 'string', 'input'),
];

/** Create the synced collections and block templates once; existing ones are left untouched. */
export async function ensureCommerceSchema(schema: SchemaService): Promise<string[]> {
  const created: string[] = [];
  const specs: Array<[string, Record<string, unknown>, FieldInput[]]> = [
    [PRODUCTS_COLLECTION, { label: 'Products', icon: 'shopping_bag', displayTemplate: '{{title}}', note: 'Synced from the connected commerce provider (#764). Edits are overwritten by the next sync.' }, PRODUCT_FIELDS],
    [PROMOTIONS_COLLECTION, { label: 'Promotions', icon: 'sell', displayTemplate: '{{title}}', note: 'Synced from the connected commerce provider (#764).' }, PROMOTION_FIELDS],
    [PRODUCT_CARD_BLOCK, { label: 'Product card', icon: 'widgets', hidden: true, displayTemplate: '{{product_handle}}', note: 'Block: a product with its price tiers (#764).' }, PRODUCT_CARD_FIELDS],
    [PROMOTION_BLOCK, { label: 'Promotion', icon: 'widgets', hidden: true, displayTemplate: '{{headline}}', note: 'Block: a promotion (#764).' }, PROMOTION_BLOCK_FIELDS],
  ];
  for (const [name, meta, fields] of specs) {
    if (await schema.getCollection(name)) continue;
    await schema.updateSchema(name, { ...meta, fields: fields.map((x, i) => ({ ...x, sortOrder: i + 1 })) } as Parameters<SchemaService['updateSchema']>[1]);
    created.push(name);
  }
  return created;
}

async function findId(items: ItemService, collection: string, provider: CommerceProviderName, externalId: string): Promise<string | null> {
  const res = (await items.list(collection, {
    filter: { _and: [{ provider: { _eq: provider } }, { external_id: { _eq: externalId } }] },
    limit: 1,
    withTotal: false,
  })) as { data: Array<{ id: string }> };
  return res.data[0]?.id ?? null;
}

export function productData(provider: CommerceProviderName, p: CommerceProduct, now: Date): Record<string, unknown> {
  const from = priceFrom(p);
  return {
    title: p.title,
    handle: p.handle,
    description: p.description,
    thumbnail: p.thumbnail,
    variants: p.variants,
    price_from: from?.amount ?? null,
    currency: from?.currency ?? null,
    provider,
    external_id: p.externalId,
    synced_at: now.toISOString(),
  };
}

export function promotionData(provider: CommerceProviderName, p: CommercePromotion, now: Date): Record<string, unknown> {
  return {
    title: p.title,
    code: p.code,
    kind: p.kind,
    value: p.value,
    currency: p.currency,
    starts_at: p.startsAt,
    ends_at: p.endsAt,
    provider,
    external_id: p.externalId,
    synced_at: now.toISOString(),
  };
}

async function upsert(items: ItemService, collection: string, provider: CommerceProviderName, externalId: string, data: Record<string, unknown>, published: boolean) {
  const status = published ? 'published' : 'draft';
  const id = await findId(items, collection, provider, externalId);
  if (id) {
    await items.patch(collection, id, { data, status });
    return 'updated' as const;
  }
  await items.create(collection, { data, status });
  return 'created' as const;
}

async function remove(items: ItemService, collection: string, provider: CommerceProviderName, externalId: string): Promise<boolean> {
  const id = await findId(items, collection, provider, externalId);
  if (!id) return false;
  await items.softDelete(collection, id);
  return true;
}

export interface SyncDeps {
  schema: SchemaService;
  items: ItemService;
  adapter: CommerceAdapter;
  now?: () => Date;
}

export async function syncProduct(deps: SyncDeps, externalId: string): Promise<'created' | 'updated' | 'deleted' | 'missing'> {
  await ensureCommerceSchema(deps.schema);
  const product = await deps.adapter.getProduct(externalId);
  if (!product) return (await remove(deps.items, PRODUCTS_COLLECTION, deps.adapter.name, externalId)) ? 'deleted' : 'missing';
  return upsert(deps.items, PRODUCTS_COLLECTION, deps.adapter.name, product.externalId, productData(deps.adapter.name, product, (deps.now ?? (() => new Date()))()), product.published);
}

export async function deleteProduct(deps: SyncDeps, externalId: string): Promise<boolean> {
  await ensureCommerceSchema(deps.schema);
  return remove(deps.items, PRODUCTS_COLLECTION, deps.adapter.name, externalId);
}

export interface FullSyncResult {
  products: { created: number; updated: number; deleted: number };
  promotions: { created: number; updated: number; deleted: number };
  truncated: boolean;
}

/**
 * Pull everything: upsert every product and promotion, then delete the
 * synced rows the provider no longer has (unless the walk was truncated).
 */
export async function fullSync(deps: SyncDeps): Promise<FullSyncResult> {
  await ensureCommerceSchema(deps.schema);
  const now = (deps.now ?? (() => new Date()))();
  const provider = deps.adapter.name;
  const out: FullSyncResult = { products: { created: 0, updated: 0, deleted: 0 }, promotions: { created: 0, updated: 0, deleted: 0 }, truncated: false };
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await deps.adapter.listProducts(cursor);
    for (const p of page.products) {
      seen.add(p.externalId);
      out.products[await upsert(deps.items, PRODUCTS_COLLECTION, provider, p.externalId, productData(provider, p, now), p.published)] += 1;
    }
    cursor = page.next;
    pages += 1;
  } while (cursor && pages < MAX_SYNC_PAGES);
  out.truncated = Boolean(cursor);

  out.promotions = await syncPromotions(deps, now);
  if (!out.truncated) out.products.deleted = await prune(deps.items, PRODUCTS_COLLECTION, provider, seen);
  return out;
}

/** Upsert every promotion and remove the ones the provider no longer has. */
export async function syncPromotions(deps: SyncDeps, now: Date = (deps.now ?? (() => new Date()))()): Promise<FullSyncResult['promotions']> {
  await ensureCommerceSchema(deps.schema);
  const provider = deps.adapter.name;
  const out = { created: 0, updated: 0, deleted: 0 };
  const seen = new Set<string>();
  for (const p of await deps.adapter.listPromotions()) {
    seen.add(p.externalId);
    out[await upsert(deps.items, PROMOTIONS_COLLECTION, provider, p.externalId, promotionData(provider, p, now), p.active)] += 1;
  }
  out.deleted = await prune(deps.items, PROMOTIONS_COLLECTION, provider, seen);
  return out;
}

async function prune(items: ItemService, collection: string, provider: CommerceProviderName, keep: Set<string>): Promise<number> {
  let deleted = 0;
  for (let offset = 0; ; offset += 200) {
    const res = (await items.list(collection, { filter: { provider: { _eq: provider } }, fields: ['id', 'external_id'], limit: 200, offset, withTotal: false })) as {
      data: Array<{ id: string; external_id?: string; data?: { external_id?: string } }>;
    };
    const stale = res.data.filter((r) => !keep.has(String(r.external_id ?? r.data?.external_id ?? '')));
    for (const r of stale) {
      await items.softDelete(collection, r.id);
      deleted += 1;
    }
    if (res.data.length < 200) break;
    offset -= stale.length;
  }
  return deleted;
}
