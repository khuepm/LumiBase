import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sites, uploadClaims, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { dbUploadClaims } from '../upload-claims';

/**
 * #993 on real Postgres: each claim transition is a single conditional UPDATE,
 * so concurrent requests cannot both win.
 */

const SITE = 'site_upload_claims_993';
const OTHER = 'site_upload_claims_993_b';
const KEY = `sites/${SITE}/files/1800000000000_abc_doc.pdf`;

describe.skipIf(!hasDbIntegrationUrl)('upload claims (#993) — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('upload-claims');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, OTHER)).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const id of [SITE, OTHER]) {
      await db.delete(sites).where(eq(sites.id, id));
      await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id, name: id });
    }
  });

  it('two concurrent PUTs: exactly one starts uploading', async () => {
    const claims = dbUploadClaims(db);
    await claims.issue(SITE, KEY, 'user:u1');
    const results = await Promise.all([claims.beginUpload(SITE, KEY), claims.beginUpload(SITE, KEY)]);
    expect(results.sort()).toEqual(['busy', 'ok']);
  });

  it('two concurrent registrations: exactly one wins, and the key then refuses raw PUTs', async () => {
    const claims = dbUploadClaims(db);
    await claims.issue(SITE, KEY, 'user:u1');
    expect(await claims.beginUpload(SITE, KEY)).toBe('ok');
    await claims.finishUpload(SITE, KEY, true);
    const results = await Promise.all([claims.register(SITE, KEY, 'user:u1'), claims.register(SITE, KEY, 'user:u1')]);
    expect(results.sort()).toEqual(['missing', 'ok']);
    expect(await claims.beginUpload(SITE, KEY)).toBe('registered');
  });

  it('only the issued principal, on the issuing site, can register', async () => {
    const claims = dbUploadClaims(db);
    await claims.issue(SITE, KEY, 'user:u1');
    await claims.beginUpload(SITE, KEY);
    await claims.finishUpload(SITE, KEY, true);
    expect(await claims.register(SITE, KEY, 'user:intruder')).toBe('missing');
    expect(await claims.register(OTHER, KEY, 'user:u1')).toBe('missing');
    expect(await claims.register(SITE, KEY, 'user:u1')).toBe('ok');
  });

  it('a failed upload returns the claim to issued; an unfinished one cannot be registered', async () => {
    const claims = dbUploadClaims(db);
    await claims.issue(SITE, KEY, 'user:u1');
    await claims.beginUpload(SITE, KEY);
    expect(await claims.register(SITE, KEY, 'user:u1')).toBe('not_uploaded');
    await claims.finishUpload(SITE, KEY, false);
    expect(await claims.beginUpload(SITE, KEY)).toBe('ok');
  });

  it('an expired claim cannot be registered; the sweep removes old claims of its site only', async () => {
    const claims = dbUploadClaims(db);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await claims.issue(SITE, KEY, 'user:u1', old);
    await claims.issue(OTHER, KEY, 'user:u1', old);
    await claims.beginUpload(SITE, KEY);
    await claims.finishUpload(SITE, KEY, true);
    expect(await claims.register(SITE, KEY, 'user:u1')).toBe('expired');
    expect(await claims.sweep(SITE, new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(1);
    const left = await db.select().from(uploadClaims).where(eq(uploadClaims.storageKey, KEY));
    expect(left.map((r) => r.siteId)).toEqual([OTHER]);
  });
});
