import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  backendTemplateRevisions,
  collections,
  fields,
  items,
  permissions,
  policies,
  relations,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { backendTemplatesRouter } from '../../../routes/backend-templates';
import { itemsRouter } from '../../../routes/items';
import { AISecureHarness } from '../../ai-harness';
import { ItemService } from '../../item-service';
import { SchemaService } from '../../schema-service';
import { BackendTemplateCatalogService } from '../catalog-service';
import { BackendTemplatePlanner, PlanError } from '../planner';
import { BackendTemplateInstaller } from '../installer';
import { createSeedWriter } from '../seed-writer';

/**
 * #905 (BT05) — seed packs, combined with BT04's installer, against REAL
 * PostgreSQL through the real routes. Fixture: source catalog on A, targets
 * A and B, admin of both, an editor of B with item create on `writers` only.
 */

const A = 'site_905_a';
const B = 'site_905_b';
const ADMIN = 'usr_905_admin';
const EDITOR = 'usr_905_editor';

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
      { collection: 'articles', field: 'writer', type: 'string', interface: 'input', required: true },
      { collection: 'articles', field: 'related', type: 'string', interface: 'input' },
    ],
    relations: [
      { manyCollection: 'articles', manyField: 'writer', oneCollection: 'writers', type: 'm2o' },
      { manyCollection: 'articles', manyField: 'related', oneCollection: 'articles', type: 'm2o' },
    ],
  },
  seedPacks: {
    demo: {
      records: [
        // Listed out of dependency order on purpose: articles before their writer.
        { key: 'a1', collection: 'articles', values: { title: 'First' }, references: { writer: 'w1', related: 'a2' } },
        { key: 'a2', collection: 'articles', values: { title: 'Second' }, references: { writer: 'w1', related: 'a1' } },
        { key: 'w1', collection: 'writers', values: { name: 'Ada' } },
      ],
    },
    other: { records: [{ key: 'w9', collection: 'writers', values: { name: 'Only in other' } }] },
  },
  ...over,
});

describe.skipIf(!hasDbIntegrationUrl)('#905 seed packs — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('backend-template-seed');
  });
  const cleanup = async () => {
    await db.delete(backendTemplateRevisions).where(sql`${backendTemplateRevisions.siteId} IN (${A}, ${B})`);
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN}, ${EDITOR})`);
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([{ organizationId: org, id: A, name: '905 A' }, { organizationId: org, id: B, name: '905 B' }]);
    await db.insert(users).values([{ id: ADMIN, email: 'admin-905@example.dev' }, { id: EDITOR, email: 'editor-905@example.dev' }]);
    await db.insert(roles).values([
      { id: 'role_905_a', siteId: A, name: 'Admin A', adminAccess: true, appAccess: true },
      { id: 'role_905_b', siteId: B, name: 'Admin B', adminAccess: true, appAccess: true },
      { id: 'role_905_editor', siteId: B, name: 'Editor B', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: A, roleId: 'role_905_a' },
      { userId: ADMIN, siteId: B, roleId: 'role_905_b' },
      { userId: EDITOR, siteId: B, roleId: 'role_905_editor' },
    ]);
    // The editor may create writers, but not articles.
    await db.insert(policies).values({ id: 'pol_905_editor', siteId: B, name: 'writers only', key: 'writers-only', adminAccess: false, appAccess: true });
    await db.insert(rolePolicies).values({ roleId: 'role_905_editor', policyId: 'pol_905_editor' } as never);
    await db.insert(permissions).values([
      { siteId: B, policyId: 'pol_905_editor', collection: 'writers', action: 'create', fields: ['*'] },
      { siteId: B, policyId: 'pol_905_editor', collection: 'writers', action: 'read', fields: ['*'] },
    ] as never);
    const catalog = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN });
    await catalog.publish((await catalog.createDraft(blog())).id);
  });

  function app(siteId: string, userId = ADMIN) {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', { type: 'user', userId, email: `${userId}@example.dev`, roles: [], raw: {} } as unknown as AuthPrincipal);
      c.set('runtime', {} as never);
      await next();
    });
    hono.route('/backend-templates', backendTemplatesRouter);
    hono.route('/items', itemsRouter);
    return async (method: string, path: string, body?: unknown) => {
      const res = await hono.request(path, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { LUMIBASE_VERSION: '2.2.0' });
      return { status: res.status, body: (await res.json()) as { data?: any; meta?: any; errors?: Array<Record<string, any>> } };
    };
  }

  /** Plan + install through REST as the admin of `siteId`. */
  async function installVia(siteId: string, planBody: Record<string, unknown>, key = 'k1') {
    const call = app(siteId);
    const planned = await call('POST', '/backend-templates/plans', {
      template: { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' }, targetSiteId: siteId, ...planBody,
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    const installed = await call('POST', '/backend-templates/installations', { planId: planned.body.data.id, idempotencyKey: key });
    return { planned, installed, call };
  }

  const rowsOf = async (siteId: string, collection: string) => {
    const [col] = await db.select().from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, collection)));
    if (!col) return [];
    return db.select().from(items).where(and(eq(items.siteId, siteId), eq(items.collectionId, col.id)));
  };

  async function snapshot(siteId = B) {
    const rows = async (table: typeof collections) =>
      (await db.select().from(table).where(eq(table.siteId, siteId))).map((r) => JSON.stringify(r)).sort();
    return {
      collections: await rows(collections),
      fields: await rows(fields as unknown as typeof collections),
      relations: await rows(relations as unknown as typeof collections),
      items: await rows(items as unknown as typeof collections),
    };
  }

  it('BT05-AC01 — no-seed default: argument omitted or seedMode none → every collection, zero content', async () => {
    const omitted = await installVia(B, {});
    expect(omitted.installed.status).toBe(201);
    expect(omitted.installed.body.data).toMatchObject({ seedPack: null, resources: { seedRecords: 0 } });
    expect((await rowsOf(B, 'writers')).length + (await rowsOf(B, 'articles')).length).toBe(0);

    const none = await installVia(A, { seedMode: 'none' }, 'k-none');
    expect(none.installed.status).toBe(201);
    expect((await rowsOf(A, 'writers')).length + (await rowsOf(A, 'articles')).length).toBe(0);
    expect((await db.select({ name: collections.name }).from(collections).where(eq(collections.siteId, A))).map((c) => c.name).sort())
      .toEqual(['articles', 'writers']);
  });

  it('BT05-AC02 — pack selection: only the chosen pack; unknown or contradictory input fails before schema writes', async () => {
    const before = await snapshot();
    const call = app(B);
    const ref = { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' };
    expect(await call('POST', '/backend-templates/plans', { template: ref, targetSiteId: B, seedMode: 'none', seedPack: 'demo' }))
      .toMatchObject({ status: 400, body: { errors: [{ code: 'VALIDATION', path: ['seedPack'] }] } });
    expect(await call('POST', '/backend-templates/plans', { template: ref, targetSiteId: B, seedMode: 'pack' }))
      .toMatchObject({ status: 400 });
    expect((await call('POST', '/backend-templates/plans', { template: ref, targetSiteId: B, seedMode: 'pack', seedPack: 'nope' })).body.errors![0])
      .toMatchObject({ code: 'INVALID_TEMPLATE', path: '$.seedPack' });
    expect(await snapshot()).toEqual(before);

    const { installed } = await installVia(B, { seedMode: 'pack', seedPack: 'demo' });
    expect(installed.status).toBe(201);
    expect(installed.body.data.resources).toMatchObject({ seedRecords: 3 });
    const writers = await rowsOf(B, 'writers');
    expect(writers.map((w) => (w.data as { name: string }).name)).toEqual(['Ada']); // not "Only in other"
    expect(await rowsOf(B, 'articles')).toHaveLength(2);
  });

  it('BT05-AC03 — fresh identities: the same pack in A and B gets different ids, references stay within each site, no logical keys stored', async () => {
    const inB = (await installVia(B, { seedPack: 'demo' })).installed.body.data;
    const inA = (await installVia(A, { seedPack: 'demo' }, 'kA')).installed.body.data;
    const keysB = inB.resources.seedKeys as Record<string, string>;
    const keysA = inA.resources.seedKeys as Record<string, string>;
    expect(Object.keys(keysB).sort()).toEqual(['a1', 'a2', 'w1']);
    for (const key of Object.keys(keysB)) expect(keysA[key]).not.toBe(keysB[key]);

    for (const [siteId, keys] of [[B, keysB], [A, keysA]] as const) {
      const articles = await rowsOf(siteId, 'articles');
      const writerIds = new Set((await rowsOf(siteId, 'writers')).map((w) => w.id));
      const articleIds = new Set(articles.map((a) => a.id));
      for (const article of articles) {
        const data = article.data as { writer: string; related: string };
        expect(writerIds.has(data.writer)).toBe(true);
        expect(articleIds.has(data.related)).toBe(true); // optional cycle resolved in pass 2
      }
      const a1 = articles.find((a) => a.id === keys['a1'])!;
      expect((a1.data as { related: string }).related).toBe(keys['a2']);
      const stored = JSON.stringify(articles.map((a) => a.data));
      expect(stored).not.toMatch(/"(a1|a2|w1)"/);
    }
    const otherSiteIds = new Set(Object.values(keysA));
    for (const article of await rowsOf(B, 'articles')) {
      expect(otherSiteIds.has((article.data as { writer: string }).writer)).toBe(false);
    }
  });

  it('BT05-AC04 — bad graphs fail with a record/field path and no partial install', async () => {
    const before = await snapshot();
    const bad = (mutate: (doc: any) => void) => {
      const doc = JSON.parse(JSON.stringify(blog({ slug: 'bad' })));
      mutate(doc);
      return doc;
    };
    const cases: Array<[string, any, RegExp]> = [
      ['duplicate key', bad((d) => d.seedPacks.demo.records.push({ ...d.seedPacks.demo.records[2] })), /records\[3\]\.key/],
      ['missing target', bad((d) => { d.seedPacks.demo.records[0].references.writer = 'ghost'; }), /records\[0\]\.references\["writer"\]/],
      ['incompatible collection', bad((d) => { d.seedPacks.demo.records[0].references.writer = 'a2'; }), /records\[0\]\.references\["writer"\]/],
      ['required cycle', bad((d) => {
        d.config.fields.find((f: any) => f.field === 'related').required = true;
      }), /references/],
    ];
    for (const [label, document, path] of cases) {
      const planner = new BackendTemplatePlanner({ db, siteId: B, official: [document], cmsVersion: '2.2.0' });
      const error = await planner.plan({ template: { source: 'official', slug: 'bad', version: '1.0.0' } as never, targetSiteId: B, seedPack: 'demo' })
        .then(() => null, (e: unknown) => e);
      expect(error, label).toBeInstanceOf(PlanError);
      expect(((error as PlanError).details.errors ?? []).some((e) => path.test(e.path)), `${label}: ${JSON.stringify((error as PlanError).details.errors)}`).toBe(true);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('BT05-AC05 — a seeded collection the caller may not create fails the whole install: no schema, no content', async () => {
    const planner = new BackendTemplatePlanner({ db, siteId: B, dbForSite: () => db, canReadSourceCatalog: async () => true, cmsVersion: '2.2.0' });
    const { plan } = await planner.plan({ template: { source: 'site', sourceSiteId: A, slug: 'blog', version: '1.0.0' } as never, targetSiteId: B, seedPack: 'demo' });
    const before = await snapshot();
    const editorItems = (tx: Database) => new ItemService({
      db: tx, siteId: B, userId: EDITOR, suppressExtensionHooks: true,
      permissionCtx: { userId: EDITOR, siteId: B, roleId: 'role_905_editor', ip: null, headers: {} },
    });
    const installer = new BackendTemplateInstaller({ db, siteId: B, userId: EDITOR, authorize: async () => true, seed: createSeedWriter(editorItems) });
    const error = await installer.install({ planId: plan.id, idempotencyKey: 'editor' }).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(String((error as { code?: string }).code ?? (error as Error).message)).toMatch(/FORBIDDEN|PERMISSION|denied|forbidden/i);
    expect(await snapshot()).toEqual(before);
    expect((await planner.get(plan.id)).status).toBe('planned');
  });

  it('BT05-AC06 — later population: after a no-seed install, REST and MCP create an author and a post that reads back only in B', async () => {
    await installVia(B, {});
    const callB = app(B);
    const author = await callB('POST', '/items/writers', { data: { name: 'Grace' } });
    expect(author.status, JSON.stringify(author.body)).toBe(201);
    const post = await callB('POST', '/items/articles', { data: { title: 'Via REST', writer: author.body.data.id } });
    expect(post.status, JSON.stringify(post.body)).toBe(201);

    // MCP / agent path: the governed harness with the caller's ItemService.
    const harness = new AISecureHarness({
      db, siteId: B,
      schemaService: new SchemaService({ db, siteId: B }),
      itemService: new ItemService({ db, siteId: B, userId: ADMIN, permissionCtx: { userId: ADMIN, siteId: B, roleId: 'role_905_b', ip: null, headers: {} } }),
    });
    const viaMcp = await harness.execute('createItem', { collection: 'articles', data: { title: 'Via MCP', writer: author.body.data.id } }, ['admin'], 'populate');
    expect(viaMcp.status, JSON.stringify(viaMcp)).toBe('executed');

    const listed = await callB('GET', '/items/articles');
    expect(listed.body.data.map((a: { data: { title: string } }) => a.data.title).sort()).toEqual(['Via MCP', 'Via REST']);
    expect(listed.body.data.every((a: { siteId: string; data: { writer: string } }) => a.siteId === B && a.data.writer === author.body.data.id)).toBe(true);
    // Not reachable from site A.
    expect((await app(A)('GET', `/items/articles/${post.body.data.id}`)).status).toBe(404);
  });

  it('BT05-AC07 — retrying a completed seeded install changes nothing, and user edits are not reseeded', async () => {
    const { planned, installed, call } = await installVia(B, { seedPack: 'demo' });
    const keys = installed.body.data.resources.seedKeys as Record<string, string>;
    const w1 = keys['w1']!;
    await db.update(items).set({ data: { name: 'Ada (edited)' } }).where(eq(items.id, w1));
    const retry = await call('POST', '/backend-templates/installations', { planId: planned.body.data.id, idempotencyKey: 'k1' });
    expect(retry).toMatchObject({ status: 200, body: { meta: { replayed: true }, data: { id: installed.body.data.id, resources: { seedKeys: keys } } } });
    expect(await rowsOf(B, 'writers')).toHaveLength(1);
    expect(await rowsOf(B, 'articles')).toHaveLength(2);
    const [row] = await db.select().from(items).where(inArray(items.id, [w1]));
    expect((row!.data as { name: string }).name).toBe('Ada (edited)');
  });
});
