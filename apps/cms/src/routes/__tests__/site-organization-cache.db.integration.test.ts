import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { inArray } from 'drizzle-orm';
import { organizations, organizationMembers, sites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AppEnv } from '../../env';
import { withAuth } from '../../middleware/auth';
import { withControlPlaneAccessGuard } from '../../middleware/control-plane-access-guard';
import { withSiteMembership } from '../../middleware/site-membership';
import { withStudioAccess } from '../../middleware/studio-access';
import { withTenant } from '../../middleware/tenant';
import { siteOrganizationId, siteOrganizationKey } from '../../services/domains/site-organization-cache';
import { provisionSite } from '../../services/site-provisioning';
import { orgsRouter } from '../orgs';

/**
 * The cached site → organization owner stays correct across the organization
 * routes that change it. Real PostgreSQL and the real router: what is under
 * test is that each mutation is followed by an invalidation, so the next
 * lookup reads the committed row instead of the entry cached before it.
 */

const A = 'org_seam_a', B = 'org_seam_b';
const SA = 'site_seam_a', SB = 'site_seam_b', NEW = 'site_seam_new';
const DUAL = 'usr_seam_dual';
const secret = 'site-organization-cache-test-only-secret';

describe.skipIf(!hasDbIntegrationUrl)('site → organization cache invalidation (real PostgreSQL)', () => {
  let db: Database, app: Hono<AppEnv>, cache: MemoryCacheProvider, token: string;

  async function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { JWT_SECRET: secret } as AppEnv['Bindings']);
  }
  const owner = (siteId: string) => siteOrganizationId(db, cache, siteId);
  const cached = async (siteId: string) => (await cache.getEntry<string>(siteOrganizationKey(siteId)));

  async function cleanup() {
    await db.delete(sites).where(inArray(sites.organizationId, [A, B]));
    await db.delete(organizations).where(inArray(organizations.id, [A, B]));
    await db.delete(users).where(inArray(users.id, [DUAL]));
  }

  beforeAll(async () => {
    db = await connectDbIntegration('site-organization-cache');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('runtime', { cache } as never);
      await next();
    });
    app.use('*', withTenant(), withAuth(), withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());
    app.route('/api/v1/orgs', orgsRouter);
  });

  beforeEach(async () => {
    cache = new MemoryCacheProvider();
    await cleanup();
    await db.insert(organizations).values([{ id: A, slug: A, name: 'Seam A' }, { id: B, slug: B, name: 'Seam B' }]);
    await db.insert(users).values({ id: DUAL, email: `${DUAL}@example.test`, status: 'active' });
    await db.insert(organizationMembers).values([
      { userId: DUAL, organizationId: A, role: 'owner' },
      { userId: DUAL, organizationId: B, role: 'owner' },
    ]);
    await provisionSite(db, { id: SA, name: 'Seam A', organizationId: A });
    await provisionSite(db, { id: SB, name: 'Seam B', organizationId: B });
    token = await new SignJWT({ userId: DUAL, siteId: SA, tokenVersion: 0 }).setProtectedHeader({ alg: 'HS256' })
      .setAudience('studio').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  });

  afterAll(async () => { if (db) await cleanup(); });

  it('resolves each site to its own organization and caches it', async () => {
    expect(await owner(SA)).toBe(A);
    expect(await owner(SB)).toBe(B);
    expect(await cached(SA)).toEqual({ state: 'hit', value: A });
    expect(await cached(SB)).toEqual({ state: 'hit', value: B });
  });

  it('a site transfer invalidates the cached owner', async () => {
    expect(await owner(SA)).toBe(A);

    const response = await request(`/orgs/${A}/sites/${SA}/transfer`, 'POST', { toOrganizationId: B });
    expect(response.status).toBe(200);

    expect((await cached(SA)).state).toBe('miss');
    expect(await owner(SA)).toBe(B);
    // The other site was not touched.
    expect(await owner(SB)).toBe(B);
  });

  it('a refused transfer leaves the cached owner in place', async () => {
    expect(await owner(SA)).toBe(A);

    const response = await request(`/orgs/${B}/sites/${SA}/transfer`, 'POST', { toOrganizationId: A });
    expect(response.status).toBe(404); // SA is not in B

    expect(await cached(SA)).toEqual({ state: 'hit', value: A });
  });

  it('a site deletion invalidates the cached owner', async () => {
    expect(await owner(SA)).toBe(A);

    const response = await request(`/orgs/${A}/sites/${SA}`, 'DELETE', undefined, { 'X-Confirm-Delete': SA });
    expect(response.status).toBe(200);

    expect((await cached(SA)).state).toBe('miss');
    expect(await owner(SA)).toBeNull();
  });

  it('creating a site clears an earlier "no such site" entry', async () => {
    expect(await owner(NEW)).toBeNull();
    expect((await cached(NEW)).state).toBe('negative');

    const response = await request(`/orgs/${A}/sites`, 'POST', { name: 'Seam new', id: NEW });
    expect(response.status).toBe(201);

    expect(await owner(NEW)).toBe(A);
  });
});
