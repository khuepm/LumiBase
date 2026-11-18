import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sites, uploadSessions, type Database } from '@lumibase/database';
import {
  DrizzleUploadSessionRepository,
  abortExpiredSession,
  expiredSessionsAcrossSites,
} from '../services/files/tus/session-repo';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Resumable-upload sessions against real PostgreSQL (#704): the conditional
 * UPDATE lease (one writer per upload, crashed leases reclaimable), progress
 * commits only by the lease holder, site scoping, and the expiry queries.
 */

const SITE_A = 'site_tus_a';
const SITE_B = 'site_tus_b';
const NOW = new Date('2026-11-18T10:00:00Z');

describe.skipIf(!hasDbIntegrationUrl)('upload sessions (real PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('upload-sessions');
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, id)).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id: site,
        name: site,
      });
    }
  });

  const newSession = (repo: DrizzleUploadSessionRepository, id: string, expiresAt = new Date(NOW.getTime() + 3_600_000)) =>
    repo.create({
      id,
      createdBy: 'u1',
      filename: 'a.mp4',
      mime: 'video/mp4',
      length: 100,
      storageKey: `sites/${repo.siteId}/uploads/${id}/a.mp4`,
      multipartId: 'mp1',
      folder: null,
      metadata: {},
      expiresAt,
    });

  it('grants the lease to one writer at the expected offset, and lets only the holder commit', async () => {
    const repo = new DrizzleUploadSessionRepository(db, SITE_A);
    await newSession(repo, 'tus_lease');
    const until = new Date(NOW.getTime() + 60_000);
    expect(await repo.claim('tus_lease', 0, 'w1', until, NOW)).not.toBeNull();
    expect(await repo.claim('tus_lease', 0, 'w2', until, NOW)).toBeNull(); // live lease
    expect(await repo.commit('tus_lease', 'w2', { offset: 50, parts: [], tailSize: 0, expiresAt: until })).toBeNull();
    const committed = await repo.commit('tus_lease', 'w1', { offset: 50, parts: [{ partNumber: 1, etag: 'e1' }], tailSize: 2, expiresAt: until });
    expect(committed).toMatchObject({ offset: 50, tailSize: 2, lockToken: null, parts: [{ partNumber: 1, etag: 'e1' }] });
    expect(await repo.claim('tus_lease', 0, 'w3', until, NOW)).toBeNull(); // stale offset
    // A crashed holder's lease can be taken once it expired.
    await repo.claim('tus_lease', 50, 'crashed', until, NOW);
    expect(await repo.claim('tus_lease', 50, 'w4', until, new Date(until.getTime() + 1))).not.toBeNull();
  });

  it('is scoped to its site', async () => {
    const a = new DrizzleUploadSessionRepository(db, SITE_A);
    const b = new DrizzleUploadSessionRepository(db, SITE_B);
    await newSession(a, 'tus_scoped');
    expect(await b.get('tus_scoped')).toBeNull();
    expect(await b.claim('tus_scoped', 0, 'x', new Date(NOW.getTime() + 1000), NOW)).toBeNull();
    expect(await b.finish('tus_scoped', { status: 'aborted' })).toBeNull();
    expect((await a.get('tus_scoped'))!.status).toBe('active');
  });

  it('lists expired active sessions across sites and aborts each once', async () => {
    const a = new DrizzleUploadSessionRepository(db, SITE_A);
    const b = new DrizzleUploadSessionRepository(db, SITE_B);
    await newSession(a, 'tus_old_a', new Date(NOW.getTime() - 1000));
    await newSession(b, 'tus_old_b', new Date(NOW.getTime() - 2000));
    await newSession(a, 'tus_live', new Date(NOW.getTime() + 1000));
    const expired = (await expiredSessionsAcrossSites(db, NOW, 100)).filter((s) => s.id.startsWith('tus_'));
    expect(expired.map((s) => s.id)).toEqual(['tus_old_b', 'tus_old_a']);
    expect(await abortExpiredSession(db, SITE_A, 'tus_old_a')).toBe(true);
    expect(await abortExpiredSession(db, SITE_A, 'tus_old_a')).toBe(false);
    const row = await db.select({ s: uploadSessions.status }).from(uploadSessions).where(eq(uploadSessions.id, 'tus_old_a'));
    expect(row[0]!.s).toBe('aborted');
  });
});
