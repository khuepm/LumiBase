import {
  createDb,
  extensions,
  notifications,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { marketplaceRouter } from '../marketplace';

/**
 * Publish fan-out scaling — the notification broadcast to every admin of every
 * site running an outdated install must stay batched (no per-admin round trip).
 *
 * Rewritten to run against a real Postgres (skips when DATABASE_URL is unset):
 * the old mock encoded the pre-security-fix `/publish` contract (no auth, no
 * verify) and a hand-counted query sequence that the moderator gate + signature
 * verification invalidated. Driving the real handler over a real DB keeps the
 * anti-N+1 intent honest and survives future refactors of the query order.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const PUBLISH_ENV = { LUMIBASE_EXT_SIGNATURE_POLICY: 'warn' } as unknown as Record<string, unknown>;

const NUM_SITES = 40;
const ADMINS_PER_SITE = 5;
const PUBLISHER_SITE = 'site_pub';

describe('marketplace publish performance', () => {
  let db: Database;
  let canConnect = false;
  let app: Hono<AppEnv>;
  let publisherId = '';

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
      c.set('siteId', PUBLISHER_SITE);
      c.set('requestId', 'req_perf');
      c.set('runtime', { cache: undefined } as never);
      if (publisherId) c.set('auth', { userId: publisherId, roles: [] } as never);
      await next();
    });
    app.route('/api/v1/marketplace', marketplaceRouter);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.execute(
      sql`TRUNCATE TABLE lumibase_sites, lumibase_extensions, lumibase_user_sites, lumibase_users, lumibase_roles, lumibase_notifications RESTART IDENTITY CASCADE`,
    );
  });

  it('publishes with many sites and admins using a batched notification query', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // Publisher site + an admin-bypass role for the acting publisher.
    await db.insert(sites).values({ id: PUBLISHER_SITE, name: 'Publisher' });
    const [pubRole] = await db
      .insert(roles)
      .values({ siteId: PUBLISHER_SITE, name: 'Publisher Admin', adminAccess: true })
      .returning();
    const [pub] = await db
      .insert(users)
      .values({ email: 'publisher@example.com', status: 'active' })
      .returning();
    await db.insert(userSites).values({ userId: pub!.id, siteId: PUBLISHER_SITE, roleId: pubRole!.id });
    publisherId = pub!.id;

    // The global draft to publish (non-reserved name → warn policy is enough).
    const [draft] = await db
      .insert(extensions)
      .values({
        siteId: null,
        name: 'Perf Ext',
        version: '2.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/perf-2.0.0.js',
        marketplaceSlug: 'perf-ext',
        publishedAt: null,
      })
      .returning();

    // NUM_SITES sites, each with an admin-role, ADMINS_PER_SITE admins, and an
    // outdated (1.0.0) install of the same slug.
    for (let i = 0; i < NUM_SITES; i++) {
      const siteId = `site_${i}`;
      await db.insert(sites).values({ id: siteId, name: `Site ${i}` });
      const [role] = await db
        .insert(roles)
        .values({ siteId, name: 'Site Admin', adminAccess: true })
        .returning();
      const admins = Array.from({ length: ADMINS_PER_SITE }, (_, j) => ({
        email: `admin_${i}_${j}@example.com`,
        status: 'active' as const,
      }));
      const insertedAdmins = await db.insert(users).values(admins).returning({ id: users.id });
      await db.insert(userSites).values(
        insertedAdmins.map((u) => ({ userId: u.id, siteId, roleId: role!.id })),
      );
      await db.insert(extensions).values({
        siteId,
        name: 'Perf Ext',
        version: '1.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/perf-1.0.0.js',
        marketplaceSlug: 'perf-ext',
        enabled: true,
      });
    }

    const payload = {
      extensionId: draft!.id,
      marketplaceSlug: 'perf-ext',
      publisher: 'Publisher',
      signature: 'dummy_sig',
      signatureAlg: 'ed25519',
      publisherKeyId: 'key_1',
      bundleSha256: 'a'.repeat(64),
    };

    const start = performance.now();
    const res = await app.request(
      '/api/v1/marketplace/publish',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      PUBLISH_ENV,
    );
    const end = performance.now();

    if (res.status !== 200) console.error(await res.text());
    expect(res.status).toBe(200);

    // Every admin of every outdated site got exactly one notification — the
    // fan-out is a single batched insert, not N+1.
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications);
    const count = countRows[0]!.count;
    expect(count).toBe(NUM_SITES * ADMINS_PER_SITE);

    // The draft is now live.
    const [published] = await db
      .select()
      .from(extensions)
      .where(and(eq(extensions.id, draft!.id), isNull(extensions.siteId)));
    expect(published!.publishedAt).not.toBeNull();

    console.log(
      `Publish fanned out to ${count} admins across ${NUM_SITES} sites in ${(end - start).toFixed(2)}ms.`,
    );
  });
});
