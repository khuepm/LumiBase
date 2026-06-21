import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  auditLog,
  collections,
  createDb,
  fields,
  items,
  sites,
  type Database,
} from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import { ItemService } from '../item-service';
import { rewrapBatch } from '../rewrap-worker';
import { parseEnvelope } from '../crypto/envelope-codec';

/**
 * DB-backed crypto integration (regulated-content-readiness task 3.7;
 * Req 1, 2, 3). Skips with a warning when DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 1.1, 2.1-2.3, 3.1-3.2, 3.6**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_crypto_it';
const COLLECTION = 'patients';
const KEY_V0 = Buffer.alloc(32, 11).toString('base64');
const KEY_V1 = Buffer.alloc(32, 22).toString('base64');

describe('Field encryption — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let collectionId: string;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping crypto DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping crypto DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Crypto IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Patients' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId, name: 'name', type: 'string', interface: 'input' },
      {
        siteId: SITE,
        collectionId,
        name: 'ssn',
        type: 'string',
        interface: 'input',
        encrypted: true,
        classification: 'phi',
      },
    ]);
  });

  const svc = (keyProvider: EnvKeyProvider) =>
    new ItemService({ db, siteId: SITE, keyProvider });

  it('stores an AES-GCM envelope, not plaintext, and round-trips internally', async () => {
    if (!canConnect) return;
    const keys = new EnvKeyProvider(new Map([['v0', KEY_V0]]), 'v0');
    const created = await svc(keys).create(COLLECTION, {
      data: { name: 'Jane', ssn: '123-45-6789' },
    });

    // Raw row holds a versioned envelope, never plaintext.
    const [raw] = await db.select().from(items).where(eq(items.id, created.id));
    const stored = (raw!.data as Record<string, string>).ssn as string;
    expect(stored).not.toContain('123-45-6789');
    expect(parseEnvelope(stored).keyId).toBe('v0');

    // Admin export internal-decrypts → plaintext round-trips.
    const exported = await svc(keys).exportSubject(COLLECTION, { name: 'Jane' });
    expect((exported.records[0]!.data as Record<string, unknown>).ssn).toBe('123-45-6789');
  });

  it('decrypts ciphertext from a retired key after rotation, and rewrap upgrades it', async () => {
    if (!canConnect) return;
    const v0only = new EnvKeyProvider(new Map([['v0', KEY_V0]]), 'v0');
    const created = await svc(v0only).create(COLLECTION, { data: { ssn: 'rotate-me' } });

    // Rotate: v1 active, v0 retired — old v0 ciphertext still decrypts.
    const rotated = new EnvKeyProvider(new Map([['v0', KEY_V0], ['v1', KEY_V1]]), 'v1');
    const afterRotate = await svc(rotated).exportSubject(COLLECTION, {});
    expect((afterRotate.records[0]!.data as Record<string, unknown>).ssn).toBe('rotate-me');

    // Rewrap upgrades the stored ciphertext to the active v1 key.
    const res = await rewrapBatch({ db, siteId: SITE, keyProvider: rotated });
    expect(res.rewrapped).toBeGreaterThanOrEqual(1);
    const [raw] = await db.select().from(items).where(eq(items.id, created.id));
    expect(parseEnvelope((raw!.data as Record<string, string>).ssn as string).keyId).toBe('v1');
  });

  it('fail-closed: a corrupted ciphertext throws DECRYPTION_FAILED + audits it', async () => {
    if (!canConnect) return;
    const keys = new EnvKeyProvider(new Map([['v0', KEY_V0]]), 'v0');
    const created = await svc(keys).create(COLLECTION, { data: { ssn: 'tamper' } });

    // Corrupt the stored ciphertext body.
    await db
      .update(items)
      .set({ data: { ssn: 'v0:bm90LXZhbGlkLWNpcGhlcg==' } })
      .where(eq(items.id, created.id));

    // patch() internal-decrypts the current value → fail closed.
    await expect(svc(keys).patch(COLLECTION, created.id, { data: {} })).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
      status: 500,
    });

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'decryption_failed'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // Never logs ciphertext/plaintext — metadata carries only identifiers.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('tamper');
  });
});
