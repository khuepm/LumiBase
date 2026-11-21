import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activity, auditLog, collections, fields, items, notifications, roles, settings, sites, userSites, users, type Database } from '@lumibase/database';
import { buildContentDigest, CONTENT_DIGEST_MARKER, runWeeklyContentDigest } from '../digest';
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

  async function makeUser(email: string, admin = false): Promise<string> {
    await db.delete(users).where(eq(users.email, email));
    const [u] = await db.insert(users).values({ email, status: 'active' }).returning({ id: users.id });
    if (admin) {
      const [role] = await db.insert(roles).values({ siteId: SITE, key: 'administrator', systemKey: 'administrator', name: 'Administrator', adminAccess: true, appAccess: true }).returning({ id: roles.id });
      await db.insert(userSites).values({ userId: u!.id, siteId: SITE, roleId: role!.id });
    }
    return u!.id;
  }

  it('a user account\'s first publish on the site is flagged once (#989)', async () => {
    const userId = await makeUser('ci-989-first@example.com');
    const svc = new ItemService({ db, siteId: SITE, userId });
    await svc.create('articles', { data: { title: 'One', body: 'plain' }, status: 'published' });
    await svc.create('articles', { data: { title: 'Two', body: 'plain' }, status: 'published' });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).toContain('first_publish_by_principal');
    expect((rows[0]!.metadata as { action: string }).action).toBe('notified');
  });

  it('firstPublishSignal: false turns the signal off', async () => {
    await db.insert(settings).values({ siteId: SITE, key: 'contentIntegrity', value: { firstPublishSignal: false } });
    const userId = await makeUser('ci-989-off@example.com');
    await new ItemService({ db, siteId: SITE, userId }).create('articles', { data: { title: 'One', body: 'plain' }, status: 'published' });
    expect(await alerts()).toHaveLength(0);
  });

  it('the digest lists what went live by account, and the alerts by signal', async () => {
    const userId = await makeUser('ci-989-digest@example.com');
    const svc = new ItemService({ db, siteId: SITE, userId });
    await svc.create('articles', { data: lure, status: 'published' });
    await svc.create('articles', { data: { title: 'Fine', body: 'plain' }, status: 'published' });
    await svc.create('articles', { data: { title: 'Draft', body: 'plain' } });
    const digest = await buildContentDigest({ db, siteId: SITE });
    expect(digest.published.total).toBe(2);
    expect(digest.published.byPrincipal).toEqual([{ userId, email: 'ci-989-digest@example.com', count: 2 }]);
    expect(digest.published.items.map((i) => i.collection)).toEqual(['articles', 'articles']);
    expect(digest.alerts.bySignal.download_link).toBe(1);
    expect(digest.alerts.bySignal.first_publish_by_principal).toBe(1);
  });

  it('the weekly digest notifies site admins once per 7 days', async () => {
    const adminId = await makeUser('ci-989-admin@example.com', true);
    await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'Live', body: 'plain' }, status: 'published' });
    const sentTo = async () => db.select().from(notifications).where(and(eq(notifications.siteId, SITE), eq(notifications.collection, CONTENT_DIGEST_MARKER)));
    await runWeeklyContentDigest({ db });
    expect((await sentTo()).map((n) => n.recipient)).toEqual([adminId]);
    await runWeeklyContentDigest({ db, now: Date.now() + 3 * 24 * 60 * 60 * 1000 });
    expect(await sentTo()).toHaveLength(1);
  });

  it('weeklyDigest: false sends nothing', async () => {
    await db.insert(settings).values({ siteId: SITE, key: 'contentIntegrity', value: { weeklyDigest: false } });
    await makeUser('ci-989-admin2@example.com', true);
    await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'Live', body: 'plain' }, status: 'published' });
    await runWeeklyContentDigest({ db });
    expect(await db.select().from(notifications).where(eq(notifications.siteId, SITE))).toHaveLength(0);
  });
});
