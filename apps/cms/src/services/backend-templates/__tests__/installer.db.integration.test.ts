import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  backendTemplateInstallations,
  backendTemplatePlans,
  backendTemplateRevisions,
  cdcChangeEvents,
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
import { MemoryCacheProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { backendTemplatesRouter } from '../../../routes/backend-templates';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { SchemaService } from '../../schema-service';
import { BackendTemplateCatalogService } from '../catalog-service';
import { BackendTemplatePlanner } from '../planner';
import { BackendTemplateInstaller, InstallError, type InstallStep, type InstallerDeps, type SeedHook } from '../installer';

/**
 * #904 (BT04) — atomic, governed installation against REAL PostgreSQL:
 * commit, fault injection at every step, 10 concurrent identical requests,
 * idempotency-key misuse, apply races, crash recovery and commit effects.
 */

const A = 'site_904_a';
const B = 'site_904_b';
const ADMIN = 'usr_904_admin';

const blog = {
  formatVersion: 'lumibase.template@v1',
  slug: 'blog',
  displayName: 'Blog',
  templateVersion: '1.0.0',
  compatibility: { cmsVersionRange: '>=2.0.0', storageModes: ['jsonb'] },
  config: {
    version: 'lumibase.config@v1',
    collections: [{ name: 'writers', label: 'Writers' }, { name: 'articles', label: 'Articles' }],
    fields: [
      { collection: 'writers', field: 'name', type: 'string', interface: 'input', required: true },
      { collection: 'articles', field: 'title', type: 'string', interface: 'input', required: true },
      { collection: 'articles', field: 'writer', type: 'string', interface: 'input' },
    ],
    relations: [{ manyCollection: 'articles', manyField: 'writer', oneCollection: 'writers', type: 'm2o' }],
  },
  seedPacks: { demo: { records: [{ key: 'w1', collection: 'writers', values: { name: 'Ada' } }] } },
};

describe.skipIf(!hasDbIntegrationUrl)('#904 backend template installer — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('backend-template-installer');
  });
  const cleanup = async () => {
    await db.delete(backendTemplateRevisions).where(sql`${backendTemplateRevisions.siteId} IN (${A}, ${B})`);
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(eq(users.id, ADMIN));
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([{ organizationId: org, id: A, name: '904 A' }, { organizationId: org, id: B, name: '904 B' }]);
    await db.insert(users).values({ id: ADMIN, email: 'admin-904@example.dev' });
    await db.insert(roles).values([
      { id: 'role_904_a', siteId: A, name: 'Admin A', adminAccess: true, appAccess: true },
      { id: 'role_904_b', siteId: B, name: 'Admin B', adminAccess: true, appAccess: true },
    ]);
    await db.insert(userSites).values([{ userId: ADMIN, siteId: A, roleId: 'role_904_a' }, { userId: ADMIN, siteId: B, roleId: 'role_904_b' }]);
    const catalog = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN });
    await catalog.publish((await catalog.createDraft(blog)).id);
    // Unrelated sentinel content in B.
    const schemaB = new SchemaService({ db, siteId: B });
    await schemaB.createCollection({ name: 'notes' } as never);
    await schemaB.createField('notes', { name: 'text', type: 'string', interface: 'input' } as never);
    const [notes] = await db.select().from(collections).where(and(eq(collections.siteId, B), eq(collections.name, 'notes')));
    await db.insert(items).values({ siteId: B, collectionId: notes!.id, status: 'published', data: { text: 'sentinel' } });
  });

  const planner = () => new BackendTemplatePlanner({ db, siteId: B, userId: ADMIN, dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '2.2.0' });
  const plan = async (over: Record<string, unknown> = {}) =>
    (await planner().plan({ template: { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' } as never, targetSiteId: B, ...over })).plan;
  const installer = (over: Partial<InstallerDeps> = {}) => new BackendTemplateInstaller({ db, siteId: B, userId: ADMIN, authorize: async () => true, ...over });

  /** Test seed hook: writes items through the transaction (BT05 supplies the real one). */
  const seedStub: SeedHook = async ({ tx, siteId, template, pack }) => {
    const keys: Record<string, string> = {};
    for (const record of template.seedPacks![pack]!.records) {
      const [col] = await tx.select().from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, record.collection)));
      const [row] = await tx.insert(items).values({ siteId, collectionId: col!.id, status: 'draft', data: record.values }).returning();
      keys[record.key] = row!.id;
    }
    return { records: Object.keys(keys).length, keys };
  };

  async function snapshot(siteId = B) {
    const rows = async (table: typeof collections) =>
      (await db.select().from(table).where(eq(table.siteId, siteId))).map((r) => JSON.stringify(r)).sort();
    return {
      collections: await rows(collections),
      fields: await rows(fields as unknown as typeof collections),
      relations: await rows(relations as unknown as typeof collections),
      items: await rows(items as unknown as typeof collections),
      cdc: (await db.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.siteId, siteId))).length,
      installations: (await db.select().from(backendTemplateInstallations).where(eq(backendTemplateInstallations.siteId, siteId))).length,
    };
  }
  const names = async () => (await db.select({ name: collections.name }).from(collections).where(eq(collections.siteId, B))).map((r) => r.name).sort();

  it('BT04-AC01 — complete commit: schema and provenance appear together with digest, namespace and seed choice', async () => {
    const p = await plan({ namespace: { prefix: 'blog_' } });
    const { installation, replayed } = await installer().install({ planId: p.id, idempotencyKey: 'key-1' });
    expect(replayed).toBe(false);
    expect(await names()).toEqual(['blog_articles', 'blog_writers', 'notes']);
    const [rel] = await db.select().from(relations).where(eq(relations.siteId, B));
    expect(rel).toMatchObject({ manyCollection: 'blog_articles', manyField: 'writer', oneCollection: 'blog_writers' });
    expect(installation).toMatchObject({
      siteId: B, planId: p.id, idempotencyKey: 'key-1', slug: 'blog', templateVersion: '1.0.0', digest: p.digest,
      namespaceMap: { writers: 'blog_writers', articles: 'blog_articles' }, seedPack: null, status: 'completed',
      resources: { collections: ['blog_articles', 'blog_writers'], fields: 3, relations: 1, seedRecords: 0 },
    });
    expect((installation.baseline as { config: { collections: Array<{ name: string }> } }).config.collections.map((c) => c.name)).toEqual(['blog_articles', 'blog_writers']);
    expect((await planner().get(p.id)).status).toBe('completed');
    // A completed plan is consumed: another key cannot apply it again.
    await expect(installer().install({ planId: p.id, idempotencyKey: 'key-2' })).rejects.toMatchObject({ code: 'STALE_PLAN' });
  });

  it.each<InstallStep>(['collections', 'fields', 'relations', 'seed', 'provenance'])(
    'BT04-AC02 — a fault after %s leaves the target exactly as before, with no installation or event',
    async (step) => {
      const p = await plan({ seedPack: 'demo' });
      const before = await snapshot();
      const failing = installer({ seed: seedStub, onStep: (s) => { if (s === step) throw new Error(`fault after ${s}`); } });
      await expect(failing.install({ planId: p.id, idempotencyKey: `fault-${step}` })).rejects.toThrow(`fault after ${step}`);
      expect(await snapshot()).toEqual(before);
      expect((await planner().get(p.id)).status).toBe('planned');
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, B), eq(auditLog.event, 'backend_template_install_failed')));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.metadata)).not.toContain('Ada'); // no seed payload in logs
      expect(await db.select().from(auditLog).where(and(eq(auditLog.siteId, B), eq(auditLog.event, 'backend_template_installed')))).toEqual([]);
    },
  );

  it('BT04-AC03 — 10 identical concurrent requests: one installation, one set of resources, one id', async () => {
    const p = await plan();
    const results = await Promise.all(Array.from({ length: 10 }, () => installer().install({ planId: p.id, idempotencyKey: 'same-key' })));
    expect(new Set(results.map((r) => r.installation.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await names()).toEqual(['articles', 'notes', 'writers']);
    expect((await snapshot()).installations).toBe(1);
    expect(await db.select().from(fields).where(eq(fields.siteId, B))).toHaveLength(4);
  });

  it('BT04-AC04 — reusing a key for another plan is IDEMPOTENCY_CONFLICT and never replays the other result', async () => {
    const p1 = await plan();
    await installer().install({ planId: p1.id, idempotencyKey: 'shared' });
    const p2 = await plan({ namespace: { prefix: 'x_' } });
    const before = await snapshot();
    await expect(installer().install({ planId: p2.id, idempotencyKey: 'shared' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await snapshot()).toEqual(before);
    // Plans of another site are not found from B.
    await expect(new BackendTemplateInstaller({ db, siteId: A, authorize: async () => true }).install({ planId: p2.id, idempotencyKey: 'k' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('BT04-AC05 — a schema change or revoked authorization between preview and apply is refused under the lock, before writes', async () => {
    const p = await plan();
    await new SchemaService({ db, siteId: B }).createField('notes', { name: 'extra', type: 'string', interface: 'input' } as never);
    const before = await snapshot();
    await expect(installer().install({ planId: p.id, idempotencyKey: 'race-1' })).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect(await snapshot()).toEqual(before);
    expect((await planner().get(p.id)).status).toBe('invalidated');

    const p2 = await plan();
    await expect(installer({ authorize: async () => false }).install({ planId: p2.id, idempotencyKey: 'race-2' }))
      .rejects.toBeInstanceOf(InstallError);
    expect(await snapshot()).toEqual(before);
    // Expired plans too (injected clock).
    const later = new Date(Date.now() + 16 * 60 * 1000);
    await expect(installer({ now: () => later }).install({ planId: p2.id, idempotencyKey: 'race-3' })).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect((await planner().get(p2.id)).status).toBe('expired');
    expect(await snapshot()).toEqual(before);
  });

  it('BT04-AC06 — crash after commit: the retry returns the committed installation without new rows or events; a crash before commit retries cleanly', async () => {
    const p = await plan();
    const first = await installer().install({ planId: p.id, idempotencyKey: 'crash-after' });
    // ...the response is lost; the client retries.
    const committed = await snapshot();
    const retry = await installer().install({ planId: p.id, idempotencyKey: 'crash-after' });
    expect(retry).toMatchObject({ replayed: true, installation: { id: first.installation.id } });
    expect(await snapshot()).toEqual(committed);

    await cleanup();
    await db.insert(sites).values([{ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: A, name: 'A' }, { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: B, name: 'B' }]);
    await db.insert(users).values({ id: ADMIN, email: 'admin-904@example.dev' });
    const catalog = new BackendTemplateCatalogService({ db, siteId: A });
    await catalog.publish((await catalog.createDraft(blog)).id);
    const p2 = await plan();
    await expect(installer({ onStep: (s) => { if (s === 'provenance') throw new Error('worker died'); } }).install({ planId: p2.id, idempotencyKey: 'crash-before' }))
      .rejects.toThrow('worker died');
    const again = await installer().install({ planId: p2.id, idempotencyKey: 'crash-before' });
    expect(again.replayed).toBe(false);
    expect((await snapshot()).installations).toBe(1);
    expect(await names()).toEqual(['articles', 'writers']);
  });

  it('BT04-AC07 — commit effects: the schema cache refreshes after commit; a rollback emits no success event or dispatch', async () => {
    const cache = new MemoryCacheProvider();
    const queue = { enqueue: vi.fn(async () => undefined) };
    const live = new SchemaService({ db, siteId: B, cache });
    expect(await live.getCompiled('writers')).toBeNull(); // negative-cached now

    const failing = await plan();
    await expect(installer({ cache, queue: queue as never, onStep: (s) => { if (s === 'relations') throw new Error('boom'); } })
      .install({ planId: failing.id, idempotencyKey: 'rb' })).rejects.toThrow('boom');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(await live.getCompiled('writers')).toBeNull();

    const p = await plan();
    await installer({ cache, queue: queue as never }).install({ planId: p.id, idempotencyKey: 'ok' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(await live.getCompiled('writers')).toMatchObject({ name: 'writers' });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.siteId, B), eq(auditLog.event, 'backend_template_installed')))).toHaveLength(1);
    // Replays do not dispatch again.
    await installer({ cache, queue: queue as never }).install({ planId: p.id, idempotencyKey: 'ok' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a seeded plan without a seed writer is refused before any write', async () => {
    const p = await plan({ seedPack: 'demo' });
    const before = await snapshot();
    await expect(installer().install({ planId: p.id, idempotencyKey: 'no-seed' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(backendTemplatePlans).where(and(eq(backendTemplatePlans.id, p.id), eq(backendTemplatePlans.status, 'planned')))).toHaveLength(1);
  });

  it('REST: 201 then 200 replay; a reused key is 409; a demoted admin is refused before any write', async () => {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', B);
      c.set('auth', { type: 'user', userId: ADMIN, roles: [], raw: {} } as unknown as AuthPrincipal);
      c.set('runtime', {} as never);
      await next();
    });
    hono.route('/backend-templates', backendTemplatesRouter);
    const post = async (body: unknown) => {
      const res = await hono.request('/backend-templates/installations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});
      return { status: res.status, body: (await res.json()) as { data?: { id: string }; meta?: { replayed: boolean }; errors?: Array<{ code: string }> } };
    };
    const p = await plan();
    const created = await post({ planId: p.id, idempotencyKey: 'rest-1' });
    expect(created).toMatchObject({ status: 201, body: { meta: { replayed: false } } });
    expect(await post({ planId: p.id, idempotencyKey: 'rest-1' })).toMatchObject({ status: 200, body: { meta: { replayed: true }, data: { id: created.body.data!.id } } });
    const other = await plan({ namespace: { prefix: 'y_' } });
    expect(await post({ planId: other.id, idempotencyKey: 'rest-1' })).toMatchObject({ status: 409, body: { errors: [{ code: 'IDEMPOTENCY_CONFLICT' }] } });
    expect((await post({ planId: other.id })).status).toBe(400);

    const before = await snapshot();
    await db.update(roles).set({ adminAccess: false }).where(eq(roles.id, 'role_904_b'));
    expect((await post({ planId: other.id, idempotencyKey: 'rest-2' })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});
