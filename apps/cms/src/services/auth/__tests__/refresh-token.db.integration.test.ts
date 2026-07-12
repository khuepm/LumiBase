import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, sites, users, type Database } from '@lumibase/database';
import {
  issueRefreshToken,
  rotateRefreshToken,
  listUserSessions,
  revokeSessionById,
  pruneRefreshTokens,
} from '../refresh-token';

/**
 * DB-backed integration test for the rotating refresh-token flow. Drives the
 * REAL SQL (insert, rotation transaction, reuse-detection family revoke,
 * expiry prune) against a live Postgres so the in-memory unit mocks are
 * backed by something true.
 *
 * Uses the repo's shared `DATABASE_URL` pattern: skips with a warning when
 * unset/unreachable so local + CI runs without a database stay green.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_refresh_it';
const USER = 'user_refresh_it';

describe('Refresh-token flow — DB integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping refresh-token DB integration: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping refresh-token DB integration: database not reachable.');
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(sql`${sites.id} = ${SITE}`).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Cascade from sites clears refresh_tokens + user_sites.
    await db.delete(sites).where(sql`${sites.id} = ${SITE}`);
    await db.delete(users).where(sql`${users.id} = ${USER}`);
    await db.insert(sites).values({ id: SITE, name: 'Refresh IT' });
    await db.insert(users).values({ id: USER, email: 'refresh-it@example.com', status: 'active' });
  });

  it('rotates a live token and detects reuse of the retired one', async () => {
    if (!canConnect) return;

    const first = await issueRefreshToken(db, { siteId: SITE, userId: USER, audience: 'studio' }, undefined);

    // Rotate with the live token → success, same family.
    const r1 = await rotateRefreshToken(db, { rawToken: first.token, siteId: SITE }, undefined);
    expect(r1.ok).toBe(true);

    // Rotating the NEW token works.
    const r2 = await rotateRefreshToken(db, { rawToken: (r1 as any).token, siteId: SITE }, undefined);
    expect(r2.ok).toBe(true);

    // Re-presenting the FIRST (now revoked) token = reuse → family revoked.
    const reuse = await rotateRefreshToken(db, { rawToken: first.token, siteId: SITE }, undefined);
    expect(reuse).toEqual({ ok: false, reason: 'reuse' });

    // After the family is revoked, even the latest token no longer works.
    const after = await rotateRefreshToken(db, { rawToken: (r2 as any).token, siteId: SITE }, undefined);
    expect(after.ok).toBe(false);
  });

  it('lists and revokes sessions; prune sweeps expired rows', async () => {
    if (!canConnect) return;

    await issueRefreshToken(db, { siteId: SITE, userId: USER, audience: 'studio' }, undefined);
    await issueRefreshToken(db, { siteId: SITE, userId: USER, audience: 'frontend' }, undefined);

    let sessions = await listUserSessions(db, SITE, USER);
    expect(sessions).toHaveLength(2);

    expect(await revokeSessionById(db, SITE, USER, sessions[0]!.id)).toBe(true);
    sessions = await listUserSessions(db, SITE, USER);
    expect(sessions).toHaveLength(1);

    // Nothing expired yet.
    expect(await pruneRefreshTokens(db, new Date(0))).toBe(0);
    // Everything is "expired" relative to a far-future cutoff.
    expect(await pruneRefreshTokens(db, new Date(9e12))).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown token as invalid', async () => {
    if (!canConnect) return;
    const out = await rotateRefreshToken(db, { rawToken: 'nope', siteId: SITE }, undefined);
    expect(out).toEqual({ ok: false, reason: 'invalid' });
  });
});
