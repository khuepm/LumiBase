import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, environmentLineage, environments, files, items, revisions, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { ItemService } from '../../item-service';
import { SchemaService } from '../../schema-service';
import { promoteContent, orderCreates } from '../content-promote';
import { envHarness, keyProvider } from './helpers';

/**
 * Content_Promote on real Postgres (#853 task 7, gate GD): an origin that
 * moved away from the base is never overwritten, not even by a race between
 * plan and write; new items keep their ids and arrive in dependency order
 * (cycles included); the schema and dependency gates hold; references are in
 * the origin's id space afterwards; a re-run writes nothing twice.
 */

const ORIGIN = 'site_env_content_origin';
const ADMIN = 'usr_env_content_admin';

type Outcome = { itemId: string; outcome: string; reason?: string; revisionId?: string | null };
type Result = { plan: { items: Array<{ itemId: string; action: string; reason?: string }> }; outcomes?: Outcome[]; mergeRunId?: string };

describe.skipIf(!hasDbIntegrationUrl)('Content Environments — content promote (DB integration)', () => {
  let db: Database;
  const h = envHarness(() => db, ORIGIN, ADMIN);
  const svc = (siteId: string) => new ItemService({ db, siteId, keyProvider });
  const schema = (siteId: string) => new SchemaService({ db, siteId });
  const row = async (siteId: string, id: string) => (await db.select().from(items).where(and(eq(items.siteId, siteId), eq(items.id, id))))[0];
  const plain = async (siteId: string, collection: string, id: string) => {
    const r = (await row(siteId, id))!;
    return svc(siteId).decryptStoredData(collection, id, r.data as Record<string, unknown>, r.dekWrapped);
  };
  const promote = async (key: string, body: Record<string, unknown>) => {
    const res = await h.call('POST', `/environments/${key}/promote/content`, body);
    return { status: res.status, data: res.json.data as Result, errors: res.json.errors };
  };
  const outcomeOf = (r: Result, id: string) => r.outcomes!.find((o) => o.itemId === id);

  beforeAll(async () => {
    db = await connectDbIntegration('environments-content-promote');
  });
  afterAll(async () => {
    if (db) await h.cleanup();
  });
  beforeEach(async () => {
    await h.reset();
    const s = schema(ORIGIN);
    await s.createCollection({ name: 'authors', label: 'Authors', primaryKeyType: 'string' });
    await s.createField('authors', { name: 'name', type: 'string', interface: 'input' });
    await s.createCollection({ name: 'posts', label: 'Posts', primaryKeyType: 'string' });
    await s.createField('posts', { name: 'title', type: 'string', interface: 'input' });
    await s.createField('posts', { name: 'author', type: 'string', interface: 'select-dropdown-m2o' });
    await s.createField('posts', { name: 'cover', type: 'string', interface: 'file' });
    await s.createField('posts', { name: 'note', type: 'string', interface: 'input', encrypted: true });
    await s.createRelation({ manyCollection: 'posts', manyField: 'author', oneCollection: 'authors', type: 'm2o' });
    await s.createCollection({ name: 'nodes', label: 'Nodes', primaryKeyType: 'string' });
    await s.createField('nodes', { name: 'next', type: 'string', interface: 'select-dropdown-m2o' });
    await s.createRelation({ manyCollection: 'nodes', manyField: 'next', oneCollection: 'nodes', type: 'm2o' });
    const o = svc(ORIGIN);
    await o.create('authors', { data: { id: 'ada', name: 'Ada' } });
    await o.create('posts', { data: { id: 'hello', title: 'Hello', author: 'ada', note: 'n1' } });
    await o.create('posts', { data: { id: 'bye', title: 'Bye', author: 'ada' } });
  });

  it('promotes an edit, records provenance and the new base; a re-run writes nothing', async () => {
    const env = await h.fork('clean');
    await svc(env.siteId).patch('posts', 'hello', { data: { title: 'Hello from env', note: 'n2' } });

    const dry = await promote('clean', { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.data.plan.items.find((i) => i.itemId === 'hello')).toMatchObject({ action: 'promote' });
    expect((await row(ORIGIN, 'hello'))!.data).toMatchObject({ title: 'Hello' });

    const apply = await promote('clean', { dryRun: false });
    expect(apply.status).toBe(200);
    expect(outcomeOf(apply.data, 'hello')).toMatchObject({ outcome: 'promoted' });
    expect(await plain(ORIGIN, 'posts', 'hello')).toMatchObject({ title: 'Hello from env', note: 'n2', author: 'ada' });

    // Provenance: the origin revision names the environment and the run (Req 12.3).
    const [rev] = await db.select().from(revisions).where(and(eq(revisions.siteId, ORIGIN), eq(revisions.id, outcomeOf(apply.data, 'hello')!.revisionId!)));
    expect(rev!.sources).toEqual([{ type: 'environment', environmentId: env.id, mergeRunId: apply.data.mergeRunId }]);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.siteId, ORIGIN), eq(auditLog.event, 'environment_content_promoted')))).length).toBe(1);
    const [envRow] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(envRow!.status).toBe('ready');
    expect(envRow!.mergedAt).toBeTruthy();

    const revCount = (await db.select().from(revisions).where(eq(revisions.siteId, ORIGIN))).length;
    const again = await promote('clean', { dryRun: false });
    expect(again.status).toBe(200);
    expect(again.data.outcomes!.filter((o) => ['promoted', 'created', 'deleted'].includes(o.outcome))).toEqual([]);
    expect((await db.select().from(revisions).where(eq(revisions.siteId, ORIGIN))).length).toBe(revCount);
  });

  it('never overwrites an origin that changed — before the plan or between plan and write', async () => {
    const env = await h.fork('conflict');
    await svc(env.siteId).patch('posts', 'hello', { data: { title: 'env title' } });
    await svc(env.siteId).patch('posts', 'bye', { data: { title: 'env bye' } });
    await svc(ORIGIN).patch('posts', 'hello', { data: { title: 'origin title' } });

    const dry = await promote('conflict', { dryRun: true });
    expect(dry.data.plan.items.find((i) => i.itemId === 'hello')).toMatchObject({ action: 'conflict', reason: 'ORIGIN_CHANGED' });

    // Race: the origin is edited after the plan, right before the write.
    const [envRow] = await db.select().from(environments).where(eq(environments.id, env.id));
    const result = await promoteContent(
      {
        db,
        systemDb: db,
        userId: ADMIN,
        keyProvider,
        originItems: () => {
          const real = svc(ORIGIN);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === 'patch') {
                return async (...args: Parameters<ItemService['patch']>) => {
                  if (args[1] === 'bye') await svc(ORIGIN).patch('posts', 'bye', { data: { title: 'origin raced' } });
                  return target.patch(...args);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        },
      },
      envRow!,
      { dryRun: false },
    );
    expect(result.outcomes!.find((o) => o.itemId === 'hello')).toMatchObject({ outcome: 'conflict' });
    expect(result.outcomes!.find((o) => o.itemId === 'bye')).toMatchObject({ outcome: 'conflict', reason: 'ORIGIN_CHANGED' });
    expect((await row(ORIGIN, 'hello'))!.data).toMatchObject({ title: 'origin title' });
    expect((await row(ORIGIN, 'bye'))!.data).toMatchObject({ title: 'origin raced' });
  });

  it('creates new items with the same id in dependency order, cycles included', async () => {
    const env = await h.fork('create');
    const e = svc(env.siteId);
    await e.create('authors', { data: { id: 'grace', name: 'Grace' } });
    await e.create('posts', { data: { id: 'new-post', title: 'New', author: 'grace' } });
    await e.create('nodes', { data: { id: 'n-a' } });
    await e.create('nodes', { data: { id: 'n-b', next: 'n-a' } });
    await e.patch('nodes', 'n-a', { data: { next: 'n-b' } });

    const apply = await promote('create', { dryRun: false });
    expect(apply.status).toBe(200);
    for (const id of ['grace', 'new-post', 'n-a', 'n-b']) expect(outcomeOf(apply.data, id)).toMatchObject({ outcome: 'created' });
    expect((await row(ORIGIN, 'new-post'))!.data).toMatchObject({ author: 'grace' });
    expect((await row(ORIGIN, 'n-a'))!.data).toMatchObject({ next: 'n-b' });
    expect((await row(ORIGIN, 'n-b'))!.data).toMatchObject({ next: 'n-a' });
    // Lineage now knows them, so the next run does nothing.
    const lin = await db.select().from(environmentLineage).where(and(eq(environmentLineage.environmentId, env.id), eq(environmentLineage.envRowId, 'grace')));
    expect(lin[0]!.originRowId).toBe('grace');
    const again = await promote('create', { dryRun: true });
    expect(again.data.plan.items.filter((i) => i.action !== 'unchanged')).toEqual([]);
  });

  it('a reference to an item not promoted in the same run is DEPENDENCY_NOT_PROMOTED', async () => {
    const env = await h.fork('deps');
    await svc(env.siteId).create('authors', { data: { id: 'linus', name: 'Linus' } });
    await svc(env.siteId).create('posts', { data: { id: 'orphan', title: 'x', author: 'linus' } });
    const res = await promote('deps', { dryRun: false, items: [{ collection: 'posts', itemId: 'orphan' }] });
    expect(outcomeOf(res.data, 'orphan')).toMatchObject({ outcome: 'failed', reason: 'DEPENDENCY_NOT_PROMOTED' });
    expect(await row(ORIGIN, 'orphan')).toBeUndefined();
  });

  it('a collection whose schema was not promoted is SCHEMA_NOT_PROMOTED', async () => {
    const env = await h.fork('gate');
    await schema(env.siteId).createField('posts', { name: 'subtitle', type: 'string', interface: 'input' });
    await svc(env.siteId).patch('posts', 'hello', { data: { subtitle: 'sub' } });
    const res = await promote('gate', { dryRun: false });
    expect(outcomeOf(res.data, 'hello')).toMatchObject({ outcome: 'failed', reason: 'SCHEMA_NOT_PROMOTED' });
    expect((await row(ORIGIN, 'hello'))!.data).not.toHaveProperty('subtitle');
  });

  it('a delete in the environment soft-deletes the origin item', async () => {
    const env = await h.fork('delete');
    await svc(env.siteId).softDelete('posts', 'bye');
    const res = await promote('delete', { dryRun: false });
    expect(outcomeOf(res.data, 'bye')).toMatchObject({ outcome: 'deleted' });
    expect((await row(ORIGIN, 'bye'))!.deletedAt).toBeTruthy();
  });

  it('file references end in the origin id space; an environment-only file is registered there', async () => {
    const [originFile] = await db.insert(files).values({ siteId: ORIGIN, filenameDisk: 'o/one.png', filenameDownload: 'one.png', mime: 'image/png', filesize: 1 }).returning();
    await svc(ORIGIN).patch('posts', 'hello', { data: { cover: originFile!.id } });
    const env = await h.fork('files');
    const [envFile] = await db.insert(files).values({ siteId: env.siteId, filenameDisk: 'env/new.png', filenameDownload: 'new.png', mime: 'image/png', filesize: 2 }).returning();
    await svc(env.siteId).patch('posts', 'bye', { data: { cover: envFile!.id, title: 'with new file' } });
    // An unrelated edit to hello keeps its (origin) file reference.
    await svc(env.siteId).patch('posts', 'hello', { data: { title: 'hello again' } });

    const res = await promote('files', { dryRun: false });
    expect(outcomeOf(res.data, 'bye')).toMatchObject({ outcome: 'promoted' });
    expect(outcomeOf(res.data, 'hello')).toMatchObject({ outcome: 'promoted' });
    const originFiles = await db.select().from(files).where(eq(files.siteId, ORIGIN));
    const registered = originFiles.find((f) => f.filenameDisk === 'env/new.png')!;
    expect(registered).toBeTruthy();
    expect((await row(ORIGIN, 'bye'))!.data).toMatchObject({ cover: registered.id });
    expect((await row(ORIGIN, 'hello'))!.data).toMatchObject({ cover: originFile!.id });

    // No environment file id leaked into origin data.
    const envFileIds = (await db.select({ id: files.id }).from(files).where(eq(files.siteId, env.siteId))).map((f) => f.id);
    const originData = JSON.stringify((await db.select({ data: items.data }).from(items).where(and(eq(items.siteId, ORIGIN), isNull(items.deletedAt)))).map((r) => r.data));
    for (const id of envFileIds) expect(originData).not.toContain(id);
  });

  it('orders creates topologically and defers only the cyclic edge', () => {
    const { order, deferred } = orderCreates([
      { id: 'post', refs: ['author'] },
      { id: 'author', refs: [] },
      { id: 'a', refs: ['b'] },
      { id: 'b', refs: ['a'] },
    ]);
    expect(order.indexOf('author')).toBeLessThan(order.indexOf('post'));
    expect([...deferred.values()].flat()).toHaveLength(1);
  });
});
