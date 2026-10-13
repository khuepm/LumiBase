import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  sites,
  type Database,
} from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import { ItemService } from '../item-service';
import { runEnvelopeMigration } from '../envelope-migration-worker';
import { readEnvelopeSetting, writeEnvelopeSetting } from '../crypto/envelope-settings';
import { parseEnvelope } from '../crypto/envelope-codec';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed envelope migration + hot-path integration (task 3.6; Req 4.5).
 * Skips when DATABASE_URL is unset/unreachable.
 */

const SITE = 'site_envelope_it';
const COLLECTION = 'patients';
const KEK = Buffer.alloc(32, 44).toString('base64');

describe.skipIf(!hasDbIntegrationUrl)('Envelope migration — DB integration', () => {
  let db: Database;
  let collectionId: string;
  const keyProvider = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
  const svc = () => new ItemService({ db, siteId: SITE, keyProvider });

  beforeAll(async () => {
    db = await connectDbIntegration('envelope-migration');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Envelope IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Patients' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId, name: 'name', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId, name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'phi' },
    ]);
  });

  async function rawSsn(id: string): Promise<string> {
    const [raw] = await db.select().from(items).where(eq(items.id, id));
    return (raw!.data as Record<string, string>).ssn as string;
  }
  async function rawDek(id: string): Promise<string | null> {
    const [raw] = await db.select().from(items).where(eq(items.id, id));
    return (raw as Record<string, unknown>).dekWrapped as string | null;
  }

  it('migrates shared → envelope and back, keeping plaintext readable throughout', async () => {
    // Created in shared mode: versioned envelope ciphertext, no wrapped DEK.
    const item = await svc().create(COLLECTION, { data: { name: 'A', ssn: 's-100' } });
    expect(await rawDek(item.id)).toBeNull();
    expect(parseEnvelope(await rawSsn(item.id)).keyId).toBe('v0');

    // Toggle on + migrate to envelope.
    const base = await readEnvelopeSetting(db, SITE);
    await writeEnvelopeSetting(db, SITE, {
      ...base,
      enabled: true,
      migration: { ...base.migration, direction: 'to_envelope', status: 'running' },
    });
    const fwd = await runEnvelopeMigration({ db, siteId: SITE, keyProvider });
    expect(fwd.done).toBe(true);
    expect(fwd.migrated).toBeGreaterThanOrEqual(1);

    // Now envelope mode: record carries a wrapped DEK; plaintext still decrypts.
    expect(await rawDek(item.id)).toBeTruthy();
    const exp1 = await svc().exportSubject(COLLECTION, { name: 'A' });
    expect((exp1.records[0]!.data as Record<string, unknown>).ssn).toBe('s-100');

    // Toggle off + migrate back to shared.
    const mid = await readEnvelopeSetting(db, SITE);
    await writeEnvelopeSetting(db, SITE, {
      ...mid,
      enabled: false,
      migration: { ...mid.migration, direction: 'to_shared', status: 'running', cursor: null, processed: 0 },
    });
    const back = await runEnvelopeMigration({ db, siteId: SITE, keyProvider });
    expect(back.done).toBe(true);

    // Wrapped DEK cleared; ciphertext is a versioned shared envelope again.
    expect(await rawDek(item.id)).toBeNull();
    expect(parseEnvelope(await rawSsn(item.id)).keyId).toBe('v0');
    const exp2 = await svc().exportSubject(COLLECTION, { name: 'A' });
    expect((exp2.records[0]!.data as Record<string, unknown>).ssn).toBe('s-100');
  });

  it('hot path: new writes honor the setting (envelope on → wrapped DEK persisted)', async () => {
    const base = await readEnvelopeSetting(db, SITE);
    await writeEnvelopeSetting(db, SITE, { ...base, enabled: true });

    // A fresh service reads the setting once and writes in envelope mode.
    const created = await svc().create(COLLECTION, { data: { name: 'B', ssn: 's-200' } });
    expect(await rawDek(created.id)).toBeTruthy();

    const exported = await svc().exportSubject(COLLECTION, { name: 'B' });
    expect((exported.records[0]!.data as Record<string, unknown>).ssn).toBe('s-200');
  });

  it('migration is idempotent — a second pass migrates nothing', async () => {
    await svc().create(COLLECTION, { data: { name: 'C', ssn: 's-300' } });
    const base = await readEnvelopeSetting(db, SITE);
    await writeEnvelopeSetting(db, SITE, {
      ...base,
      enabled: true,
      migration: { ...base.migration, direction: 'to_envelope', status: 'running' },
    });
    const first = await runEnvelopeMigration({ db, siteId: SITE, keyProvider });
    expect(first.migrated).toBeGreaterThanOrEqual(1);

    // Re-run from a clean cursor — already-envelope records are skipped.
    const reset = await readEnvelopeSetting(db, SITE);
    await writeEnvelopeSetting(db, SITE, {
      ...reset,
      migration: { ...reset.migration, status: 'running', cursor: null, processed: 0 },
    });
    const second = await runEnvelopeMigration({ db, siteId: SITE, keyProvider });
    expect(second.migrated).toBe(0);
  });
});
