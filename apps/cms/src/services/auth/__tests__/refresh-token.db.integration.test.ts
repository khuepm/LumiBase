import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sites, users, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
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

const SITE = 'site_refresh_it';
const USER = 'user_refresh_it';

describe.skipIf(!hasDbIntegrationUrl)('Refresh-token flow — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('refresh-token');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(sql`${sites.id} = ${SITE}`).catch(() => undefined);
  });

  beforeEach(async () => {
    // Cascade from sites clears refresh_tokens + user_sites.
    await db.delete(sites).where(sql`${sites.id} = ${SITE}`);
    await db.delete(users).where(sql`${users.id} = ${USER}`);
    await db.insert(sites).values({ id: SITE, name: 'Refresh IT' });
    await db.insert(users).values({ id: USER, email: 'refresh-it@example.com', status: 'active' });
  });

  it('rotates a live token and detects reuse of the retired one', async () => {

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
    const out = await rotateRefreshToken(db, { rawToken: 'nope', siteId: SITE }, undefined);
    expect(out).toEqual({ ok: false, reason: 'invalid' });
  });
});
