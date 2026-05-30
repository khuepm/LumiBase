import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createDb,
  extensions,
  userSites,
  users,
  notifications,
  type Database,
} from '@lumibase/database';
import { marketplaceRouter } from '../routes/marketplace';
import type { AppEnv } from '../env';

const TEST_DATABASE_URL = process.env.DATABASE_URL;

describe('Marketplace Versioning & Updates — integration', () => {
  let db: Database;
  let canConnect = false;
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      canConnect = false;
    }

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', 'site_demo');
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/api/v1/marketplace', marketplaceRouter);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.execute(
      sql`TRUNCATE TABLE extensions, user_sites, users, notifications RESTART IDENTITY CASCADE`,
    );
  });

  it('correctly discovers updates for installed extensions', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // 1. Insert global marketplace extensions (siteId IS NULL)
    // - seo-plugin version 1.0.0
    // - seo-plugin version 1.1.0
    // - seo-plugin version 1.2.0 (latest)
    // - another-plugin version 2.0.0
    await db.insert(extensions).values([
      {
        siteId: null,
        name: 'SEO Plugin',
        version: '1.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/seo-1.0.0.js',
        marketplaceSlug: 'seo-plugin',
        publishedAt: new Date(),
      },
      {
        siteId: null,
        name: 'SEO Plugin',
        version: '1.2.0',
        type: 'module',
        bundleUrl: 'http://cdn/seo-1.2.0.js',
        marketplaceSlug: 'seo-plugin',
        publishedAt: new Date(),
      },
      {
        siteId: null,
        name: 'SEO Plugin',
        version: '1.1.0',
        type: 'module',
        bundleUrl: 'http://cdn/seo-1.1.0.js',
        marketplaceSlug: 'seo-plugin',
        publishedAt: new Date(),
      },
      {
        siteId: null,
        name: 'Another Plugin',
        version: '2.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/another-2.0.0.js',
        marketplaceSlug: 'another-plugin',
        publishedAt: new Date(),
      },
    ]);

    // 2. Insert installed extension on site_demo (siteId = 'site_demo')
    // - seo-plugin installed with current version 1.0.0
    // - another-plugin installed with current version 2.0.0 (already up-to-date)
    await db.insert(extensions).values([
      {
        siteId: 'site_demo',
        name: 'SEO Plugin',
        version: '1.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/seo-1.0.0.js',
        marketplaceSlug: 'seo-plugin',
        enabled: true,
      },
      {
        siteId: 'site_demo',
        name: 'Another Plugin',
        version: '2.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/another-2.0.0.js',
        marketplaceSlug: 'another-plugin',
        enabled: true,
      },
    ]);

    // 3. Request updates
    const res = await app.request('/api/v1/marketplace/updates');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Array<{ name: string; currentVersion: string; latestVersion: string; bundleUrl: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      name: 'SEO Plugin',
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      bundleUrl: 'http://cdn/seo-1.2.0.js',
    });
  });

  it('triggers updates notification when publishing a new version', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // 1. Insert a user and link to site_demo
    const [usr] = await db.insert(users).values({
      email: 'admin@example.com',
      status: 'active',
    }).returning();

    await db.insert(userSites).values({
      userId: usr!.id,
      siteId: 'site_demo',
    });

    // 2. Create a global extension row representing the unpublished draft
    const [draft] = await db.insert(extensions).values({
      siteId: null,
      name: 'Analytics Tool',
      version: '2.0.0',
      type: 'module',
      bundleUrl: 'http://cdn/analytics-2.0.0.js',
      marketplaceSlug: 'analytics-tool',
      publishedAt: null, // draft
    }).returning();

    // 3. Create an installed outdated extension on site_demo
    await db.insert(extensions).values({
      siteId: 'site_demo',
      name: 'Analytics Tool',
      version: '1.0.0',
      type: 'module',
      bundleUrl: 'http://cdn/analytics-1.0.0.js',
      marketplaceSlug: 'analytics-tool',
      enabled: true,
    });

    // 4. Publish the draft via POST /publish
    const publishPayload = {
      extensionId: draft!.id,
      marketplaceSlug: 'analytics-tool',
      publisher: 'Acme Corp',
      signature: 'sig-abc-123',
      signatureAlg: 'ed25519',
      publisherKeyId: 'acme-key-2025',
      bundleSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };


    const res = await app.request('/api/v1/marketplace/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(publishPayload),
    });

    expect(res.status).toBe(200);

    // 5. Verify a notification was channelling/persisted for usr.id in site_demo
    const notifyRows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipient, usr!.id));

    expect(notifyRows).toHaveLength(1);
    expect(notifyRows[0]!.subject).toBe('Extension Update Available');
    expect(notifyRows[0]!.message).toContain("A new version 2.0.0 of extension 'Analytics Tool' is available. You are currently running 1.0.0.");
    expect(notifyRows[0]!.siteId).toBe('site_demo');
  });
});
