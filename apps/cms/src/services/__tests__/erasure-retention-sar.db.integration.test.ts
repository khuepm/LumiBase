import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  collections,
  createDb,
  fieldAccessLog,
  fields,
  items,
  revisions,
  settings,
  sites,
  type Database,
} from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import { ItemService } from '../item-service';
import { ErasureService } from '../erasure-service';
import { sweepRetention } from '../scheduler-worker';

/**
 * DB-backed erasure / retention / SAR integration (tasks 9.5, 10.4; Req 11-13).
 * Skips when DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 11.2, 11.3, 12.2, 12.4, 13.1-13.3**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_erasure_it';
const COLLECTION = 'patients';
const KEY = Buffer.alloc(32, 33).toString('base64');

describe('Erasure / retention / SAR — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let collectionId: string;
  const keyProvider = new EnvKeyProvider(new Map([['v0', KEY]]), 'v0');

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping erasure DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping erasure DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(auditLog).where(eq(auditLog.siteId, SITE)).catch(() => undefined);
    await db.insert(sites).values({ id: SITE, name: 'Erasure IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Patients' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId, name: 'patientId', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId, name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'phi' },
    ]);
  });

  const svc = () => new ItemService({ db, siteId: SITE, keyProvider });

  it('erasure hard-deletes item + revisions but preserves the data_erased audit (Req 11.2, 11.3)', async () => {
    if (!canConnect) return;
    const item = await svc().create(COLLECTION, { data: { patientId: 'p-1', ssn: '111' } });
    // create writes a revision.
    expect((await db.select().from(revisions).where(eq(revisions.itemId, item.id))).length).toBe(1);

    const erase = new ErasureService({ db, siteId: SITE, actorEmail: 'dpo@test.local' });
    const req = await erase.create({ collection: COLLECTION, filter: { patientId: 'p-1' } }, 'gdpr');
    await erase.confirm(req!.id);
    const done = await erase.execute(req!.id);
    expect(done!.status).toBe('completed');
    expect(done!.recordCount).toBe(1);

    // Item + revisions gone.
    expect((await db.select().from(items).where(eq(items.id, item.id))).length).toBe(0);
    expect((await db.select().from(revisions).where(eq(revisions.itemId, item.id))).length).toBe(0);

    // Tamper-evident proof remains, with a hashed subject (no plaintext id).
    const proof = await db.select().from(auditLog).where(eq(auditLog.event, 'data_erased'));
    expect(proof.length).toBe(1);
    const meta = JSON.stringify(proof[0]!.metadata);
    expect(meta).toContain('"recordCount":1');
    expect(meta).not.toContain('p-1');
  });

  it('SAR export returns decrypted subject data + provenance and audits sar_exported (Req 13)', async () => {
    if (!canConnect) return;
    await svc().create(COLLECTION, { data: { patientId: 'p-2', ssn: '222' } });

    const { records, count } = await svc().exportSubject(COLLECTION, { patientId: 'p-2' });
    expect(count).toBe(1);
    expect((records[0]!.data as Record<string, unknown>).ssn).toBe('222');
    expect(records[0]!.provenance).toBeTruthy();

    // Decrypting the phi field wrote a Field_Access_Log row — without the value (Req 5.4, 13.2).
    const access = await db.select().from(fieldAccessLog).where(eq(fieldAccessLog.siteId, SITE));
    expect(access.length).toBeGreaterThanOrEqual(1);
    expect(access[0]!.fields).toContain('ssn');
    expect(JSON.stringify(access[0]!)).not.toContain('222');
  });

  it('retention sweep applies hard_delete past maxAgeDays and audits retention_applied (Req 12)', async () => {
    if (!canConnect) return;
    const item = await svc().create(COLLECTION, { data: { patientId: 'p-3', ssn: '333' } });
    // Backdate createdAt beyond the policy window.
    await db
      .update(items)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(items.id, item.id));
    await db.insert(settings).values({
      siteId: SITE,
      key: 'retention.policies',
      value: { policies: [{ collection: COLLECTION, maxAgeDays: 30, action: 'hard_delete' }] },
    });

    const applied = await sweepRetention({ db });
    expect(applied).toBe(1);
    expect((await db.select().from(items).where(eq(items.id, item.id))).length).toBe(0);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'retention_applied')));
    expect(audits.length).toBe(1);
  });
});
