import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import {
  schema,
  backendTemplateInstallations,
  backendTemplatePlans,
  backendTemplateRevisions,
  backendTemplates,
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
import { createSiteScopedSql } from '@lumibase/runtime';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { createRlsTestDatabase, type RlsTestDatabase } from '../../../test-utils/rls-roles';
import { ItemService } from '../../item-service';
import { BackendTemplateCatalogService } from '../catalog-service';
import { BackendTemplateInstaller } from '../installer';
import { BackendTemplatePlanner } from '../planner';
import { createSeedWriter } from '../seed-writer';

/**
 * #909 (BT09-AC02) — tenant guard across the whole backend template feature,
 * on REAL PostgreSQL with row-level security and a NOSUPERUSER NOBYPASSRLS
 * application role: catalog, revisions, plans, installations, the schema an
 * install creates and the seed content it writes.
 *
 * Two principals: the admin of site A and the admin of site B. Each installs
 * `wordpress-alike` with the demo pack THROUGH THE APP ROLE scoped to its own
 * site, so the install itself runs under RLS. Then each scope is asked for the
 * other's rows, with and without a site filter.
 */

const A = 'site_909_rls_a';
const B = 'site_909_rls_b';

describe.skipIf(!hasDbIntegrationUrl)('#909 backend templates — tenant isolation under real RLS', () => {
  let fx: RlsTestDatabase;
  let ownerSql: ReturnType<typeof postgres>;
  let appSql: ReturnType<typeof postgres>;
  let owner: Database;

  beforeAll(async () => {
    // Fails the suite (rather than skipping it) when the configured DB is unreachable.
    await connectDbIntegration('backend-template-isolation');
    fx = await createRlsTestDatabase(dbIntegrationUrl!);
    ownerSql = postgres(fx.ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
    owner = drizzle(ownerSql, { schema }) as unknown as Database;
    appSql = postgres(fx.appUrl, { max: 2, prepare: false, onnotice: () => {} });
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await owner.insert(sites).values([{ organizationId: org, id: A, name: 'A' }, { organizationId: org, id: B, name: 'B' }]);
    for (const site of [A, B]) {
      await owner.insert(users).values({ id: `usr_${site}`, email: `${site}@example.dev` });
      await owner.insert(roles).values({ id: `role_${site}`, siteId: site, name: 'Admin', adminAccess: true, appAccess: true });
      await owner.insert(userSites).values({ userId: `usr_${site}`, siteId: site, roleId: `role_${site}` });
    }
  }, 120_000);

  afterAll(async () => {
    await appSql?.end();
    await ownerSql?.end();
    if (fx) await fx.drop();
  });

  const scoped = (site: string) => drizzle(createSiteScopedSql(appSql, site), { schema }) as unknown as Database;

  async function installAs(site: string) {
    const db = scoped(site);
    const userId = `usr_${site}`;
    const items = (tx: Database) => new ItemService({
      db: tx, siteId: site, userId, suppressExtensionHooks: true,
      permissionCtx: { userId, siteId: site, roleId: `role_${site}`, ip: null, headers: {} },
    });
    const { plan } = await new BackendTemplatePlanner({ db, siteId: site, userId, cmsVersion: '2.2.0' }).plan({
      template: { source: 'official', slug: 'wordpress-alike', version: '1.0.0' } as never,
      targetSiteId: site,
      seedMode: 'pack',
      seedPack: 'demo',
    });
    const { installation } = await new BackendTemplateInstaller({
      db, siteId: site, userId, authorize: async () => true, seed: createSeedWriter(items),
    }).install({ planId: plan.id, idempotencyKey: `rls-${site}` });
    // A private catalog entry too, so the catalog tables carry rows for both sites.
    const catalog = new BackendTemplateCatalogService({ db, siteId: site, userId });
    const draft = await catalog.capture({ collections: ['tags'], slug: `tags-${site.slice(-1)}`, displayName: 'Tags', cmsVersionRange: '>=2.0.0' });
    await catalog.publish(draft.id);
    return { plan, installation, templateId: draft.id };
  }

  it('BT09-AC02 — each admin installs under RLS; neither scope can read, find or write the other site\'s rows', async () => {
    const a = await installAs(A);
    const b = await installAs(B);
    expect(a.installation.resources).toMatchObject({ seedRecords: 17 });
    expect(b.installation.resources).toMatchObject({ seedRecords: 17 });

    const tables = { backendTemplates, backendTemplateRevisions, backendTemplatePlans, backendTemplateInstallations, collections, fields, relations, items };
    for (const [site, other] of [[A, B], [B, A]] as const) {
      const db = scoped(site);
      for (const [name, table] of Object.entries(tables)) {
        // No site filter at all: RLS alone must keep the other site out.
        const rows = (await db.select().from(table as typeof items)) as Array<{ siteId: string }>;
        expect(rows.length, `${site} sees its own ${name}`).toBeGreaterThan(0);
        expect(rows.filter((r) => r.siteId !== site), `${site} leaks ${name} of ${other}`).toEqual([]);
      }
      // The services, asked for the other site's ids from this scope, find nothing.
      const theirs = site === A ? b : a;
      await expect(new BackendTemplatePlanner({ db, siteId: site }).get(theirs.plan.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(new BackendTemplateInstaller({ db, siteId: site }).get(theirs.installation.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(new BackendTemplateCatalogService({ db, siteId: site }).get(theirs.templateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A write that names the other site is refused by WITH CHECK.
      await expect(
        db.insert(backendTemplatePlans).values({
          siteId: other, sourceKind: 'official', slug: 'x', templateVersion: '1.0.0', digest: 'sha256:x', snapshot: {},
          namespaceMap: {}, targetFingerprint: 'x', inventory: {}, expiresAt: new Date(),
        }),
      ).rejects.toThrow();
    }

    // Without a site scope the app role sees nothing.
    const unscoped = drizzle(appSql, { schema }) as unknown as Database;
    for (const table of [backendTemplatePlans, backendTemplateInstallations, items]) {
      expect(await unscoped.select().from(table as typeof items)).toEqual([]);
    }
  });
});
