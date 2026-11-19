import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activity, auditLog, collections, fields, items, settings, sites, type Database } from '@lumibase/database';
import { ItemService } from '../../../services/item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';

/**
 * #989 end to end: a write that leaves a lure link live raises an alert, and
 * under the site's `unpublish` policy the item is back in draft before the
 * write returns, with an `integrity_unpublish` activity row.
 */

const SITE = 'site_ci_989';

describe.skipIf(!hasDbIntegrationUrl)('content integrity — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('content-integrity');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: 'CI 989' });
    const [coll] = await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'body', type: 'text', interface: 'input' },
    ]);
  });

  const lure = { title: 'Zoning government definition', body: 'Download: https://files.evil.example/zoning-contract.zip' };

  async function alerts() {
    return db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'content_integrity_alert')));
  }

  it('notify (default): the item stays live and an alert is recorded', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    const created = (await svc.create('articles', { data: lure, status: 'published' })) as { id: string; status: string };
    expect(created.status).toBe('published');
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).toContain('download_link');
  });

  it('unpublish: the item goes back to draft with an activity row', async () => {
    await db.insert(settings).values({ siteId: SITE, key: 'contentIntegrity', value: { action: 'unpublish' } });
    const svc = new ItemService({ db, siteId: SITE });
    const created = (await svc.create('articles', { data: lure, status: 'published' })) as { id: string; status: string };
    expect(created.status).toBe('draft');
    const [stored] = await db.select({ status: items.status }).from(items).where(eq(items.id, created.id));
    expect(stored!.status).toBe('draft');
    const acts = await db.select().from(activity).where(and(eq(activity.siteId, SITE), eq(activity.action, 'integrity_unpublish')));
    expect(acts).toHaveLength(1);
  });

  it('a clean publish raises nothing', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    await svc.create('articles', { data: { title: 'Hello', body: 'See https://wikipedia.org/' }, status: 'published' });
    expect(await alerts()).toHaveLength(0);
  });

  it('drafts are not scanned', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    await svc.create('articles', { data: lure });
    expect(await alerts()).toHaveLength(0);
  });
});
