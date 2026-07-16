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
  roles,
  sites,
  userSites,
  users,
  notifications,
  type Database,
} from '@lumibase/database';
import { marketplaceRouter } from '../routes/marketplace';
import type { AppEnv } from '../env';

const TEST_DATABASE_URL = process.env.DATABASE_URL;

// Third-party (non-reserved) publish: the bundle URL is unreachable in tests,
// so `warn` keeps signature verification non-blocking while still exercising
// the real gate + verify code path. Reserved `lumibase-*` would still be
// fail-closed regardless of this.
const PUBLISH_ENV = { LUMIBASE_EXT_SIGNATURE_POLICY: 'warn' } as unknown as Record<string, unknown>;

describe('Marketplace Versioning & Updates — integration', () => {
  let db: Database;
  let canConnect = false;
  let app: Hono<AppEnv>;
  // Mutable per-test auth principal + membership role, read by the middleware.
  let actingUserId: string | null = null;

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
      // PermissionService reads the cache off the runtime; undefined is fine.
      c.set('runtime', { cache: undefined } as never);
      // Admin-bypass comes from the user's `user_sites` role in the DB, resolved
      // by PermissionService — not from anything on the request context.
      if (actingUserId) c.set('auth', { userId: actingUserId, roles: [] } as never);
      await next();
    });
    app.route('/api/v1/marketplace', marketplaceRouter);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    actingUserId = null;
    await db.execute(
      sql`TRUNCATE TABLE lumibase_sites, lumibase_extensions, lumibase_user_sites, lumibase_users, lumibase_roles, lumibase_notifications RESTART IDENTITY CASCADE`,
    );
    // Every site-scoped row (roles, user_sites, installed extensions) FKs to
    // this row, so create it up front — the suite must not depend on seed data.
    await db.insert(sites).values({ id: 'site_demo', name: 'Demo Site' });
  });

  /** Seed an admin-bypass role in site_demo and a user holding it. */
  async function seedAdmin(email: string): Promise<{ userId: string; roleId: string }> {
    const [role] = await db
      .insert(roles)
      .values({ siteId: 'site_demo', name: `Admin ${email}`, adminAccess: true })
      .returning();
    const [usr] = await db.insert(users).values({ email, status: 'active' }).returning();
    await db.insert(userSites).values({ userId: usr!.id, siteId: 'site_demo', roleId: role!.id });
    return { userId: usr!.id, roleId: role!.id };
  }

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

    // 1. Insert an admin user linked to site_demo (also the acting publisher).
    const { userId } = await seedAdmin('admin@example.com');
    const usr = { id: userId };
    actingUserId = userId;

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
    }, PUBLISH_ENV);

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

  // ── Security regression: /publish is a privileged, moderated write ─────────
  // Guards the fix for the v0.18.0→HEAD security review finding — publishing to
  // the shared global catalog must require the `extensions:configure`
  // capability and must not skip community moderation.

  async function seedDraft(overrides: Record<string, unknown> = {}): Promise<string> {
    const [draft] = await db
      .insert(extensions)
      .values({
        siteId: null,
        name: 'Analytics Tool',
        version: '2.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/analytics-2.0.0.js',
        marketplaceSlug: 'analytics-tool',
        publishedAt: null,
        ...overrides,
      })
      .returning();
    return draft!.id;
  }

  function publishReq(extensionId: string) {
    return app.request(
      '/api/v1/marketplace/publish',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          extensionId,
          marketplaceSlug: 'analytics-tool',
          publisher: 'Acme Corp',
          signature: 'sig-abc-123',
          signatureAlg: 'ed25519',
          publisherKeyId: 'acme-key-2025',
          bundleSha256: 'a'.repeat(64),
        }),
      },
      PUBLISH_ENV,
    );
  }

  it('rejects publish from a caller without extensions:configure (was: any signed-in user)', async () => {
    if (!canConnect) return;
    const draftId = await seedDraft();

    // A signed-in user who is a plain member (no admin/configure) of the site.
    const [role] = await db
      .insert(roles)
      .values({ siteId: 'site_demo', name: 'Member', adminAccess: false, appAccess: true })
      .returning();
    const [usr] = await db.insert(users).values({ email: 'member@example.com', status: 'active' }).returning();
    await db.insert(userSites).values({ userId: usr!.id, siteId: 'site_demo', roleId: role!.id });
    actingUserId = usr!.id;

    const res = await publishReq(draftId);
    expect(res.status).toBe(403);

    // The row stays unpublished — the badge/catalog can't be spoofed.
    const [row] = await db.select().from(extensions).where(eq(extensions.id, draftId));
    expect(row!.publishedAt).toBeNull();
  });

  it('refuses to publish a community submission that has not been approved', async () => {
    if (!canConnect) return;
    const { userId } = await seedAdmin('mod@example.com');
    actingUserId = userId;

    const pendingId = await seedDraft({ submissionStatus: 'pending', submittedBy: userId });
    const res = await publishReq(pendingId);
    expect(res.status).toBe(409);

    const [row] = await db.select().from(extensions).where(eq(extensions.id, pendingId));
    expect(row!.publishedAt).toBeNull();

    // Once approved, the same moderator can publish it.
    await db
      .update(extensions)
      .set({ submissionStatus: 'approved' })
      .where(eq(extensions.id, pendingId));
    const ok = await publishReq(pendingId);
    expect(ok.status).toBe(200);
  });
});
