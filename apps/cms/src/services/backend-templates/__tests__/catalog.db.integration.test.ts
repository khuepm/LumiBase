import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import {
  schema,
  backendTemplateRevisions,
  backendTemplates,
  collections,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { createSiteScopedSql } from '@lumibase/runtime';
import { parseBackendTemplate } from '@lumibase/contracts/backend-templates';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { createRlsTestDatabase, type RlsTestDatabase } from '../../../test-utils/rls-roles';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { backendTemplatesRouter } from '../../../routes/backend-templates';
import { SchemaService } from '../../schema-service';
import { ConfigExportService } from '../../config-export-service';
import { BackendTemplateCatalogService, CatalogError, type CaptureItemReader } from '../catalog-service';

/**
 * #902 (BT02) — private template catalog against REAL PostgreSQL, through the
 * real router where the transport matters. Shared fixture per the spec: source
 * site A, target site B, admin of A+B, editor on B only.
 */

const A = 'site_902_a';
const B = 'site_902_b';
const ADMIN_AB = 'usr_902_admin';
const ADMIN_B = 'usr_902_admin_b';
const EDITOR_B = 'usr_902_editor';

const doc = (over: Record<string, unknown> = {}) => ({
  formatVersion: 'lumibase.template@v1',
  slug: 'blog',
  displayName: 'Blog',
  templateVersion: '1.0.0',
  compatibility: { cmsVersionRange: '>=2.2.0', storageModes: ['jsonb'] },
  config: {
    version: 'lumibase.config@v1',
    collections: [{ name: 'articles', label: 'Articles' }],
    fields: [{ collection: 'articles', field: 'title', type: 'string', interface: 'input', required: true }],
    relations: [],
  },
  ...over,
});

describe.skipIf(!hasDbIntegrationUrl)('#902 backend template catalog — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('backend-template-catalog');
  });
  const cleanup = async () => {
    await db.delete(backendTemplateRevisions).where(sql`${backendTemplateRevisions.siteId} IN (${A}, ${B})`);
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN_AB}, ${ADMIN_B}, ${EDITOR_B})`);
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: A, name: '902 A' },
      { organizationId: org, id: B, name: '902 B' },
    ]);
    await db.insert(users).values([
      { id: ADMIN_AB, email: 'admin-902@example.dev' },
      { id: ADMIN_B, email: 'admin-b-902@example.dev' },
      { id: EDITOR_B, email: 'editor-902@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: 'role_902_admin_a', siteId: A, name: 'Admin A', adminAccess: true, appAccess: true },
      { id: 'role_902_admin_b', siteId: B, name: 'Admin B', adminAccess: true, appAccess: true },
      { id: 'role_902_editor_b', siteId: B, name: 'Editor B', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN_AB, siteId: A, roleId: 'role_902_admin_a' },
      { userId: ADMIN_AB, siteId: B, roleId: 'role_902_admin_b' },
      { userId: ADMIN_B, siteId: B, roleId: 'role_902_admin_b' },
      { userId: EDITOR_B, siteId: B, roleId: 'role_902_editor_b' },
    ]);
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
      const res = await hono.request(`/backend-templates${path.replace(/^\/(?=\?|$)/, '')}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, {});
      const text = await res.text();
      if (!text.startsWith("{")) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      return { status: res.status, body: JSON.parse(text) as { data?: any; meta?: any; errors?: Array<{ code: string; missing?: string[] }> } };
    };
  }

  const counts = async (siteId: string) => ({
    collections: (await db.select().from(collections).where(eq(collections.siteId, siteId))).length,
    items: (await db.select().from(items).where(eq(items.siteId, siteId))).length,
  });

  it('BT02-AC01 — draft authoring: create, edit with matching revision, publish 1.0.0, get and export; no schema or content changes', async () => {
    const before = { a: await counts(A), b: await counts(B) };
    const call = api(A, ADMIN_AB);
    const created = await call('POST', '/', { document: doc() });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ slug: 'blog', draftRevision: 1, validation: { ok: true }, versions: [] });
    const id = created.body.data.id as string;

    const edited = await call('PATCH', `/${id}`, {
      document: doc({ config: { ...doc().config, collections: [{ name: 'articles', label: 'Stories' }] } }),
      draftRevision: 1,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.draftRevision).toBe(2);

    const published = await call('POST', `/${id}/publish`, { draftRevision: 2 });
    expect(published.status).toBe(201);
    expect(published.body.data).toMatchObject({ templateVersion: '1.0.0', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });

    const got = await call('GET', '/blog');
    expect(got.body.data.versions).toEqual(['1.0.0']);
    const exported = await call('GET', `/${id}/revisions/1.0.0`);
    expect(exported.body.data.document.config.collections).toEqual([{ label: 'Stories', name: 'articles' }]);
    // The export reparses to the same template.
    expect(parseBackendTemplate(JSON.stringify(exported.body.data.document)).ok).toBe(true);

    expect({ a: await counts(A), b: await counts(B) }).toEqual(before);
  });

  it('BT02-AC02 — concurrent edits from the same revision: exactly one wins, no lost update', async () => {
    const catalog = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN_AB });
    const created = await catalog.createDraft(doc());
    const results = await Promise.allSettled([
      catalog.updateDraft(created.id, doc({ displayName: 'Blog one' }), 1),
      catalog.updateDraft(created.id, doc({ displayName: 'Blog two' }), 1),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(CatalogError);
    expect((lost[0]!.reason as CatalogError).code).toBe('DRAFT_CONFLICT');
    const winner = (won[0] as PromiseFulfilledResult<{ displayName: string }>).value.displayName;
    const [row] = await db.select().from(backendTemplates).where(eq(backendTemplates.id, created.id));
    expect(row).toMatchObject({ draftRevision: 2, displayName: winner });
    expect((row!.draft as { displayName: string }).displayName).toBe(winner);
    // A stale editor is told so through the API too.
    const stale = await api(A, ADMIN_AB)('PATCH', `/${created.id}`, { document: doc(), draftRevision: 1 });
    expect(stale).toMatchObject({ status: 409, body: { errors: [{ code: 'DRAFT_CONFLICT' }] } });
  });

  it('BT02-AC03 — immutable publication: different content under the same version is refused; identical retry returns the existing revision', async () => {
    const call = api(A, ADMIN_AB);
    const id = (await call('POST', '/', { document: doc() })).body.data.id as string;
    const first = await call('POST', `/${id}/publish`);
    expect(first.status).toBe(201);

    const retry = await call('POST', `/${id}/publish`);
    expect(retry).toMatchObject({ status: 200, body: { meta: { created: false }, data: { id: first.body.data.id } } });

    await call('PATCH', `/${id}`, { document: doc({ description: 'changed' }), draftRevision: 1 });
    const changed = await call('POST', `/${id}/publish`);
    expect(changed).toMatchObject({ status: 409, body: { errors: [{ code: 'IMMUTABLE_REVISION' }] } });

    // Concurrent identical publications of a new version: one row.
    await call('PATCH', `/${id}`, { document: doc({ templateVersion: '1.1.0' }), draftRevision: 2 });
    const catalog = new BackendTemplateCatalogService({ db, siteId: A });
    const both = await Promise.all([catalog.publish(id), catalog.publish(id)]);
    expect(both.map((r) => r.created).sort()).toEqual([false, true]);
    expect(both[0]!.revision.id).toBe(both[1]!.revision.id);
    const rows = await db.select().from(backendTemplateRevisions).where(eq(backendTemplateRevisions.templateId, id));
    expect(rows.map((r) => r.templateVersion).sort()).toEqual(['1.0.0', '1.1.0']);
    // The DB itself refuses a second row for the same version.
    await expect(db.insert(backendTemplateRevisions).values({
      siteId: A, templateId: id, templateVersion: '1.0.0', digest: 'sha256:x', document: {},
    })).rejects.toThrow();
  });

  it('BT02-AC04 — tenant boundary: a B principal cannot list, get or capture A\'s templates by id, slug or pagination', async () => {
    const id = (await api(A, ADMIN_AB)('POST', '/', { document: doc() })).body.data.id as string;
    await api(A, ADMIN_AB)('POST', `/${id}/publish`);

    const asB = api(B, ADMIN_B);
    expect(await asB('GET', '/')).toMatchObject({ status: 200, body: { data: [], meta: { total: 0 } } });
    expect((await asB('GET', '/?offset=0&limit=200')).body.data).toEqual([]);
    expect((await asB('GET', `/${id}`)).status).toBe(404);
    expect((await asB('GET', '/blog')).status).toBe(404);
    expect((await asB('GET', `/${id}/revisions/1.0.0`)).status).toBe(404);
    expect((await asB('POST', `/${id}/publish`)).status).toBe(404);
    expect((await asB('PATCH', `/${id}`, { document: doc(), draftRevision: 1 })).status).toBe(404);
    // Capture reads B's own schema only: A's collections do not exist there.
    expect((await asB('POST', '/capture', { collections: ['articles'], slug: 'stolen', displayName: 'x' })).status).toBe(404);
    // Not a site admin of B: no catalog at all.
    expect((await api(B, EDITOR_B)('GET', '/')).status).toBe(403);
    // Admin of B only, pointing at A: no access to A.
    expect((await api(A, ADMIN_B)('GET', `/${id}`)).status).toBe(403);
  });

  describe('BT02-AC04 — real RLS (NOSUPERUSER NOBYPASSRLS app role)', () => {
    let fx: RlsTestDatabase;
    beforeAll(async () => {
      fx = await createRlsTestDatabase(dbIntegrationUrl!);
    }, 120_000);
    afterAll(async () => {
      if (fx) await fx.drop();
    });

    it('the app role scoped to B sees none of A\'s templates or revisions; unscoped sees nothing', async () => {
      const ownerSql = postgres(fx.ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
      const owner = drizzle(ownerSql, { schema }) as unknown as Database;
      const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
      await owner.insert(sites).values([{ organizationId: org, id: A, name: 'A' }, { organizationId: org, id: B, name: 'B' }]);
      const a = await new BackendTemplateCatalogService({ db: owner, siteId: A }).createDraft(doc());
      await new BackendTemplateCatalogService({ db: owner, siteId: A }).publish(a.id);
      await new BackendTemplateCatalogService({ db: owner, siteId: B }).createDraft(doc({ slug: 'b-only', displayName: 'B only' }));

      const appSql = postgres(fx.appUrl, { max: 1, prepare: false, onnotice: () => {} });
      try {
        const scopedB = drizzle(createSiteScopedSql(appSql, B), { schema }) as unknown as Database;
        // Even a query that forgets the site filter sees only B's rows.
        const raw = await scopedB.select({ slug: backendTemplates.slug }).from(backendTemplates);
        expect(raw).toEqual([{ slug: 'b-only' }]);
        expect(await scopedB.select().from(backendTemplateRevisions)).toEqual([]);
        // And the service, asked for A's id from B, finds nothing.
        await expect(new BackendTemplateCatalogService({ db: scopedB, siteId: B }).get(a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // A cross-site write is refused by WITH CHECK.
        await expect(scopedB.insert(backendTemplates).values({ siteId: A, slug: 'x', displayName: 'x', draft: {} })).rejects.toThrow();
        const unscoped = drizzle(appSql, { schema }) as unknown as Database;
        expect(await unscoped.select().from(backendTemplates)).toEqual([]);
      } finally {
        await appSql.end();
        await ownerSql.end();
      }
    });
  });

  async function seedSchemaA() {
    const schemaA = new SchemaService({ db, siteId: A });
    await schemaA.createCollection({ name: 'writers', label: 'Writers' } as never);
    await schemaA.createField('writers', { name: 'name', type: 'string', interface: 'input', required: true } as never);
    await schemaA.createField('writers', { name: 'password', type: 'hash', interface: 'input' } as never);
    await schemaA.createCollection({ name: 'stories', label: 'Stories', note: 'Long reads' } as never);
    await schemaA.createField('stories', { name: 'title', type: 'string', interface: 'input', required: true, options: { placeholder: 'Title' } } as never);
    await schemaA.createField('stories', { name: 'words', type: 'integer', interface: 'input' } as never);
    await schemaA.createField('stories', { name: 'writer', type: 'string', interface: 'select-dropdown-m2o' } as never);
    await schemaA.createRelation({ manyCollection: 'stories', manyField: 'writer', oneCollection: 'writers', type: 'm2o' } as never);
  }

  it('BT02-AC05 — capture fidelity: export + reparse keeps fields, options and relations; a missing dependency is an explicit error', async () => {
    await seedSchemaA();
    const call = api(A, ADMIN_AB);
    const missing = await call('POST', '/capture', { collections: ['stories'], slug: 'stories-only', displayName: 'Stories' });
    expect(missing).toMatchObject({ status: 422, body: { errors: [{ code: 'MISSING_DEPENDENCY', missing: ['writers'] }] } });
    expect(await db.select().from(backendTemplates).where(eq(backendTemplates.siteId, A))).toEqual([]);

    const captured = await call('POST', '/capture', { collections: ['stories', 'writers'], slug: 'longreads', displayName: 'Long reads' });
    expect(captured.status).toBe(201);
    expect(captured.body.data.validation).toEqual({ ok: true });
    const id = captured.body.data.id as string;
    expect((await call('POST', `/${id}/publish`)).status).toBe(201);
    const exported = (await call('GET', `/${id}/revisions/1.0.0`)).body.data.document;
    const reparsed = parseBackendTemplate(JSON.stringify(exported));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error(JSON.stringify(reparsed.errors));

    const live = await new ConfigExportService({ db, siteId: A }).export({ scope: 'schema' });
    const pick = <T extends { collection?: string; manyCollection?: string; name?: string }>(list: T[]) =>
      list.filter((e) => ['stories', 'writers'].includes((e.collection ?? e.manyCollection ?? e.name)!));
    const sortBy = <T>(list: T[], key: (e: T) => string) => [...list].sort((x, y) => key(x).localeCompare(key(y)));
    expect(sortBy(reparsed.template.config.fields, (f) => `${f.collection}.${f.field}`))
      .toEqual(sortBy(pick(live.fields), (f) => `${f.collection}.${f.field}`));
    expect(reparsed.template.config.relations).toEqual(pick(live.relations));
    expect(sortBy(reparsed.template.config.collections, (c) => c.name)).toEqual(sortBy(pick(live.collections), (c) => c.name));
    expect(reparsed.template.seedPacks).toBeUndefined();
  });

  it('BT02-AC06 — seed privacy: default capture reads no item; explicit capture uses the caller\'s reads and drops secrets; a denied read stores nothing', async () => {
    await seedSchemaA();
    const catalog = new BackendTemplateCatalogService({ db, siteId: A, userId: ADMIN_AB });
    const reads: string[] = [];
    const reader: CaptureItemReader = {
      list: async (collection) => {
        reads.push(collection);
        if (collection === 'writers') return [{ id: 'w1', name: 'Ada', password: '$argon2id$secret' }];
        return [{ id: 's1', title: 'First', words: 1200, writer: 'w1' }];
      },
    };
    await catalog.capture({ collections: ['stories', 'writers'], slug: 'schema-only', displayName: 'S', cmsVersionRange: '*' }, reader);
    expect(reads).toEqual([]);

    const withSeed = await catalog.capture({
      collections: ['stories', 'writers'], slug: 'with-seed', displayName: 'W', cmsVersionRange: '*',
      seed: { collections: ['writers', 'stories'] },
    }, reader);
    expect(reads.sort()).toEqual(['stories', 'writers']);
    const records = (withSeed.draft as { seedPacks: { captured: { records: Array<Record<string, unknown>> } } }).seedPacks.captured.records;
    expect(records).toContainEqual({ key: 'writers-1', collection: 'writers', values: { name: 'Ada' } });
    expect(records).toContainEqual({ key: 'stories-1', collection: 'stories', values: { title: 'First', words: 1200 }, references: { writer: 'writers-1' } });
    expect(JSON.stringify(records)).not.toContain('argon2');
    expect(JSON.stringify(records)).not.toMatch(/"(w1|s1)"/);

    const denied: CaptureItemReader = {
      list: async (collection) => {
        if (collection === 'writers') throw Object.assign(new Error('forbidden'), { status: 403 });
        return [];
      },
    };
    await expect(catalog.capture({
      collections: ['stories', 'writers'], slug: 'denied', displayName: 'D', cmsVersionRange: '*',
      seed: { collections: ['stories', 'writers'] },
    }, denied)).rejects.toThrow('forbidden');
    const slugs = (await db.select({ slug: backendTemplates.slug }).from(backendTemplates).where(eq(backendTemplates.siteId, A))).map((r) => r.slug);
    expect(slugs.sort()).toEqual(['schema-only', 'with-seed']);

    // Through the API, the editor cannot capture at all.
    expect((await api(B, EDITOR_B)('POST', '/capture', { collections: ['x'], slug: 'x', displayName: 'x' })).status).toBe(403);
  });
});
