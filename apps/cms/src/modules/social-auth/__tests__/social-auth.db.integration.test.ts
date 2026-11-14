import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sites, userIdentities, userSites, users, type Database } from '@lumibase/database';
import { ensureSubscriberRole } from '../../../services/auth/frontend-role';
import { drizzleIdentityRepo, resolveSocialLogin, unlinkIdentity } from '../identity-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { appleProfile, profile } from './memory-repo';

/**
 * Postgres-backed check of the Drizzle identity repository and migration 0031:
 * unique `(issuer, subject)`, account + membership + identity created in one
 * transaction, the Apple name kept on a returning sign-in, and the
 * last-login-method guard against real rows.
 */

const SITE = 'site_social_it';
const EMAILS = ['social-it-ann@example.com', 'social-it-apple@example.com'];

describe.skipIf(!hasDbIntegrationUrl)('social login — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('social-auth');
  });

  async function cleanup() {
    await db.delete(users).where(inArray(users.email, EMAILS)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  }

  afterAll(async () => {
    if (db) await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Social IT',
    });
  });

  const repo = () => drizzleIdentityRepo(db, (siteId) => ensureSubscriberRole(db, siteId));

  it('creates account, subscriber membership and identity together; Apple name survives a nameless return', async () => {
    const first = await resolveSocialLogin(repo(), {
      siteId: SITE,
      profile: appleProfile({ subject: 'it-apple-1', email: EMAILS[1]!, firstName: 'Jane', lastName: 'Appleseed' }),
    });
    expect(first.via).toBe('created');
    const [member] = await db.select().from(userSites).where(eq(userSites.userId, first.user.id));
    expect(member?.siteId).toBe(SITE);

    const again = await resolveSocialLogin(repo(), {
      siteId: SITE,
      profile: appleProfile({ subject: 'it-apple-1', email: EMAILS[1]! }),
    });
    expect(again.via).toBe('existing');
    const [row] = await db.select().from(users).where(eq(users.id, first.user.id));
    expect([row?.firstName, row?.lastName]).toEqual(['Jane', 'Appleseed']);
  });

  it('enforces one account per (issuer, subject) and guards the last login method', async () => {
    const out = await resolveSocialLogin(repo(), { siteId: SITE, profile: profile({ subject: 'it-g-1', email: EMAILS[0]! }) });
    expect(await repo().insertIdentity(out.user.id, profile({ subject: 'it-g-1', email: EMAILS[0]! }))).toBe(false);
    const [identity] = await db.select().from(userIdentities).where(eq(userIdentities.userId, out.user.id));
    await expect(unlinkIdentity(repo(), { userId: out.user.id, identityId: identity!.id })).rejects.toMatchObject({
      code: 'LAST_LOGIN_METHOD',
    });
  });
});
