import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dashboardLayouts, sites, users, type Database } from '@lumibase/database';
import { DEFAULT_DASHBOARD_LAYOUT } from '@lumibase/contracts';
import { DashboardLayoutService } from '../dashboard-layout-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Studio home dashboard layouts (#691) against REAL PostgreSQL: per-user and
 * per-site storage, fallback order, validation, isolation between sites.
 * Skips without DATABASE_URL (runs in the CI `db-integration` job).
 */

const SITE_A = 'site_691_a';
const SITE_B = 'site_691_b';
const USER_1 = 'user_691_1';
const USER_2 = 'user_691_2';

const layout = (title: string) => ({
  version: 1 as const,
  widgets: [{ id: 'note', type: 'note', x: 0, y: 0, w: 4, h: 2, title }],
});

describe.skipIf(!hasDbIntegrationUrl)('#691 dashboard layouts — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('dashboard-layout');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(sql`${sites.id} in (${SITE_A}, ${SITE_B})`).catch(() => undefined);
    await db.delete(users).where(sql`${users.id} in (${USER_1}, ${USER_2})`).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} in (${SITE_A}, ${SITE_B})`);
    await db.delete(users).where(sql`${users.id} in (${USER_1}, ${USER_2})`);
    for (const id of [SITE_A, SITE_B]) {
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id,
        name: id,
      });
    }
    await db.insert(users).values([
      { id: USER_1, email: `${USER_1}@example.test` },
      { id: USER_2, email: `${USER_2}@example.test` },
    ]);
  });

  it('falls back user → site default → built-in default', async () => {
    const svc = new DashboardLayoutService({ db, siteId: SITE_A });
    expect(await svc.effective(USER_1)).toMatchObject({ layout: null, source: 'default' });

    await svc.save(null, layout('site'), USER_2);
    expect(await svc.effective(USER_1)).toMatchObject({ source: 'site', layout: { widgets: [{ title: 'site' }] } });

    await svc.save(USER_1, layout('mine'), USER_1);
    expect(await svc.effective(USER_1)).toMatchObject({ source: 'user', layout: { widgets: [{ title: 'mine' }] } });
    // Another user still sees the site default.
    expect(await svc.effective(USER_2)).toMatchObject({ source: 'site' });

    await svc.reset(USER_1);
    expect(await svc.effective(USER_1)).toMatchObject({ source: 'site' });
    await svc.reset(null);
    expect(await svc.effective(USER_1)).toMatchObject({ source: 'default' });
  });

  it('keeps one row per user and one default per site, updating in place', async () => {
    const svc = new DashboardLayoutService({ db, siteId: SITE_A });
    await svc.save(USER_1, layout('a'), USER_1);
    await svc.save(USER_1, layout('b'), USER_1);
    await svc.save(null, DEFAULT_DASHBOARD_LAYOUT, USER_1);
    await svc.save(null, layout('site-2'), USER_1);
    const rows = await db.select().from(dashboardLayouts).where(eq(dashboardLayouts.siteId, SITE_A));
    expect(rows).toHaveLength(2);
    expect((await svc.effective(USER_1)).layout?.widgets[0]?.title).toBe('b');
    expect((await svc.siteDefault()).layout?.widgets[0]?.title).toBe('site-2');
  });

  it('isolates sites', async () => {
    await new DashboardLayoutService({ db, siteId: SITE_A }).save(USER_1, layout('a'), USER_1);
    await new DashboardLayoutService({ db, siteId: SITE_A }).save(null, layout('a-default'), USER_1);
    expect(await new DashboardLayoutService({ db, siteId: SITE_B }).effective(USER_1)).toMatchObject({
      source: 'default',
      layout: null,
    });
  });

  it('rejects invalid layouts', async () => {
    const svc = new DashboardLayoutService({ db, siteId: SITE_A });
    await expect(svc.save(USER_1, { version: 1, widgets: [{ id: 'x', type: 'note', x: 10, y: 0, w: 4, h: 1 }] }, USER_1)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      svc.save(USER_1, { version: 1, widgets: [{ id: 'x', type: 'Bad Type', x: 0, y: 0, w: 1, h: 1 }] }, USER_1),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      svc.save(USER_1, { version: 1, widgets: [{ id: 'x', type: 'note', x: 0, y: 0, w: 1, h: 1, config: { blob: 'x'.repeat(5000) } }] }, USER_1),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.save(USER_1, null, USER_1)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('ignores a stored row that no longer validates', async () => {
    await db.insert(dashboardLayouts).values({ siteId: SITE_A, userId: USER_1, layout: { version: 2 } });
    expect(await new DashboardLayoutService({ db, siteId: SITE_A }).effective(USER_1)).toMatchObject({ source: 'default' });
  });
});
