import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq, like } from 'drizzle-orm';
import { auditLog, collections, fields, items, roles, sites, userSites, users, type Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { ReleaseService, sweepDueReleases } from '../../services/release-service';
import { releasesRouter } from '../releases';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Route-level audit tests for Content Releases (task 8.2 — Req 12.1-12.4):
 * every publish outcome writes the right `release_*` audit event with
 * counts-only metadata (`releaseId`/`trigger`/`itemCount`/`failedCount`,
 * never item content), for manual success / partial / failed via the route
 * and scheduled success via the sweep. Skips without DATABASE_URL (runs in CI).
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.4**
 */

const SITE = 'site_rel_audit_it';
const ADMIN = 'usr_rel_audit_admin';
const ADMIN_EMAIL = 'rel-audit-admin@x.dev';

describe.skipIf(!hasDbIntegrationUrl)('releases route — publish audit (DB integration)', () => {
  let db: Database;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: ADMIN, email: ADMIN_EMAIL, roles: ['admin'], raw: { dev: true } } as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/releases', releasesRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('releases-route-audit');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(auditLog).where(eq(auditLog.siteId, SITE));
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Release Audit IT' });
    // The route publishes through itemServiceForRequest → real RBAC: seed an
    // admin membership so the request principal has admin bypass.
    await db.insert(users).values({ id: ADMIN, email: ADMIN_EMAIL, status: 'active' }).onConflictDoNothing();
    const adminRole = (
      await db
        .insert(roles)
        .values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true })
        .returning({ id: roles.id })
    )[0]!.id;
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole });
    const articles = (
      await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id })
    )[0]!.id;
    const gated = (
      await db
        .insert(collections)
        .values({ siteId: SITE, name: 'gated', label: 'Gated', meta: { editorialWorkflow: true } })
        .returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: articles, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: gated, name: 'title', type: 'string', interface: 'input' },
    ]);
  });

  async function makeItem(collection: string, title: string): Promise<string> {
    const created = await new ItemService({ db, siteId: SITE }).create(collection, { data: { title } });
    return (created as { id: string }).id;
  }

  async function releaseAudits() {
    return db
      .select({ event: auditLog.event, actorEmail: auditLog.actorEmail, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE), like(auditLog.event, 'release_%')))
      .orderBy(asc(auditLog.timestamp));
  }

  async function publishViaRoute(releaseId: string) {
    return app.request(`/api/v1/releases/${releaseId}/publish`, { method: 'POST' });
  }

  it('manual success → release_published with counts-only metadata (Req 12.1, 12.4)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'OK' });
    const a = await makeItem('articles', 'A');
    await svc.patch(release!.id, { addItems: [{ collection: 'articles', itemId: a, targetStatus: 'published' }] });

    const res = await publishViaRoute(release!.id);
    expect(res.status).toBe(200);

    const audits = await releaseAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('release_published');
    expect(audits[0]!.actorEmail).toBe(ADMIN_EMAIL);
    expect(audits[0]!.metadata).toEqual({ releaseId: release!.id, trigger: 'manual', itemCount: 1, failedCount: 0 });
    // Req 12.4: counts/ids only — no item content in the audit row.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('title');
  });

  it('manual partial (best_effort, editorial gate) → release_partially_published (Req 12.2)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Mixed', atomicityMode: 'best_effort' });
    const ok = await makeItem('gated', 'Approved');
    const blocked = await makeItem('gated', 'Draft');
    await db.update(items).set({ editorialState: 'approved' }).where(eq(items.id, ok));
    await svc.patch(release!.id, {
      addItems: [
        { collection: 'gated', itemId: ok, targetStatus: 'published' },
        { collection: 'gated', itemId: blocked, targetStatus: 'published' },
      ],
    });

    const res = await publishViaRoute(release!.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('partially_failed');

    const audits = await releaseAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('release_partially_published');
    expect(audits[0]!.metadata).toMatchObject({ releaseId: release!.id, trigger: 'manual', itemCount: 2, failedCount: 1 });
  });

  it('manual failed (all_or_nothing, deleted item blocks preflight) → release_publish_failed (Req 12.3)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    const release = await svc.create({ name: 'Blocked', atomicityMode: 'all_or_nothing' });
    const a = await makeItem('articles', 'A');
    await svc.patch(release!.id, { addItems: [{ collection: 'articles', itemId: a, targetStatus: 'published' }] });
    await new ItemService({ db, siteId: SITE }).softDelete('articles', a);

    const res = await publishViaRoute(release!.id);
    expect(res.status).toBe(200);

    const audits = await releaseAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('release_publish_failed');
    expect(audits[0]!.metadata).toMatchObject({ releaseId: release!.id, trigger: 'manual', failedCount: 1 });
  });

  it('scheduled success via sweep → release_published with trigger scheduled (Req 12.1)', async () => {
    const svc = new ReleaseService({ db, siteId: SITE });
    // create() rejects a past publishAt, so schedule in the future and run
    // the sweep with a `now` beyond it.
    const publishAt = new Date(Date.now() + 60_000);
    const release = await svc.create({ name: 'Sched', publishAt });
    expect(release!.status).toBe('scheduled');
    const a = await makeItem('articles', 'A');
    await svc.patch(release!.id, { addItems: [{ collection: 'articles', itemId: a, targetStatus: 'published' }] });

    // The sweep is not site-scoped (shared test DB may hold other due
    // releases); the audit assertion below IS scoped to this site.
    const swept = await sweepDueReleases({ db }, new Date(publishAt.getTime() + 1000));
    expect(swept).toBeGreaterThanOrEqual(1);

    const audits = await releaseAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('release_published');
    expect(audits[0]!.actorEmail).toBeNull(); // no request actor on the sweep
    expect(audits[0]!.metadata).toEqual({ releaseId: release!.id, trigger: 'scheduled', itemCount: 1, failedCount: 0 });
  });
});
