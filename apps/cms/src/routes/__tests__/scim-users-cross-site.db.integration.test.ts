import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { activity, scimTokens, sites, userIdentities, userSites, users, type Database } from '@lumibase/database';

import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { scimRouter } from '../scim';

/**
 * SCIM `POST /Users` against an account that lives on ANOTHER site (#862, #912),
 * on real Postgres through the real router.
 *
 * Site A holds the existing accounts; site B's SCIM token provisions the same
 * address. An account whose mailbox is unproven (SSO JIT, SCIM-created) must
 * not be bound to site B, and the response must be indistinguishable from the
 * "already a member of this site" answer. A proven account (password, past
 * verification) is linked, as before.
 *
 * Rows are tagged `scimx` / the `scimx-it.test` domain for cleanup.
 */

const DOMAIN = 'scimx-it.test';
const SITE_A = 'site_scimx_a';
const SITE_B = 'site_scimx_b';
const TOKEN_B = 'scimx-token-site-b';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!hasDbIntegrationUrl)('SCIM POST /Users — cross-site binding (#862, #912) — DB integration', () => {
  let db: Database;
  let app: Hono<AppEnv>;

  async function cleanup(): Promise<void> {
    await db.delete(userSites).where(inArray(userSites.siteId, [SITE_A, SITE_B]));
    await db.delete(activity).where(inArray(activity.siteId, [SITE_A, SITE_B]));
    await db.execute(sql`DELETE FROM lumibase_user_identities WHERE lower(email_at_link) LIKE ${`%@${DOMAIN}`}`);
    await db.execute(sql`DELETE FROM lumibase_users WHERE lower(email) LIKE ${`%@${DOMAIN}`}`);
    await db.delete(scimTokens).where(inArray(scimTokens.siteId, [SITE_A, SITE_B]));
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
  }

  async function memberOn(siteId: string, userId: string): Promise<boolean> {
    const rows = await db
      .select({ userId: userSites.userId })
      .from(userSites)
      .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, userId)));
    return rows.length > 0;
  }

  async function accountOnSiteA(values: Partial<typeof users.$inferInsert> & { email: string }) {
    const [row] = await db.insert(users).values({ status: 'active', ...values }).returning({ id: users.id });
    await db.insert(userSites).values({ userId: row!.id, siteId: SITE_A });
    return row!.id;
  }

  function provisionFromSiteB(userName: string) {
    return app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_B}` },
      body: JSON.stringify({ userName, externalId: `idp-b|${userName}` }),
    });
  }

  beforeAll(async () => {
    db = await connectDbIntegration('scim-users-cross-site');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.route('/scim/v2', scimRouter);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE_A, name: 'SCIMX A' },
      { organizationId: org, id: SITE_B, name: 'SCIMX B' },
    ]);
    await db.insert(scimTokens).values({ siteId: SITE_B, tokenHash: sha256(TOKEN_B), label: 'scimx-b' });
  });

  it('does not bind an unverified SSO JIT account from site A and gives no existence hint', async () => {
    // SSO JIT: IdP subject as externalId, active, no password, legacy issuer identity only.
    const jitId = await accountOnSiteA({ email: `jit@${DOMAIN}`, externalId: 'idp-a|jit' });
    // Baseline: a member already on site B yields the "in use" answer.
    const memberId = await accountOnSiteA({ email: `member@${DOMAIN}`, passwordHash: 'x' });
    await db.insert(userSites).values({ userId: memberId, siteId: SITE_B });

    const res = await provisionFromSiteB(`JIT@${DOMAIN}`);
    const baseline = await provisionFromSiteB(`member@${DOMAIN}`);

    expect(res.status).toBe(409);
    expect(await memberOn(SITE_B, jitId)).toBe(false);
    expect(await res.json()).toEqual(await baseline.json());
  });

  it('does not bind a SCIM-created account from site A', async () => {
    // Created exactly as site A's SCIM POST /Users creates it.
    const scimId = await accountOnSiteA({ email: `scim@${DOMAIN}`, externalId: `idp-a|scim@${DOMAIN}` });

    const res = await provisionFromSiteB(`scim@${DOMAIN}`);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { scimType?: string; detail?: string };
    expect(body.scimType).toBe('uniqueness');
    expect(body.detail).toBe('userName is already in use');
    expect(await memberOn(SITE_B, scimId)).toBe(false);
  });

  it('does not bind an unverified self-registration from site A', async () => {
    // `/auth/register` keeps a password account `invited` until the emailed link is clicked.
    const pendingId = await accountOnSiteA({ email: `pending@${DOMAIN}`, passwordHash: 'pbkdf2$placeholder', status: 'invited' });

    const res = await provisionFromSiteB(`Pending@${DOMAIN}`);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail?: string }).detail).toBe('userName is already in use');
    expect(await memberOn(SITE_B, pendingId)).toBe(false);
  });

  it('links a verified account from site A (201, membership on site B, profile untouched)', async () => {
    const verifiedId = await accountOnSiteA({
      email: `verified@${DOMAIN}`,
      passwordHash: 'pbkdf2$placeholder',
      firstName: 'Vera',
    });

    const res = await provisionFromSiteB(`verified@${DOMAIN}`);

    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe(verifiedId);
    expect(await memberOn(SITE_B, verifiedId)).toBe(true);
    const [row] = await db.select({ firstName: users.firstName, externalId: users.externalId }).from(users).where(eq(users.id, verifiedId));
    expect(row).toEqual({ firstName: 'Vera', externalId: null });
  });

  it('links a social-login account whose provider identity is linked under that address', async () => {
    const socialId = await accountOnSiteA({ email: `social@${DOMAIN}` });
    await db.insert(userIdentities).values({
      userId: socialId,
      issuer: 'https://accounts.google.com',
      subject: 'g-scimx-1',
      emailAtLink: `social@${DOMAIN}`,
    });

    const res = await provisionFromSiteB(`social@${DOMAIN}`);

    expect(res.status).toBe(201);
    expect(await memberOn(SITE_B, socialId)).toBe(true);
  });

  it('creates a brand-new account when nothing resolves', async () => {
    const res = await provisionFromSiteB(`  fresh@${DOMAIN}\t`);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; userName: string };
    expect(body.userName).toBe(`fresh@${DOMAIN}`);
    expect(await memberOn(SITE_B, body.id)).toBe(true);
  });
  describe('writes to an account linked from another site', () => {
    function scimB(method: string, id: string, body?: unknown) {
      return app.request(`/scim/v2/Users/${id}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_B}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    async function linked() {
      const id = await accountOnSiteA({
        email: `shared@${DOMAIN}`,
        passwordHash: 'pbkdf2$placeholder',
        firstName: 'Vera',
        lastName: 'Shared',
      });
      expect((await provisionFromSiteB(`shared@${DOMAIN}`)).status).toBe(201);
      return id;
    }

    async function account(id: string) {
      const [row] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName, status: users.status })
        .from(users)
        .where(eq(users.id, id));
      return row;
    }

    const untouched = { email: `shared@${DOMAIN}`, firstName: 'Vera', lastName: 'Shared', status: 'active' };

    it('PATCH cannot change the email or name of the shared account', async () => {
      const id = await linked();

      const res = await scimB('PATCH', id, {
        Operations: [
          { op: 'replace', path: 'userName', value: `attacker@${DOMAIN}` },
          { op: 'replace', path: 'name.givenName', value: 'Mallory' },
        ],
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { userName: string }).userName).toBe(`shared@${DOMAIN}`);
      expect(await account(id)).toEqual(untouched);
      expect(await memberOn(SITE_B, id)).toBe(true);
    });

    it('PUT cannot change the email or name of the shared account', async () => {
      const id = await linked();

      const res = await scimB('PUT', id, { userName: `attacker@${DOMAIN}`, name: { givenName: 'Mallory' }, active: true });

      expect(res.status).toBe(200);
      expect(await account(id)).toEqual(untouched);
    });

    it('PATCH active=false removes site B membership and leaves the account active on site A', async () => {
      const id = await linked();

      const res = await scimB('PATCH', id, { Operations: [{ op: 'replace', path: 'active', value: false }] });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { active: boolean }).active).toBe(false);
      expect(await account(id)).toEqual(untouched);
      expect(await memberOn(SITE_B, id)).toBe(false);
      expect(await memberOn(SITE_A, id)).toBe(true);
    });

    it('DELETE removes site B membership and leaves the account active on site A', async () => {
      const id = await linked();

      const res = await scimB('DELETE', id);

      expect(res.status).toBe(204);
      expect(await account(id)).toEqual(untouched);
      expect(await memberOn(SITE_B, id)).toBe(false);
      expect(await memberOn(SITE_A, id)).toBe(true);
    });

    it('still updates and suspends an account that belongs to site B only', async () => {
      const created = await provisionFromSiteB(`own@${DOMAIN}`);
      const { id } = (await created.json()) as { id: string };

      const res = await scimB('PATCH', id, {
        Operations: [
          { op: 'replace', path: 'name.givenName', value: 'Owen' },
          { op: 'replace', path: 'active', value: false },
        ],
      });

      expect(res.status).toBe(200);
      expect(await account(id)).toEqual({ email: `own@${DOMAIN}`, firstName: 'Owen', lastName: null, status: 'suspended' });
      expect(await memberOn(SITE_B, id)).toBe(true);
    });
  });
});
