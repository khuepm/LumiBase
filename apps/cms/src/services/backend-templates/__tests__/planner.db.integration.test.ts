import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  backendTemplatePlans,
  backendTemplateRevisions,
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
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { backendTemplatesRouter } from '../../../routes/backend-templates';
import { SchemaService } from '../../schema-service';
import { BackendTemplateCatalogService } from '../catalog-service';
import { BackendTemplatePlanner, PLAN_TTL_MS, PlanError } from '../planner';

/**
 * #903 (BT03) — planning against REAL PostgreSQL. Fixture per the spec:
 * source catalog on A, target B with an unrelated sentinel collection,
 * admin of A+B, admin of B only.
 */

const A = 'site_903_a';
const B = 'site_903_b';
const ADMIN_AB = 'usr_903_admin';
const ADMIN_B = 'usr_903_admin_b';

const blog = (over: Record<string, unknown> = {}) => ({
  formatVersion: 'lumibase.template@v1',
  slug: 'blog',
  displayName: 'Blog',
  templateVersion: '1.0.0',
  compatibility: { cmsVersionRange: '>=2.0.0', storageModes: ['jsonb'] },
  config: {
    version: 'lumibase.config@v1',
    collections: [{ name: 'writers' }, { name: 'articles' }],
    fields: [
      { collection: 'writers', field: 'name', type: 'string', interface: 'input', required: true },
      { collection: 'articles', field: 'title', type: 'string', interface: 'input', required: true },
      { collection: 'articles', field: 'writer', type: 'string', interface: 'input' },
    ],
    relations: [{ manyCollection: 'articles', manyField: 'writer', oneCollection: 'writers', type: 'm2o' }],
  },
  seedPacks: {
    demo: { records: [{ key: 'w1', collection: 'writers', values: { name: 'Ada' } }] },
  },
  ...over,
});

describe.skipIf(!hasDbIntegrationUrl)('#903 backend template planner — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('backend-template-planner');
  });
  const cleanup = async () => {
    await db.delete(backendTemplateRevisions).where(sql`${backendTemplateRevisions.siteId} IN (${A}, ${B})`);
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN_AB}, ${ADMIN_B})`);
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([{ organizationId: org, id: A, name: '903 A' }, { organizationId: org, id: B, name: '903 B' }]);
    await db.insert(users).values([{ id: ADMIN_AB, email: 'admin-903@example.dev' }, { id: ADMIN_B, email: 'admin-b-903@example.dev' }]);
    await db.insert(roles).values([
      { id: 'role_903_a', siteId: A, name: 'Admin A', adminAccess: true, appAccess: true },
      { id: 'role_903_b', siteId: B, name: 'Admin B', adminAccess: true, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN_AB, siteId: A, roleId: 'role_903_a' },
      { userId: ADMIN_AB, siteId: B, roleId: 'role_903_b' },
      { userId: ADMIN_B, siteId: B, roleId: 'role_903_b' },
    ]);
    // Source catalog on A: blog@1.0.0 published.
    const catalogA = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN_AB });
    const t = await catalogA.createDraft(blog());
    await catalogA.publish(t.id);
    // Target B already has an unrelated collection with a sentinel item.
    const schemaB = new SchemaService({ db, siteId: B });
    await schemaB.createCollection({ name: 'notes' } as never);
    await schemaB.createField('notes', { name: 'text', type: 'string', interface: 'input' } as never);
    const [notes] = await db.select().from(collections).where(and(eq(collections.siteId, B), eq(collections.name, 'notes')));
    await db.insert(items).values({ siteId: B, collectionId: notes!.id, status: 'published', data: { text: 'sentinel' } });
  });

  function api(siteId: string, userId: string) {
    const auth = { type: 'user', userId, email: `${userId}@example.dev`, roles: [], raw: {} } as unknown as AuthPrincipal;
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', auth);
      c.set('runtime', {} as never);
      await next();
    });
    hono.route('/backend-templates', backendTemplatesRouter);
    return async (method: string, path: string, body?: unknown) => {
      const res = await hono.request(`/backend-templates${path}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { LUMIBASE_VERSION: '2.2.0' });
      const text = await res.text();
      if (!text.startsWith('{')) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      return { status: res.status, body: JSON.parse(text) as { data?: any; meta?: any; errors?: Array<Record<string, any>> } };
    };
  }

  /** Everything a plan must not touch: schema rows and content of a site. */
  async function snapshot(siteId: string) {
    const rows = async (table: typeof collections | typeof fields | typeof relations | typeof items) =>
      (await db.select().from(table as typeof collections).where(eq((table as typeof collections).siteId, siteId)))
        .map((r) => JSON.stringify(r)).sort();
    return { collections: await rows(collections), fields: await rows(fields), relations: await rows(relations), items: await rows(items) };
  }

  const ref = { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' };

  it('BT03-AC01 — explicit destination: missing or mismatched targetSiteId fails; a plan for B leaves A unchanged', async () => {
    const asB = api(B, ADMIN_AB);
    expect(await asB('POST', '/plans', { template: ref })).toMatchObject({ status: 400, body: { errors: [{ code: 'MISSING_INPUT' }] } });
    expect(await asB('POST', '/plans', { template: ref, targetSiteId: A })).toMatchObject({ status: 400, body: { errors: [{ code: 'SITE_MISMATCH' }] } });
    const beforeA = await snapshot(A);
    const planned = await asB('POST', '/plans', { template: ref, targetSiteId: B });
    expect(planned.status).toBe(201);
    expect(planned.body.data.report).toMatchObject({
      targetSiteId: B,
      template: { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' },
      counts: { collections: 2, fields: 3, relations: 1, seedRecords: 0 },
      seedPack: null,
      conflicts: [],
      unrelatedCollections: 1,
      storage: { modes: ['jsonb'], transactional: true },
    });
    expect(await snapshot(A)).toEqual(beforeA);
  });

  it('BT03-AC02 — dry-run isolation: target schema and content unchanged; only the site-scoped plan row is written', async () => {
    const beforeB = await snapshot(B);
    const asB = api(B, ADMIN_AB);
    const planned = await asB('POST', '/plans', { template: ref, targetSiteId: B, seedPack: 'demo' });
    expect(planned.status).toBe(201);
    expect(planned.body.data.report.counts.seedRecords).toBe(1);
    expect(await snapshot(B)).toEqual(beforeB);
    const plans = await db.select().from(backendTemplatePlans).where(sql`${backendTemplatePlans.siteId} IN (${A}, ${B})`);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ siteId: B, status: 'planned', seedPack: 'demo', namespaceMap: { writers: 'writers', articles: 'articles' } });
    expect(plans[0]!.expiresAt.getTime() - plans[0]!.createdAt.getTime()).toBeGreaterThan(PLAN_TTL_MS - 60_000);
    expect((await asB('GET', `/plans/${plans[0]!.id}`)).body.data).toMatchObject({ id: plans[0]!.id, status: 'planned' });
    // Another site cannot see the plan.
    expect((await api(A, ADMIN_AB)('GET', `/plans/${plans[0]!.id}`)).status).toBe(404);
  });

  it('BT03-AC03 — conflict policy: unrelated collections stay; a same-name collection is NAME_CONFLICT even if identical; no merge', async () => {
    const schemaB = new SchemaService({ db, siteId: B });
    // Identical schema to the template's `writers` — still a conflict.
    await schemaB.createCollection({ name: 'writers' } as never);
    await schemaB.createField('writers', { name: 'name', type: 'string', interface: 'input', required: true } as never);
    const beforeB = await snapshot(B);
    const asB = api(B, ADMIN_AB);
    const conflict = await asB('POST', '/plans', { template: ref, targetSiteId: B });
    expect(conflict).toMatchObject({ status: 409, body: { errors: [{ code: 'NAME_CONFLICT', conflicts: ['writers'] }] } });
    expect(conflict.body.meta.report).toMatchObject({ conflicts: ['writers'], unrelatedCollections: 1 });
    expect(await db.select().from(backendTemplatePlans).where(eq(backendTemplatePlans.siteId, B))).toEqual([]);
    expect(await snapshot(B)).toEqual(beforeB);
    // A namespace avoids the conflict; the sentinel collection is untouched.
    const namespaced = await asB('POST', '/plans', { template: ref, targetSiteId: B, namespace: { prefix: 'blog_' } });
    expect(namespaced.status).toBe(201);
    expect(namespaced.body.data.report.components.collections).toEqual(['blog_articles', 'blog_writers']);
    expect(namespaced.body.data.report.components.relations).toEqual([{ from: 'blog_articles.writer', to: 'blog_writers', type: 'm2o' }]);
    expect(await snapshot(B)).toEqual(beforeB);
  });

  it('BT03-AC05 — pinned identity: ambiguous names fail, slug+version pins the digest, later source edits do not change the plan', async () => {
    const catalogA = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN_AB });
    const twin = await catalogA.createDraft(blog({ slug: 'blog-two' }));
    await catalogA.publish(twin.id);
    const asB = api(B, ADMIN_AB);
    const ambiguous = await asB('POST', '/plans', { template: { source: 'site', sourceSiteId: A, displayName: 'Blog', version: '1.0.0' }, targetSiteId: B });
    expect(ambiguous).toMatchObject({ status: 409, body: { errors: [{ code: 'AMBIGUOUS_TEMPLATE' }] } });
    expect(ambiguous.body.errors![0]!['candidates']).toHaveLength(2);

    const original = (await db.select().from(backendTemplateRevisions).where(eq(backendTemplateRevisions.siteId, A)))
      .find((r) => (r.document as { slug: string }).slug === 'blog')!;
    const wrongPin = await asB('POST', '/plans', { template: { ...ref, digest: `sha256:${'0'.repeat(64)}` }, targetSiteId: B });
    expect(wrongPin.status).toBe(404);
    const pinned = await asB('POST', '/plans', { template: { ...ref, digest: original.digest }, targetSiteId: B });
    expect(pinned.status).toBe(201);
    expect(pinned.body.data.report.template.digest).toBe(original.digest);

    // The source keeps evolving: the plan keeps its snapshot.
    const blogTemplate = await catalogA.get('blog');
    await catalogA.updateDraft('blog', blog({ templateVersion: '1.1.0', displayName: 'Blog v2' }), blogTemplate.draftRevision!);
    await catalogA.publish('blog');
    const [plan] = await db.select().from(backendTemplatePlans).where(eq(backendTemplatePlans.id, pinned.body.data.id));
    expect(plan).toMatchObject({ digest: original.digest, templateVersion: '1.0.0' });
    expect((plan!.snapshot as { displayName: string }).displayName).toBe('Blog');
  });

  it('source and target are authorized separately: an admin of B alone cannot plan from A\'s catalog', async () => {
    const asAdminB = api(B, ADMIN_B);
    expect(await asAdminB('POST', '/plans', { template: ref, targetSiteId: B })).toMatchObject({ status: 404, body: { errors: [{ code: 'NOT_FOUND' }] } });
  });

  it('BT03-AC06 — stale and incompatible: fingerprint change, expiry or a non-transactional runtime are refused before any target write', async () => {
    const asB = api(B, ADMIN_AB);
    const one = (await asB('POST', '/plans', { template: ref, targetSiteId: B })).body.data.id as string;
    expect((await asB('POST', `/plans/${one}/verify`)).body.data).toMatchObject({ fresh: true });
    // Someone changes B's schema after planning.
    await new SchemaService({ db, siteId: B }).createField('notes', { name: 'extra', type: 'string', interface: 'input' } as never);
    const beforeB = await snapshot(B);
    expect(await asB('POST', `/plans/${one}/verify`)).toMatchObject({ status: 409, body: { errors: [{ code: 'STALE_PLAN' }] } });
    expect((await db.select().from(backendTemplatePlans).where(eq(backendTemplatePlans.id, one)))[0]!.status).toBe('invalidated');
    // Once closed, it stays closed.
    expect((await asB('POST', `/plans/${one}/verify`)).body.errors![0]!['code']).toBe('STALE_PLAN');
    expect(await snapshot(B)).toEqual(beforeB);

    // Expiry, with an injected clock.
    let now = new Date();
    const planner = new BackendTemplatePlanner({
      db, siteId: B, userId: ADMIN_AB, now: () => now,
      dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '2.2.0',
    });
    const { plan } = await planner.plan({ template: ref as never, targetSiteId: B });
    now = new Date(now.getTime() + PLAN_TTL_MS + 1);
    await expect(planner.verify(plan.id)).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect((await planner.get(plan.id)).status).toBe('expired');

    // A runtime without transactions: no plan, and an existing plan cannot be used.
    const noTx = new BackendTemplatePlanner({
      db, siteId: B, transactional: false, dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '2.2.0',
    });
    await expect(noTx.plan({ template: ref as never, targetSiteId: B })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    const fresh = await new BackendTemplatePlanner({ db, siteId: B, dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '2.2.0' })
      .plan({ template: ref as never, targetSiteId: B });
    await expect(noTx.verify(fresh.plan.id)).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });

    // A CMS outside the template's range.
    const old = new BackendTemplatePlanner({ db, siteId: B, dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '1.9.0' });
    await expect(old.plan({ template: ref as never, targetSiteId: B })).rejects.toBeInstanceOf(PlanError);
    await expect(old.plan({ template: ref as never, targetSiteId: B })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect(await snapshot(B)).toEqual(beforeB);
  });

  it('an unknown seed pack and an official template that does not exist are structured errors', async () => {
    const asB = api(B, ADMIN_AB);
    expect((await asB('POST', '/plans', { template: ref, targetSiteId: B, seedPack: 'nope' })).body.errors![0]).toMatchObject({ code: 'INVALID_TEMPLATE', path: '$.seedPack' });
    expect((await asB('POST', '/plans', { template: { source: 'official', slug: 'wordpress-alike', version: '9.9.9' }, targetSiteId: B })).status).toBe(404);
  });
});
