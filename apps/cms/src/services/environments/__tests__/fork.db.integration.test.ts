import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiKeys,
  collections,
  environmentLineage,
  environments,
  extensions,
  fields,
  files,
  flows,
  items,
  relations,
  revisions,
  settings,
  sites,
  userSites,
  users,
  webhooks,
  type Database,
} from '@lumibase/database';
import { EnvKeyProvider, MemoryCacheProvider, type QueueProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { environmentsRouter } from '../../../routes/environments';
import { settingsRouter } from '../../../routes/settings';
import { resetReleaseFlagStateForTests } from '../../../modules/release-flags/service';
import { dispatchItemEvent } from '../../flow-dispatch';
import { ItemService } from '../../item-service';
import { provisionSite } from '../../site-provisioning';
import { driveFork, type ForkDeps } from '../fork';
import { ENVIRONMENT_MARKER_KEY, forgetEnvironmentSite, isEnvironmentSite } from '../isolation';

/**
 * Content Environments Phase B on real Postgres (#853 tasks 3–5, gate GB):
 * fork copies schema, access, settings, files and in-scope items with lineage;
 * encrypted fields are re-encrypted under the child's AAD; side systems arrive
 * disabled; the origin does not change; a re-run duplicates nothing; route
 * guards and limits hold.
 */

const ORIGIN = 'site_env_fork_origin';
const ADMIN = 'usr_env_fork_admin';
const KEY = Buffer.alloc(32, 41).toString('base64');
const keyProvider = new EnvKeyProvider(new Map([['v0', KEY]]), 'v0');
const ENV = { LUMIBASE_RELEASE_FLAGS: 'content-environments=on' };

const admin = (): AuthPrincipal => ({ type: 'user', userId: ADMIN, email: 'env-admin@x.dev', roles: [], raw: {} });

describe.skipIf(!hasDbIntegrationUrl)('Content Environments — fork (DB integration)', () => {
  let db: Database;
  const childSites: string[] = [];

  function app(principal: AuthPrincipal = admin(), siteId = ORIGIN) {
    const cache = new MemoryCacheProvider();
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = { ...ENV };
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', principal);
      c.set('runtime', { cache, keys: keyProvider } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/environments', environmentsRouter);
    a.route('/settings', settingsRouter);
    return a;
  }

  const call = (method: string, path: string, body?: unknown, opts: { principal?: AuthPrincipal; site?: string } = {}) =>
    app(opts.principal, opts.site).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const forkDeps = (): ForkDeps => ({ db, keyProvider });
  const originItems = () => new ItemService({ db, siteId: ORIGIN, keyProvider });

  async function forkToEnd(envId: string) {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.select().from(environments).where(eq(environments.id, envId));
      if (row?.status !== 'forking') return row!;
      await driveFork(forkDeps(), envId, 10_000);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('fork did not finish');
  }

  async function createEnv(key: string, scope: unknown = { mode: 'collections', collections: ['authors', 'posts'] }) {
    const res = await call('POST', '/environments', { key, name: key, contentScope: scope });
    expect(res.status).toBe(202);
    const { data } = (await res.json()) as { data: { id: string; siteId: string } };
    childSites.push(data.siteId);
    return { ...data, row: await forkToEnd(data.id) };
  }

  async function cleanup() {
    const children = await db.select({ id: environments.environmentSiteId }).from(environments).where(eq(environments.siteId, ORIGIN));
    const ids = [...new Set([...childSites, ...children.map((c) => c.id), ORIGIN])];
    await db.delete(sites).where(inArray(sites.id, ids)).catch(() => undefined);
    forgetEnvironmentSite();
  }

  beforeAll(async () => {
    db = await connectDbIntegration('environments-fork');
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    resetReleaseFlagStateForTests();
    await cleanup();
    await db.insert(users).values({ id: ADMIN, email: 'env-fork-admin@x.dev', status: 'active' }).onConflictDoNothing();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    const [{ id: organizationId }] = (await db.execute(sql`SELECT ${org} AS id`)) as unknown as Array<{ id: string }>;
    await provisionSite(db, { id: ORIGIN, name: 'Fork origin', organizationId, creatorUserId: ADMIN });
    await db.insert(settings).values({ siteId: ORIGIN, key: 'release.flags', value: { 'content-environments': true } });

    const [authors] = await db.insert(collections).values({ siteId: ORIGIN, name: 'authors', label: 'Authors' }).returning();
    const [posts] = await db.insert(collections).values({ siteId: ORIGIN, name: 'posts', label: 'Posts', primaryKeyType: 'string' }).returning();
    const [tags] = await db.insert(collections).values({ siteId: ORIGIN, name: 'tags', label: 'Tags' }).returning();
    await db.insert(fields).values([
      { siteId: ORIGIN, collectionId: authors!.id, name: 'name', type: 'string', interface: 'input' },
      { siteId: ORIGIN, collectionId: posts!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: ORIGIN, collectionId: posts!.id, name: 'author', type: 'string', interface: 'select-dropdown-m2o' },
      { siteId: ORIGIN, collectionId: posts!.id, name: 'tag', type: 'string', interface: 'select-dropdown-m2o' },
      { siteId: ORIGIN, collectionId: posts!.id, name: 'cover', type: 'string', interface: 'file' },
      { siteId: ORIGIN, collectionId: posts!.id, name: 'note', type: 'string', interface: 'input', encrypted: true },
      { siteId: ORIGIN, collectionId: tags!.id, name: 'label', type: 'string', interface: 'input' },
    ]);
    await db.insert(relations).values([
      { siteId: ORIGIN, manyCollection: 'posts', manyField: 'author', oneCollection: 'authors', type: 'm2o' },
      { siteId: ORIGIN, manyCollection: 'posts', manyField: 'tag', oneCollection: 'tags', type: 'm2o' },
    ]);
    const [file] = await db
      .insert(files)
      .values({ siteId: ORIGIN, filenameDisk: 'shared/cover.png', filenameDownload: 'cover.png', mime: 'image/png', filesize: 10 })
      .returning();

    const svc = originItems();
    const ada = await svc.create('authors', { data: { name: 'Ada' } });
    const tag = await svc.create('tags', { data: { label: 'news' } });
    await svc.create('posts', { data: { id: 'hello', title: 'Hello', author: ada.id, tag: tag.id, cover: file!.id, note: 'secret-note' } });
    await svc.create('posts', { data: { id: 'second', title: 'Second', author: ada.id } });

    await db.insert(webhooks).values({ siteId: ORIGIN, name: 'prod-hook', url: 'https://prod.example/hook', secret: 's3cret', headers: { authorization: 'Bearer x' } });
    await db.insert(flows).values({ siteId: ORIGIN, name: 'notify', status: 'active', triggerType: 'event', triggerOptions: { collections: ['posts'], actions: ['update'] } });
    await db.insert(settings).values([
      { siteId: ORIGIN, key: 'revalidation.targets', value: { targets: [{ url: 'https://prod.example/api/revalidate' }] } },
      { siteId: ORIGIN, key: 'site.theme', value: { color: 'blue' } },
    ]);
  });

  it('forks schema, access, settings, files and in-scope items with lineage', async () => {
    const before = await db.select({ id: items.id, data: items.data, updatedAt: items.updatedAt, version: items.version }).from(items).where(eq(items.siteId, ORIGIN));
    const env = await createEnv('staging');
    expect(env.row.status).toBe('ready');
    expect(env.row.forkedAt).toBeTruthy();
    const child = env.siteId;

    // Same organization; the creator is the child's only member.
    const [o, c] = await Promise.all([ORIGIN, child].map(async (id) => (await db.select().from(sites).where(eq(sites.id, id)))[0]!));
    expect(c!.organizationId).toBe(o!.organizationId);
    expect((await db.select().from(userSites).where(eq(userSites.siteId, child))).map((u) => u.userId)).toEqual([ADMIN]);

    // Schema: every collection, field and relation, with new ids and lineage.
    const childColls = await db.select().from(collections).where(eq(collections.siteId, child));
    expect(childColls.map((x) => x.name).sort()).toEqual(['authors', 'posts', 'tags']);
    expect((await db.select().from(fields).where(eq(fields.siteId, child))).length).toBe(7);
    expect((await db.select().from(relations).where(eq(relations.siteId, child))).length).toBe(2);
    const lineage = await db.select().from(environmentLineage).where(eq(environmentLineage.environmentId, env.id));
    const byKind = (k: string) => lineage.filter((l) => l.kind === k && !l.external);
    expect(byKind('collection')).toHaveLength(3);
    expect(byKind('field')).toHaveLength(7);
    expect(byKind('relation')).toHaveLength(2);
    expect(lineage.every((l) => l.siteId === child)).toBe(true);

    // Items: in-scope collections only (authors + posts), same ids, base hashed.
    const childItems = await db.select().from(items).where(eq(items.siteId, child));
    const tagIds = (await db.select({ id: items.id }).from(items).innerJoin(collections, eq(collections.id, items.collectionId)).where(and(eq(items.siteId, ORIGIN), eq(collections.name, 'tags')))).map((r) => r.id);
    expect(before).toHaveLength(4);
    expect(childItems.map((i) => i.id).sort()).toEqual(before.map((i) => i.id).filter((id) => !tagIds.includes(id)).sort());
    const itemLineage = byKind('item');
    expect(itemLineage).toHaveLength(3);
    for (const l of itemLineage) {
      expect(l.envRowId).toBe(l.originRowId);
      expect(l.baseHash).toMatch(/^[0-9a-f]{64}$/);
      expect(l.baseSnapshot).toBeTruthy();
    }
    // Revisions are not copied: the child starts without history.
    expect((await db.select().from(revisions).where(eq(revisions.siteId, child))).length).toBe(0);

    // Encrypted field: re-encrypted under the child's AAD, readable there, hashed in the base.
    const [originHello] = await db.select().from(items).where(and(eq(items.siteId, ORIGIN), eq(items.id, 'hello')));
    const [childHello] = await db.select().from(items).where(and(eq(items.siteId, child), eq(items.id, 'hello')));
    expect((childHello!.data as Record<string, unknown>).note).not.toBe((originHello!.data as Record<string, unknown>).note);
    expect((childHello!.data as Record<string, unknown>).note).not.toBe('secret-note');
    const childPlain = await new ItemService({ db, siteId: child, keyProvider }).decryptStoredData('posts', 'hello', childHello!.data as Record<string, unknown>, childHello!.dekWrapped);
    expect(childPlain.note).toBe('secret-note');
    const helloBase = itemLineage.find((l) => l.envRowId === 'hello')!.baseSnapshot as Record<string, unknown>;
    expect(helloBase.note).toMatchObject({ $enc: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(helloBase)).not.toContain('secret-note');

    // File: metadata copied with a new id, same storage object; reference mapped.
    const [childFile] = await db.select().from(files).where(eq(files.siteId, child));
    expect(childFile!.filenameDisk).toBe('shared/cover.png');
    expect((childHello!.data as Record<string, unknown>).cover).toBe(childFile!.id);
    expect(byKind('file')).toHaveLength(1);

    // m2o into an out-of-scope collection: kept, marked external.
    const external = lineage.filter((l) => l.external);
    expect(external).toHaveLength(1);
    expect(external[0]!.collection).toBe('tags');

    // Side systems: disabled, no secrets; dangerous settings not copied.
    const [hook] = await db.select().from(webhooks).where(eq(webhooks.siteId, child));
    expect(hook).toMatchObject({ status: 'inactive', secret: null, headers: {} });
    const [flow] = await db.select().from(flows).where(eq(flows.siteId, child));
    expect(flow!.status).toBe('inactive');
    const childSettings = new Map((await db.select().from(settings).where(eq(settings.siteId, child))).map((s) => [s.key, s.value]));
    expect(childSettings.has('revalidation.targets')).toBe(false);
    expect(childSettings.has('release.flags')).toBe(false);
    expect(childSettings.get('site.theme')).toEqual({ color: 'blue' });
    expect(childSettings.get(ENVIRONMENT_MARKER_KEY)).toMatchObject({ originSiteId: ORIGIN });
    expect(childSettings.get('environments.sideEffects.notifications')).toBe(false);
    expect((await db.select().from(extensions).where(eq(extensions.siteId, child))).length).toBe(0);
    expect((await db.select().from(apiKeys).where(eq(apiKeys.siteId, child))).length).toBe(0);

    // The origin did not change by one byte.
    const after = await db.select({ id: items.id, data: items.data, updatedAt: items.updatedAt, version: items.version }).from(items).where(eq(items.siteId, ORIGIN));
    expect(after).toEqual(before);
  });

  it('a re-run from an earlier cursor duplicates nothing and ends ready', async () => {
    const env = await createEnv('rerun');
    const count = async () => ({
      items: (await db.select().from(items).where(eq(items.siteId, env.siteId))).length,
      lineage: (await db.select().from(environmentLineage).where(eq(environmentLineage.environmentId, env.id))).length,
      files: (await db.select().from(files).where(eq(files.siteId, env.siteId))).length,
    });
    const first = await count();
    // Simulate a worker that died after writing a batch but before moving the cursor.
    await db.update(environments).set({ status: 'forking', forkCursor: { phase: 'files', counts: {} } }).where(eq(environments.id, env.id));
    const row = await forkToEnd(env.id);
    expect(row.status).toBe('ready');
    expect(await count()).toEqual(first);
  });

  it('writes in the environment never touch the origin item with the same id (canary)', async () => {
    const env = await createEnv('canary');
    const snapshot = async () => (await db.select({ data: items.data, status: items.status, updatedAt: items.updatedAt, deletedAt: items.deletedAt }).from(items).where(and(eq(items.siteId, ORIGIN), eq(items.id, 'hello'))))[0];
    const before = await snapshot();
    const childSvc = new ItemService({ db, siteId: env.siteId, keyProvider });
    await childSvc.patch('posts', 'hello', { data: { title: 'Changed in env' }, status: 'published' });
    await childSvc.softDelete('posts', 'second');
    expect(await snapshot()).toEqual(before);
    const [second] = await db.select({ deletedAt: items.deletedAt }).from(items).where(and(eq(items.siteId, ORIGIN), eq(items.id, 'second')));
    expect(second!.deletedAt).toBeNull();
    // The environment's revision belongs to the environment.
    const revs = await db.select().from(revisions).where(eq(revisions.itemId, 'hello'));
    expect(revs.filter((r) => r.siteId === env.siteId).length).toBeGreaterThan(0);
  });

  it('isolation: flows of an environment never dispatch; the marker is reserved', async () => {
    const env = await createEnv('isolated');
    await db.update(flows).set({ status: 'active' }).where(eq(flows.siteId, env.siteId)); // even if re-enabled
    const enqueue = vi.fn(async () => 'job');
    const queue = { enqueue, process: () => undefined, getStatus: async () => null } as unknown as QueueProvider;
    const event = { collection: 'posts', action: 'update' as const, itemId: 'hello', data: {} } as Parameters<typeof dispatchItemEvent>[1];

    expect(await isEnvironmentSite(db, env.siteId)).toBe(true);
    expect(await isEnvironmentSite(db, ORIGIN)).toBe(false);
    await dispatchItemEvent({ db, siteId: env.siteId, queue }, event);
    expect(enqueue).not.toHaveBeenCalled();
    await dispatchItemEvent({ db, siteId: ORIGIN, queue }, event);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // The admin of the child cannot forge or remove the marker.
    const del = await call('DELETE', `/settings/${ENVIRONMENT_MARKER_KEY}`, undefined, { site: env.siteId });
    expect(del.status).toBe(403);
    const put = await call('POST', '/settings', { key: ENVIRONMENT_MARKER_KEY, value: {} }, { site: env.siteId });
    expect(put.status).toBe(403);
  });

  it('guards: flag off → 404, API key → 403, nesting → 409, limit → 409, bad scope → 400', async () => {
    await db.delete(settings).where(and(eq(settings.siteId, ORIGIN), eq(settings.key, 'release.flags')));
    resetReleaseFlagStateForTests();
    expect((await call('GET', '/environments')).status).toBe(404);
    await db.insert(settings).values({ siteId: ORIGIN, key: 'release.flags', value: { 'content-environments': true } });
    resetReleaseFlagStateForTests();

    const viaKey: AuthPrincipal = { type: 'api_key', userId: ADMIN, apiKeyId: 'key-env', roles: ['admin'], raw: {} };
    expect((await call('GET', '/environments', undefined, { principal: viaKey })).status).toBe(403);

    const bad = await call('POST', '/environments', { key: 'x1', name: 'x', contentScope: { mode: 'collections', collections: ['nope'] } });
    expect(bad.status).toBe(400);

    const env = await createEnv('one', { mode: 'none' });
    expect((await db.select().from(items).where(eq(items.siteId, env.siteId))).length).toBe(0);
    // Nesting: even with the flag on in the child, it cannot be forked.
    await db.insert(settings).values({ siteId: env.siteId, key: 'release.flags', value: { 'content-environments': true } });
    resetReleaseFlagStateForTests();
    const nested = await call('POST', '/environments', { key: 'nested', name: 'n' }, { site: env.siteId });
    expect(nested.status).toBe(409);
    expect(await nested.json()).toMatchObject({ errors: [{ code: 'ENVIRONMENT_NESTING_UNSUPPORTED' }] });

    const dup = await call('POST', '/environments', { key: 'one', name: 'again' });
    expect(dup.status).toBe(409);

    await db.insert(settings).values({ siteId: ORIGIN, key: 'environments.maxPerSite', value: 1 as unknown as object });
    const over = await call('POST', '/environments', { key: 'two', name: 'two' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ errors: [{ code: 'ENVIRONMENT_LIMIT_REACHED' }] });

    // Another origin's key is a 404 (no existence leak).
    expect((await call('GET', '/environments/one', undefined, { site: env.siteId })).status).toBe(404);
  });

  it('list, detail and delete; deleting keeps every origin file and item', async () => {
    const env = await createEnv('to-delete');
    const list = await call('GET', '/environments');
    expect(((await list.json()) as { data: Array<{ key: string }> }).data.map((e) => e.key)).toEqual(['to-delete']);

    await new ItemService({ db, siteId: env.siteId, keyProvider }).patch('posts', 'hello', { data: { title: 'env edit' } });
    const detail = await call('GET', '/environments/to-delete');
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { data: { changedItems: number; originChanged: boolean } }).data).toMatchObject({ changedItems: 1, originChanged: false });

    const originFiles = await db.select().from(files).where(eq(files.siteId, ORIGIN));
    const res = await call('DELETE', '/environments/to-delete');
    expect(res.status).toBe(200);
    expect((await db.select().from(sites).where(eq(sites.id, env.siteId))).length).toBe(0);
    expect(await db.select().from(environments).where(eq(environments.siteId, ORIGIN))).toEqual([]);
    expect(await db.select().from(files).where(eq(files.siteId, ORIGIN))).toEqual(originFiles);
    expect((await db.select().from(items).where(and(eq(items.siteId, ORIGIN), isNull(items.deletedAt)))).length).toBe(4);
  });
});
