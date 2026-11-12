import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  collections,
  fields,
  items,
  relations,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { parseExport, type ExportRecord } from '../../services/export-service';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Route-level DB integration for collection export (#727). The acceptance
 * criterion is a lossless export → import → export round-trip, translations
 * included, for both CSV and JSON.
 */

const SITE = 'site_export_route_it';
const ADMIN = 'usr_export_route_admin';
const STRANGER = 'usr_export_route_stranger';

const PRODUCT_FIELDS = (collectionId: string) => [
  { siteId: SITE, collectionId, name: 'title', type: 'json', interface: 'translatable-text' },
  { siteId: SITE, collectionId, name: 'price', type: 'decimal', interface: 'input' },
  { siteId: SITE, collectionId, name: 'in_stock', type: 'boolean', interface: 'boolean' },
  { siteId: SITE, collectionId, name: 'meta', type: 'json', interface: 'input' },
  { siteId: SITE, collectionId, name: 'note', type: 'text', interface: 'textarea' },
  { siteId: SITE, collectionId, name: 'author_id', type: 'string', interface: 'select' },
];

describe.skipIf(!hasDbIntegrationUrl)('GET /items/:collection/export — DB integration', () => {
  let db: Database;
  let principal = ADMIN;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: principal, email: `${principal}@x.dev`, roles: [], raw: { dev: true } } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('items-export-route');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, STRANGER)).catch(() => undefined);
  });

  let svc: ItemService;
  let authorId = '';

  beforeEach(async () => {
    principal = ADMIN;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Export Route IT',
    });
    await db.insert(users).values({ id: ADMIN, email: 'export-admin@x.dev', status: 'active' }).onConflictDoNothing();
    await db.insert(users).values({ id: STRANGER, email: 'export-stranger@x.dev', status: 'active' }).onConflictDoNothing();
    const adminRole = (
      await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id })
    )[0]!.id;
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole });

    const authors = (await db.insert(collections).values({ siteId: SITE, name: 'authors', label: 'Authors' }).returning({ id: collections.id }))[0]!.id;
    const products = (await db.insert(collections).values({ siteId: SITE, name: 'products', label: 'Products' }).returning({ id: collections.id }))[0]!.id;
    const copy = (await db.insert(collections).values({ siteId: SITE, name: 'products_copy', label: 'Copy' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: authors, name: 'name', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: authors, name: 'slug', type: 'string', interface: 'input' },
      ...PRODUCT_FIELDS(products),
      ...PRODUCT_FIELDS(copy),
    ]);
    await db.insert(relations).values({ siteId: SITE, manyCollection: 'products', manyField: 'author_id', oneCollection: 'authors', type: 'm2o' });

    svc = new ItemService({ db, siteId: SITE });
    authorId = ((await svc.create('authors', { data: { name: 'Lan', slug: 'lan' } })) as { id: string }).id;
    await svc.create('products', {
      status: 'published',
      sort: 1,
      data: {
        title: { en: 'Coffee', vi: 'Cà phê' },
        price: 10.5,
        in_stock: true,
        meta: { tags: ['hot', 'new'], dims: { w: 1.5 } },
        note: 'Line 1\nLine 2, with "quotes"',
        author_id: authorId,
      },
    });
    await svc.create('products', {
      status: 'draft',
      sort: 2,
      data: { title: { en: 'Tea' }, price: 9, in_stock: false, meta: null, note: '=SUM(A1:A9)', author_id: null },
    });
    await svc.create('products', {
      status: 'published',
      sort: 3,
      data: { title: { vi: 'Nước' }, price: -1, in_stock: true, meta: [], note: '', author_id: authorId },
    });
  });

  const get = (path: string) => app.request(`/api/v1/items/${path}`);

  async function content(collection: string): Promise<Array<Omit<ExportRecord, 'id' | 'created_at' | 'updated_at'>>> {
    const res = await get(`${collection}/export?format=json&sort=sort`);
    const doc = (await res.json()) as { items: ExportRecord[] };
    return doc.items.map(({ status, sort, data }) => ({ status, sort, data }));
  }

  async function importInto(collection: string, body: string, format: 'csv' | 'json') {
    const schema = await svc.describeForExport(collection);
    for (const rec of parseExport(body, format, schema.fields)) {
      await svc.create(collection, { data: rec.data, status: rec.status, sort: rec.sort });
    }
  }

  for (const format of ['csv', 'json'] as const) {
    it(`round-trips ${format.toUpperCase()} losslessly, translations included (acceptance)`, async () => {
      const res = await get(`products/export?format=${format}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(format === 'csv' ? 'text/csv' : 'application/json');
      expect(res.headers.get('content-disposition')).toMatch(new RegExp(`attachment; filename="products-\\d{4}-\\d{2}-\\d{2}\\.${format}"`));
      await importInto('products_copy', await res.text(), format);
      expect(await content('products_copy')).toEqual(await content('products'));
    });
  }

  it('writes one CSV column per locale and neutralises formulas', async () => {
    const text = await (await get('products/export?format=csv&fields=title,note&sort=sort')).text();
    const [header, , tea] = text.replace(/^﻿/, '').split('\r\n');
    expect(header).toBe('id,status,sort,created_at,updated_at,title.en,title.vi,note');
    expect(tea).toContain(",Tea,,'=SUM(A1:A9)");
  });

  it('filters locales and fields', async () => {
    const doc = (await (await get('products/export?format=json&fields=title&locales=vi&sort=sort')).json()) as { items: ExportRecord[] };
    expect(doc.items.map((i) => i.data)).toEqual([{ title: { vi: 'Cà phê' } }, { title: {} }, { title: { vi: 'Nước' } }]);
  });

  it('applies list filters', async () => {
    const doc = (await (await get(`products/export?format=json&filter=${encodeURIComponent('{"in_stock":{"_eq":"true"}}')}`)).json()) as { items: ExportRecord[] };
    expect(doc.items.map((i) => i.data.price).sort()).toEqual([-1, 10.5]);
  });

  it('relation modes: slug swaps the foreign id, embed adds the record', async () => {
    const slug = (await (await get('products/export?format=json&relations=slug&fields=author_id&sort=sort')).json()) as { items: ExportRecord[] };
    expect(slug.items.map((i) => i.data.author_id)).toEqual(['lan', null, 'lan']);
    const embed = (await (await get('products/export?format=json&relations=embed&fields=author_id&sort=sort')).json()) as { items: ExportRecord[] };
    expect(embed.items[0]!.data.author_id).toBe(authorId);
    expect(embed.items[0]!.data.author).toMatchObject({ name: 'Lan', slug: 'lan' });
    expect(embed.items[1]!.data.author).toBeNull();
  });

  it('streams past one page (keyset paging)', async () => {
    const coll = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'products'))))[0]!.id;
    await db.insert(items).values(
      Array.from({ length: 450 }, (_, i) => ({ siteId: SITE, collectionId: coll, status: 'draft', data: { price: i } })),
    );
    const text = await (await get('products/export?format=csv&fields=price')).text();
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(1 + 453);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(453);
  });

  it('answers 400 before streaming for bad input', async () => {
    expect((await get('products/export?format=xml')).status).toBe(400);
    expect((await get('products/export?fields=nope')).status).toBe(400);
    expect((await get(`products/export?filter=${encodeURIComponent('{"price":{"_bogus":1}}')}`)).status).toBe(400);
    expect((await get(`products/export?filter=${encodeURIComponent('{"a;drop":{"_eq":1}}')}`)).status).toBe(400);
  });

  it('404s for an unknown collection and is not shadowed by /:collection/:id', async () => {
    expect((await get('missing/export')).status).toBe(404);
  });

  it('403s for a principal without read access', async () => {
    principal = STRANGER;
    expect((await get('products/export')).status).toBe(403);
  });

  it('writes an items_exported audit entry', async () => {
    await (await get('products/export?format=json&fields=price')).text();
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'items_exported')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ collection: 'products', format: 'json', fields: ['price'] });
  });
});
