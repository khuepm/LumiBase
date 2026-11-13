import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  collections,
  fields,
  importJobs,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import {
  DEFAULT_IMPORT_CONFIG,
  createImportJob,
  driveImportJob,
  runImportStep,
  runImportTick,
  type ImportConfig,
} from '../../services/import-service';
import { importsRouter } from '../imports';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB integration for background imports (#726): chunked processing with
 * leases, row-level errors, upsert, cancel, timeout, per-site concurrency,
 * principal re-resolution, and the HTTP surface.
 */

const SITE = 'site_import_it';
const ADMIN = 'usr_import_admin';
const EDITOR = 'usr_import_editor';

const config = (over: Partial<ImportConfig> = {}): ImportConfig => ({ ...DEFAULT_IMPORT_CONFIG, chunkSize: 50, ...over });

function csv(rows: Array<{ title?: string; price?: number; vi?: string }>): string {
  const lines = ['id,status,sort,created_at,updated_at,title.en,title.vi,price'];
  rows.forEach((r, i) => lines.push(['', 'draft', String(i), '', '', r.title ?? '', r.vi ?? '', r.price ?? ''].join(',')));
  return lines.join('\r\n') + '\r\n';
}

describe.skipIf(!hasDbIntegrationUrl)('background imports — DB integration', () => {
  let db: Database;
  let principal = ADMIN;
  let fieldsMeta: Array<{ name: string; type: string; interface: string }>;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = { IMPORT_MAX_BYTES: '200000', IMPORT_CHUNK_SIZE: '50' };
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: principal, email: `${principal}@x.dev`, roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/imports', importsRouter);
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('imports');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    for (const u of [ADMIN, EDITOR]) await db.delete(users).where(eq(users.id, u)).catch(() => undefined);
  });

  // The upload route starts each job in the background. Stop whatever is still
  // running before the next test deletes the site: this UPDATE waits for any
  // in-flight chunk's row lock, and clearing the lease makes a still-running
  // worker fail its fence instead of writing.
  afterEach(async () => {
    if (!db) return;
    await db
      .update(importJobs)
      .set({ status: 'cancelled', leaseOwner: null, leaseUntil: null, message: 'test teardown' })
      .where(and(eq(importJobs.siteId, SITE), inArray(importJobs.status, ['queued', 'running'])));
  });

  beforeEach(async () => {
    principal = ADMIN;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Import IT',
    });
    for (const [id, email] of [[ADMIN, 'import-admin@x.dev'], [EDITOR, 'import-editor@x.dev']] as const) {
      await db.insert(users).values({ id, email, status: 'active' }).onConflictDoNothing();
    }
    const adminRole = (await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id }))[0]!.id;
    const viewerRole = (await db.insert(roles).values({ siteId: SITE, name: 'Viewer', adminAccess: false, appAccess: true }).returning({ id: roles.id }))[0]!.id;
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: adminRole },
      { userId: EDITOR, siteId: SITE, roleId: viewerRole },
    ]);
    for (const name of ['products', 'products_copy']) {
      const collId = (await db.insert(collections).values({ siteId: SITE, name, label: name }).returning({ id: collections.id }))[0]!.id;
      await db.insert(fields).values([
        { siteId: SITE, collectionId: collId, name: 'title', type: 'json', interface: 'translatable-text' },
        { siteId: SITE, collectionId: collId, name: 'price', type: 'decimal', interface: 'input', required: true },
      ]);
    }
    fieldsMeta = [
      { name: 'title', type: 'json', interface: 'translatable-text' },
      { name: 'price', type: 'decimal', interface: 'input' },
    ];
  });

  const adminPrincipal = () => ({ type: 'user' as const, siteId: SITE, userId: ADMIN });

  async function job(body: string, over: { mode?: 'create' | 'upsert'; cfg?: ImportConfig; collection?: string; format?: 'csv' | 'json' } = {}) {
    return createImportJob({
      db,
      siteId: SITE,
      collection: over.collection ?? 'products',
      format: over.format ?? 'csv',
      mode: over.mode ?? 'create',
      body,
      schemaFields: fieldsMeta,
      principal: adminPrincipal(),
      createdBy: ADMIN,
      config: over.cfg ?? config(),
    });
  }

  const reload = async (id: string) => (await db.select().from(importJobs).where(eq(importJobs.id, id)))[0]!;
  /** The route starts the job in the background; wait for it to finish. */
  async function settle(id: string) {
    for (let i = 0; i < 200; i++) {
      await driveImportJob({ db, config: config() }, id, 60_000);
      const row = await reload(id);
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`import ${id} did not finish`);
  }
  const countItems = async (collection = 'products') => {
    const coll = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, collection))))[0]!.id;
    return (await db.select({ n: sql<number>`count(*)::int` }).from(items).where(eq(items.collectionId, coll)))[0]!.n;
  };

  it('processes a large file in chunks and keeps translations (acceptance: no request timeout)', async () => {
    const rows = Array.from({ length: 230 }, (_, i) => ({ title: `T${i}`, vi: `Tiêu đề ${i}`, price: i + 0.5 }));
    const j = await job(csv(rows));
    expect(j.status).toBe('queued');
    expect(j.totalRows).toBe(230);

    // One step = one chunk of 50, then the lease is released.
    expect(await runImportStep({ db, config: config() }, j.id)).toBe('progressed');
    let row = await reload(j.id);
    expect(row.status).toBe('running');
    expect(row.cursor).toBe(50);
    expect(row.leaseUntil).toBeNull();

    expect(await driveImportJob({ db, config: config() }, j.id, 60_000)).toBe('done');
    row = await reload(j.id);
    expect(row).toMatchObject({ status: 'succeeded', cursor: 230, createdRows: 230, failedRows: 0, source: '' });
    expect(row.finishedAt).not.toBeNull();
    expect(await countItems()).toBe(230);
    const svc = new ItemService({ db, siteId: SITE });
    const listed = (await svc.list('products', { filter: { price: { _eq: '10.5' } } as never })).data as Array<{ data: Record<string, unknown> }>;
    expect(listed[0]!.data.title).toEqual({ en: 'T10', vi: 'Tiêu đề 10' });
  });

  it('records row-level errors with 1-based row numbers and keeps going', async () => {
    const j = await job(csv([{ title: 'ok', price: 1 }, { title: 'missing price' }, { title: 'ok2', price: 2 }]));
    await driveImportJob({ db, config: config() }, j.id, 60_000);
    const row = await reload(j.id);
    expect(row).toMatchObject({ status: 'succeeded', createdRows: 2, failedRows: 1 });
    expect(row.errors).toEqual([expect.objectContaining({ row: 2 })]);
  });

  it('marks the job failed when every row fails', async () => {
    const j = await job(csv([{ title: 'a' }, { title: 'b' }]));
    await driveImportJob({ db, config: config() }, j.id, 60_000);
    expect((await reload(j.id)).status).toBe('failed');
  });

  it('caps the stored error list and counts the rest', async () => {
    const j = await job(csv(Array.from({ length: 30 }, () => ({ title: 'x' }))), { cfg: config({ maxErrors: 5 }) });
    await driveImportJob({ db, config: config({ maxErrors: 5 }) }, j.id, 60_000);
    const row = await reload(j.id);
    expect((row.errors as unknown[]).length).toBe(5);
    expect(row.errorsTruncated).toBe(25);
  });

  it('upsert updates rows whose id exists and creates the rest', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    const existing = (await svc.create('products', { data: { title: { en: 'Old' }, price: 1 } })) as { id: string };
    const body = JSON.stringify({ items: [
      { id: existing.id, status: 'published', sort: 0, data: { title: { en: 'New' }, price: 2 } },
      { id: 'does-not-exist', data: { title: { en: 'Fresh' }, price: 3 } },
    ] });
    const j = await job(body, { mode: 'upsert', format: 'json' });
    await driveImportJob({ db, config: config() }, j.id, 60_000);
    expect(await reload(j.id)).toMatchObject({ status: 'succeeded', updatedRows: 1, createdRows: 1 });
    const updated = (await svc.detail('products', existing.id)) as { status: string; data: Record<string, unknown> };
    expect(updated.status).toBe('published');
    expect(updated.data.title).toEqual({ en: 'New' });
  });

  it('a held lease makes a second worker back off; an expired lease is resumed by the tick', async () => {
    const j = await job(csv(Array.from({ length: 120 }, (_, i) => ({ price: i }))));
    const future = new Date(Date.now() + 60_000);
    await db.update(importJobs).set({ leaseOwner: 'other', leaseUntil: future, status: 'running', startedAt: new Date() }).where(eq(importJobs.id, j.id));
    expect(await runImportStep({ db, config: config() }, j.id)).toBe('busy');
    expect(await runImportTick({ db, config: config() })).toBe(0);

    // The other worker died: once its lease expires the tick picks the job up.
    await db.update(importJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(importJobs.id, j.id));
    expect(await runImportTick({ db, config: config() })).toBe(1);
    expect(await reload(j.id)).toMatchObject({ status: 'succeeded', createdRows: 120 });
  });

  /** Titles of every item in `products`, to spot duplicates. */
  async function titlesInProducts(): Promise<string[]> {
    const coll = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'products'))))[0]!.id;
    const rows = await db.select({ data: items.data }).from(items).where(eq(items.collectionId, coll));
    return rows.map((r) => ((r.data as { title?: { en?: string } }).title?.en ?? '')).sort();
  }
  const titled = (n: number) => csv(Array.from({ length: n }, (_, i) => ({ title: `R${String(i).padStart(3, '0')}`, price: i })));
  const expected = (n: number) => Array.from({ length: n }, (_, i) => `R${String(i).padStart(3, '0')}`);

  it('a crash after N writes rolls the chunk back; resume writes every row exactly once (review on #792)', async () => {
    const j = await job(titled(120));
    // First chunk commits normally.
    await runImportStep({ db, config: config() }, j.id);
    // Second chunk "crashes" after 20 rows were written.
    const crash = new Error('process died');
    await expect(
      runImportStep({ db, config: config(), afterRowWritten: (i) => { if (i === 69) throw crash; } }, j.id),
    ).rejects.toBe(crash);
    let row = await reload(j.id);
    expect(row.cursor).toBe(50);
    expect(row.createdRows).toBe(50);
    expect(await countItems()).toBe(50); // the 20 crashed writes are gone
    // The dead worker still holds the lease; nobody can take it until it expires.
    expect(await runImportTick({ db, config: config() })).toBe(0);
    await db.update(importJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(importJobs.id, j.id));
    await runImportTick({ db, config: config() });
    row = await reload(j.id);
    expect(row).toMatchObject({ status: 'succeeded', cursor: 120, createdRows: 120 });
    expect(await titlesInProducts()).toEqual(expected(120));
  });

  it('a worker whose lease was taken before it locked the job writes nothing', async () => {
    const j = await job(titled(10));
    let wrote = 0;
    const outcome = await runImportStep(
      {
        db,
        config: config(),
        // Runs after the claim, before the chunk transaction: another worker steals the job.
        itemServiceFor: async (claimed) => {
          await db.update(importJobs).set({ leaseOwner: 'other-worker', leaseUntil: new Date(Date.now() + 60_000) }).where(eq(importJobs.id, claimed.id));
          return (bound) => {
            wrote++;
            return new ItemService({ db: bound, siteId: SITE });
          };
        },
      },
      j.id,
    );
    expect(outcome).toBe('busy');
    expect(await countItems()).toBe(0);
    expect(await reload(j.id)).toMatchObject({ cursor: 0, leaseOwner: 'other-worker' });
    expect(wrote).toBe(1); // only the describe call; no chunk ran
  });

  it('an expired lease cannot let a second worker overlap a running chunk', async () => {
    const j = await job(titled(100));
    let second: Promise<unknown> | undefined;
    await runImportStep(
      {
        db,
        config: config({ leaseMs: 1 }), // lease is already "expired" while the chunk runs
        afterRowWritten: async (i) => {
          if (i === 10) {
            // A second worker tries now. It must wait for this chunk's lock, then
            // continue from the committed cursor, not replay these rows.
            second = runImportStep({ db, config: config() }, j.id);
            await new Promise((r) => setTimeout(r, 200));
          }
        },
      },
      j.id,
    );
    expect(await second).toBe('done');
    expect(await reload(j.id)).toMatchObject({ status: 'succeeded', cursor: 100, createdRows: 100 });
    expect(await titlesInProducts()).toEqual(expected(100));
  });

  it('cancel: a queued job stops at once, a running job at its next step', async () => {
    const queued = await job(csv([{ price: 1 }]));
    let res = await app.request(`/api/v1/imports/${queued.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await reload(queued.id)).status).toBe('cancelled');
    expect(await countItems()).toBe(0);
    res = await app.request(`/api/v1/imports/${queued.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);

    const running = await job(csv(Array.from({ length: 120 }, (_, i) => ({ price: i }))));
    await runImportStep({ db, config: config() }, running.id);
    await app.request(`/api/v1/imports/${running.id}/cancel`, { method: 'POST' });
    expect(await driveImportJob({ db, config: config() }, running.id, 60_000)).toBe('done');
    expect(await reload(running.id)).toMatchObject({ status: 'cancelled', createdRows: 50 });
  });

  it('times out a job that ran past IMPORT_TIMEOUT', async () => {
    const j = await job(csv(Array.from({ length: 120 }, (_, i) => ({ price: i }))), { cfg: config({ timeoutMs: 1000 }) });
    await runImportStep({ db, config: config() }, j.id);
    const later = () => new Date(Date.now() + 5000);
    expect(await runImportStep({ db, config: config(), now: later }, j.id)).toBe('done');
    expect((await reload(j.id)).status).toBe('timed_out');
  });

  it('holds queued jobs beyond IMPORT_MAX_CONCURRENCY per site', async () => {
    const a = await job(csv(Array.from({ length: 120 }, (_, i) => ({ price: i }))));
    const b = await job(csv([{ price: 1 }]));
    const one = config({ maxConcurrency: 1 });
    await runImportStep({ db, config: one }, a.id);
    expect(await runImportStep({ db, config: one }, b.id)).toBe('waiting');
    await driveImportJob({ db, config: one }, a.id, 60_000);
    expect(await runImportStep({ db, config: one }, b.id)).toBe('done');
    expect((await reload(b.id)).status).toBe('succeeded');
  });

  it('fails the job when the principal loses access mid-way', async () => {
    const j = await job(csv(Array.from({ length: 120 }, (_, i) => ({ price: i }))));
    await runImportStep({ db, config: config() }, j.id);
    await db.delete(userSites).where(and(eq(userSites.userId, ADMIN), eq(userSites.siteId, SITE)));
    await driveImportJob({ db, config: config() }, j.id, 60_000);
    const row = await reload(j.id);
    expect(row.status).toBe('failed');
    expect(row.createdRows).toBe(50);
  });

  describe('HTTP', () => {
    it('accepts a raw CSV body, runs it, and reports progress and errors', async () => {
      const res = await app.request('/api/v1/imports?collection=products', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: csv([{ title: 'A', price: 1 }, { title: 'bad' }]),
      });
      expect(res.status).toBe(202);
      const { data } = (await res.json()) as { data: { id: string; status: string; totalRows: number } };
      expect(data).toMatchObject({ status: 'queued', totalRows: 2 });
      await settle(data.id);

      const got = (await (await app.request(`/api/v1/imports/${data.id}`)).json()) as { data: Record<string, unknown> };
      expect(got.data).toMatchObject({ status: 'succeeded', processedRows: 2, createdRows: 1, failedRows: 1 });
      expect(got.data).not.toHaveProperty('source');

      const errs = (await (await app.request(`/api/v1/imports/${data.id}/errors`)).json()) as { data: { errors: unknown[] } };
      expect(errs.data.errors).toHaveLength(1);
      const report = await (await app.request(`/api/v1/imports/${data.id}/errors?format=csv`)).text();
      expect(report.replace(/^﻿/, '').split('\r\n')[0]).toBe('row,id,message');

      const audit = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'items_import_started')));
      expect(audit[0]!.metadata).toMatchObject({ jobId: data.id, collection: 'products', rows: 2 });
    });

    it('accepts a multipart upload and infers the format from the file name', async () => {
      const form = new FormData();
      form.append('file', new File([csv([{ price: 3 }])], 'products.csv', { type: 'text/csv' }));
      const res = await app.request('/api/v1/imports?collection=products', { method: 'POST', body: form });
      expect(res.status).toBe(202);
      expect(((await res.json()) as { data: { format: string } }).data.format).toBe('csv');
    });

    it('round-trips an export through the import endpoint', async () => {
      const svc = new ItemService({ db, siteId: SITE });
      await svc.create('products', { status: 'published', sort: 1, data: { title: { en: 'Coffee', vi: 'Cà phê' }, price: 10.5 } });
      await svc.create('products', { status: 'draft', sort: 2, data: { title: { en: '=1+1' }, price: -1 } });
      for (const format of ['csv', 'json'] as const) {
        await db.delete(items).where(eq(items.collectionId, sql`(select id from lumibase_collections where site_id = ${SITE} and name = 'products_copy')`));
        const exported = await (await app.request(`/api/v1/items/products/export?format=${format}`)).text();
        const res = await app.request(`/api/v1/imports?collection=products_copy&format=${format}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: exported,
        });
        const { data } = (await res.json()) as { data: { id: string } };
        await settle(data.id);
        const read = async (c: string) =>
          ((await (await app.request(`/api/v1/items/${c}/export?format=json&sort=sort`)).json()) as { items: Array<Record<string, unknown>> }).items.map(
            ({ status, sort, data: d }) => ({ status, sort, data: d }),
          );
        expect(await read('products_copy')).toEqual(await read('products'));
      }
    });

    it('rejects bad input before creating a job', async () => {
      const post = (q: string, body: string, type = 'text/csv') =>
        app.request(`/api/v1/imports?${q}`, { method: 'POST', headers: { 'content-type': type }, body });
      expect((await post('collection=missing', csv([{ price: 1 }]))).status).toBe(404);
      expect((await post('collection=products', 'id,secret\r\nx,y\r\n')).status).toBe(400);
      expect((await post('collection=products', 'id,status\r\n')).status).toBe(400);
      expect((await post('collection=products', 'nope', 'application/octet-stream')).status).toBe(400);
      expect((await post('collection=products', 'x'.repeat(200_001))).status).toBe(413);
      expect(await db.select().from(importJobs).where(eq(importJobs.siteId, SITE))).toHaveLength(0);
    });

    it('403s without create permission; jobs are visible to their creator and admins only', async () => {
      const res = await app.request('/api/v1/imports?collection=products', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: csv([{ price: 1 }]),
      });
      const { data } = (await res.json()) as { data: { id: string } };

      principal = EDITOR;
      expect(
        (await app.request('/api/v1/imports?collection=products', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv([{ price: 1 }]) })).status,
      ).toBe(403);
      expect((await app.request(`/api/v1/imports/${data.id}`)).status).toBe(404);
      expect(((await (await app.request('/api/v1/imports')).json()) as { data: unknown[] }).data).toHaveLength(0);

      principal = ADMIN;
      expect(((await (await app.request('/api/v1/imports')).json()) as { data: unknown[] }).data).toHaveLength(1);
    });
  });
});
