import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  sites,
  users,
  type Database,
} from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { adminEncryptionRouter } from '../admin-encryption';
import { hashPassword } from '../../services/auth/password';
import { readEnvelopeSetting } from '../../services/crypto/envelope-settings';
import { ItemService } from '../../services/item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed route test for envelope-mode step-up + migration (task 3.6; Req 4.5).
 * Skips when DATABASE_URL is unset/unreachable.
 */

const SITE = 'site_envelope_route_it';
const COLLECTION = 'patients';
const KEK = Buffer.alloc(32, 55).toString('base64');
const PASSWORD = 'CorrectHorse!42';
const USER_ID = 'usr_envelope_admin';

describe.skipIf(!hasDbIntegrationUrl)('POST /admin/encryption/envelope — DB integration', () => {
  let db: Database;
  const keyProvider = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');

  // Minimal app injecting the context the router expects from upstream middleware.
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: USER_ID, email: 'admin@test.local', roles: ['admin'], raw: {} });
    c.set('runtime', { keys: keyProvider, queue: undefined } as never);
    await next();
  });
  app.route('/', adminEncryptionRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('admin-encryption-envelope');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, USER_ID)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.insert(sites).values({ id: SITE, name: 'Envelope Route IT' });
    await db.insert(users).values({
      id: USER_ID,
      email: 'admin@test.local',
      passwordHash: await hashPassword(PASSWORD),
    });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Patients' })
      .returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'phi' },
    ]);
    await new ItemService({ db, siteId: SITE, keyProvider }).create(COLLECTION, { data: { ssn: 's-1' } });
  });

  it('rejects a wrong step-up password (401) and leaves the mode unchanged', async () => {
    const res = await app.request('/envelope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]!.code).toBe('INVALID_CREDENTIALS');
    expect((await readEnvelopeSetting(db, SITE)).enabled).toBe(false);
  });

  it('enables envelope mode with a correct password and migrates existing records', async () => {
    const res = await app.request('/envelope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, password: PASSWORD }),
    });
    expect(res.status).toBe(200);

    const setting = await readEnvelopeSetting(db, SITE);
    expect(setting.enabled).toBe(true);
    expect(setting.migration.status).toBe('completed');

    // The pre-existing record now carries a wrapped DEK.
    const [row] = await db.select().from(items).where(eq(items.siteId, SITE));
    expect((row as Record<string, unknown>).dekWrapped).toBeTruthy();
  });
});
