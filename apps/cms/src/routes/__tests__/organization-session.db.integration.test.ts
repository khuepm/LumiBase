import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { jwtVerify } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import {
  organizations,
  organizationMembers,
  sites,
  users,
  userSites,
  roles,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import {
  connectDbIntegration,
  hasDbIntegrationUrl,
} from '../../__tests__/helpers/db-harness';
import { authRouter } from '../auth';
import { withTenant } from '../../middleware/tenant';
import { hashPassword } from '../../services/auth/password';
import { provisionSite } from '../../services/site-provisioning';

const ORG = 'org_639_session',
  SITE = 'site_639_session',
  FOREIGN = 'site_639_foreign',
  USER = 'user_639_session';
const password = 'Organization-Session-Test-639!',
  secret = 'organization-session-signing-test-only';
describe.skipIf(!hasDbIntegrationUrl)(
  'organization login and refresh inheritance',
  () => {
    let db: Database, app: Hono<AppEnv>, passwordHash: string;
    const clean = async () => {
      await db.delete(sites).where(inArray(sites.id, [SITE, FOREIGN]));
      await db.delete(organizations).where(eq(organizations.id, ORG));
      await db.delete(users).where(eq(users.id, USER));
    };
    const post = (path: string, body: unknown, site = SITE) =>
      app.request(
        `/api/v1/auth/${path}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Lumi-Site': site },
          body: JSON.stringify(body),
        },
        { JWT_SECRET: secret } as AppEnv['Bindings'],
      );
    const payload = async (
      response: Response,
    ): Promise<{
      data: { token: string; refreshToken: string };
      errors: Array<{ code: string }>;
    }> =>
      response.json() as Promise<{
        data: { token: string; refreshToken: string };
        errors: Array<{ code: string }>;
      }>;
    const login = (site = SITE) =>
      post('login', { email: 'session639@example.test', password }, site);
    const decode = async (token: string) =>
      (await jwtVerify(token, new TextEncoder().encode(secret))).payload;
    beforeAll(async () => {
      db = await connectDbIntegration('organization-session');
      passwordHash = await hashPassword(password);
      app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', db);
        c.set('runtime', { cache: new MemoryCacheProvider() } as never);
        await next();
      });
      app.use('*', withTenant());
      app.route('/api/v1/auth', authRouter);
    });
    beforeEach(async () => {
      await clean();
      await db
        .insert(organizations)
        .values({ id: ORG, slug: ORG, name: 'Session 639' });
      await db.insert(users).values({
        id: USER,
        email: 'session639@example.test',
        passwordHash,
        status: 'active',
      });
      await db
        .insert(organizationMembers)
        .values({ userId: USER, organizationId: ORG, role: 'admin' });
      await provisionSite(db, {
        id: SITE,
        name: 'Session site',
        organizationId: ORG,
      });
    });
    afterAll(async () => {
      if (db) await clean();
    });

    for (const role of ['owner', 'admin'] as const)
      it(`lets an organization ${role} log in and renew without user_sites`, async () => {
        await db
          .update(organizationMembers)
          .set({ role })
          .where(eq(organizationMembers.userId, USER));
        const response = await login();
        expect(response.status).toBe(200);
        const { data } = await payload(response);
        expect((await decode(data.token)).aud).toBe('studio');
        expect(
          await db.select().from(userSites).where(eq(userSites.userId, USER)),
        ).toHaveLength(0);
        const refreshed = await post('refresh', {
          refreshToken: data.refreshToken,
        });
        expect(refreshed.status).toBe(200);
        const next = (await payload(refreshed)).data;
        expect((await decode(next.token)).aud).toBe('studio');
        expect(next.refreshToken).not.toBe(data.refreshToken);
      });

    it('inherits Studio authority even over a weaker direct frontend membership', async () => {
      const [member] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.siteId, SITE), eq(roles.name, 'Member')));
      expect(member).toBeDefined();
      await db
        .update(roles)
        .set({ appAccess: false })
        .where(eq(roles.id, member!.id));
      await db
        .insert(userSites)
        .values({ userId: USER, siteId: SITE, roleId: member!.id });
      const response = await login();
      expect(response.status).toBe(200);
      const { data } = await payload(response);
      expect((await decode(data.token)).aud).toBe('studio');
      await db
        .update(organizationMembers)
        .set({ role: 'member' })
        .where(eq(organizationMembers.userId, USER));
      const renewed = await post('refresh', {
        refreshToken: data.refreshToken,
      });
      expect(renewed.status).toBe(200);
      expect((await decode((await payload(renewed)).data.token)).aud).toBe(
        'frontend',
      );
    });

    it('refuses renewal and new login after the inherited grant is removed', async () => {
      const response = await login();
      expect(response.status).toBe(200);
      const { data } = await payload(response);
      await db
        .delete(organizationMembers)
        .where(eq(organizationMembers.userId, USER));
      const refreshed = await post('refresh', {
        refreshToken: data.refreshToken,
      });
      expect(refreshed.status).toBe(403);
      expect((await payload(refreshed)).errors[0]!.code).toBe(
        'TENANT_ACCESS_DENIED',
      );
      expect((await login()).status).toBe(403);
    });

    it('does not grant site access to an ordinary organization member', async () => {
      await db
        .update(organizationMembers)
        .set({ role: 'member' })
        .where(eq(organizationMembers.userId, USER));
      expect((await login()).status).toBe(403);
    });
  },
);
