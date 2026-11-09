import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, organizations, organizationMembers, users, sites, apiKeys, auditLog, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withTenant } from '../../middleware/tenant';
import { withAuth } from '../../middleware/auth';
import { withSiteMembership } from '../../middleware/site-membership';
import { withStudioAccess } from '../../middleware/studio-access';
import { withControlPlaneAccessGuard } from '../../middleware/control-plane-access-guard';
import { orgsRouter } from '../orgs';
import { apiKeysRouter } from '../api-keys';
import { provisionSite } from '../../services/site-provisioning';
import { createPlaintextToken } from '../../services/api-key-token';
import { EffectiveCapabilityService } from '../../services/effective-capability-service';

const A = 'org_637_a', B = 'org_637_b', SA = 'site_637_a', SB = 'site_637_b';
const OWNER = 'usr_637_owner', ADMIN = 'usr_637_admin', OTHER = 'usr_637_other', DUAL = 'usr_637_dual';
const secret = 'organization-integration-test-only-secret';

describe.skipIf(!hasDbIntegrationUrl)('organization API, auth and tenant isolation (real PostgreSQL)', () => {
  let db: Database, app: Hono<AppEnv>;
  let orgToken: string, siteToken: string, ownerToken: string, adminToken: string, otherToken: string, dualToken: string;
  const created = new Set<string>();
  // JSON shape assertions below verify the concrete resource contracts.
  async function payload(response: Response): Promise<any> { return response.json(); }
  async function jwt(userId: string, audience = 'studio', tokenVersion = 0) {
    return new SignJWT({ userId, siteId: SA, tokenVersion }).setProtectedHeader({ alg: 'HS256' })
      .setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  }
  async function request(path: string, token = ownerToken, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { JWT_SECRET: secret, LUMIBASE_ALLOW_ORG_SIGNUP: 'true' } as AppEnv['Bindings']);
  }
  async function cleanup() {
    const orgIds = [A, B, ...created];
    await db.delete(sites).where(inArray(sites.organizationId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(inArray(users.id, [OWNER, ADMIN, OTHER, DUAL]));
    created.clear();
  }
  beforeAll(async () => {
    db = await connectDbIntegration('organization-api');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('db', db); c.set('runtime', { cache: new MemoryCacheProvider() } as never); await next(); });
    app.use('*', withTenant(), withAuth(), withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());
    app.route('/api/v1/orgs', orgsRouter);
    app.route('/api/v1/api-keys', apiKeysRouter);
    app.get('/api/v1/site-probe', (c) => c.json({ data: { admin: c.get('access')?.admin, via: c.get('siteAdminVia') } }));
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(organizations).values([{ id: A, slug: A, name: '637 A' }, { id: B, slug: B, name: '637 B' }]);
    await db.insert(users).values([OWNER, ADMIN, OTHER, DUAL].map((id) => ({ id, email: `${id}@example.test`, status: 'active' })));
    await db.insert(organizationMembers).values([
      { userId: OWNER, organizationId: A, role: 'owner' }, { userId: ADMIN, organizationId: A, role: 'admin' },
      { userId: OTHER, organizationId: B, role: 'owner' }, { userId: DUAL, organizationId: A, role: 'owner' },
      { userId: DUAL, organizationId: B, role: 'owner' },
    ]);
    await provisionSite(db, { id: SA, name: '637 A', organizationId: A });
    await provisionSite(db, { id: SB, name: '637 B', organizationId: B });
    const org = await createPlaintextToken({ scope: 'organization' });
    const site = await createPlaintextToken();
    await db.insert(apiKeys).values([
      { id: 'key_637_org', name: '637 org', scope: 'organization', organizationId: A, ...{ prefix: org.prefix, tokenHash: org.tokenHash } },
      { id: 'key_637_site', name: '637 site', siteId: SA, prefix: site.prefix, tokenHash: site.tokenHash },
    ]);
    orgToken = org.token; siteToken = site.token;
    [ownerToken, adminToken, otherToken, dualToken] = await Promise.all([jwt(OWNER), jwt(ADMIN), jwt(OTHER), jwt(DUAL)]);
  });
  afterAll(async () => { if (db) await cleanup(); });

  it('lists only memberships, without requiring X-Lumi-Site', async () => {
    const response = await request('/orgs');
    expect(response.status).toBe(200);
    expect((await payload(response)).data.map((o: { id: string }) => o.id)).toEqual([A]);
    expect((await payload(await request('/orgs', orgToken))).data.map((o: { id: string }) => o.id)).toEqual([A]);
    expect((await request(`/orgs/${B}`)).status).toBe(404);
    expect((await request(`/orgs/${B}`, orgToken)).status).toBe(404);
  });
  it('rejects site and publishable keys and frontend sessions on the org plane with audit', async () => {
    expect((await request('/orgs', siteToken)).status).toBe(403);
    const pub = await createPlaintextToken({ publishable: true });
    await db.insert(apiKeys).values({ name: 'pub637', siteId: SA, prefix: pub.prefix, tokenHash: pub.tokenHash });
    expect((await request('/orgs', pub.token)).status).toBe(403);
    expect((await request('/orgs', await jwt(OWNER, 'frontend'))).status).toBe(403);
    const logs = await db.select().from(auditLog).where(eq(auditLog.siteId, SA));
    expect(logs.some((l) => (l.metadata as Record<string, unknown>).reason === 'site_scoped_credential_on_org_plane')).toBe(true);
  });
  it('requires a site for lbo_ site calls and denies sites outside its org', async () => {
    expect((await request('/site-probe', orgToken)).status).toBe(400);
    expect((await request('/site-probe', orgToken, 'GET', undefined, { 'X-Lumi-Site': SB })).status).toBe(403);
    const response = await request('/site-probe', orgToken, 'GET', undefined, { 'X-Lumi-Site': SA });
    expect(response.status).toBe(200);
    expect((await payload(response)).data).toMatchObject({ admin: true, via: 'organization' });
  });
  it('inherits site admin for human org admins without user_sites, preserving frontend isolation', async () => {
    expect((await request('/site-probe', adminToken, 'GET', undefined, { 'X-Lumi-Site': SA })).status).toBe(200);
    expect((await request('/site-probe', adminToken, 'GET', undefined, { 'X-Lumi-Site': SB })).status).toBe(401);
    expect((await request('/site-probe', await jwt(ADMIN, 'frontend'), 'GET', undefined, { 'X-Lumi-Site': SA })).status).toBe(401);
  });
  it('provisions sites consistently and allows lbo_ to mint only site keys on the site endpoint', async () => {
    const response = await request(`/orgs/${A}/sites`, orgToken, 'POST', { name: 'New 637', id: 'site_637_created' });
    expect(response.status).toBe(201);
    const site = (await payload(response)).data;
    expect(site.organizationId).toBe(A);
    const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.siteId, site.id));
    expect(roleRows.map((r) => r.systemKey).sort()).toEqual(['administrator', 'member']);
    const key = await request('/api-keys', orgToken, 'POST', { name: 'site key' }, { 'X-Lumi-Site': site.id });
    expect(key.status).toBe(201);
    expect((await payload(key)).data.token).toMatch(/^lbk_/);
    const forbidden = await request('/api-keys', orgToken, 'POST', { name: 'wrong scope', scope: 'organization' }, { 'X-Lumi-Site': site.id });
    expect(forbidden.status).toBe(400);
    expect((await payload(forbidden)).errors[0].code).toBe('SCOPE_NOT_ALLOWED');
    expect((await request(`/orgs/${A}/sites/${site.id}`, orgToken, 'DELETE', undefined, { 'X-Confirm-Delete': site.id })).status).toBe(403);
  });
  it('enforces owner-only slug changes, promotion and deleting a nonempty org', async () => {
    expect((await request(`/orgs/${A}`, adminToken, 'PATCH', { slug: 'org_637_renamed' })).status).toBe(403);
    expect((await request(`/orgs/${A}`, ownerToken, 'PATCH', { name: 'Renamed' })).status).toBe(200);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, A));
    expect(org!.slug).toBe(A);
    expect((await request(`/orgs/${A}/members/${ADMIN}`, adminToken, 'PATCH', { role: 'owner' })).status).toBe(403);
    expect((await request(`/orgs/${A}`, ownerToken, 'DELETE', undefined, { 'X-Confirm-Delete': A })).status).toBe(409);
  });
  it('serializes last-owner changes across concurrent requests', async () => {
    const responses = await Promise.all([
      request(`/orgs/${A}/members/${OWNER}`, ownerToken, 'DELETE'),
      request(`/orgs/${A}/members/${DUAL}`, dualToken, 'DELETE'),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, A), eq(organizationMembers.role, 'owner')))).toHaveLength(1);
  });
  it('requires the same owner in both orgs before transfer', async () => {
    expect((await request(`/orgs/${A}/sites/${SA}/transfer`, ownerToken, 'POST', { toOrganizationId: B })).status).toBe(404);
    const response = await request(`/orgs/${A}/sites/${SA}/transfer`, dualToken, 'POST', { toOrganizationId: B });
    expect(response.status).toBe(200);
    expect((await payload(response)).data.organizationId).toBe(B);
    expect((await request('/site-probe', orgToken, 'GET', undefined, { 'X-Lumi-Site': SA })).status).toBe(403);
  });
  it('returns org plaintext keys only on creation/rotation and enforces revocation', async () => {
    const response = await request(`/orgs/${A}/keys`, ownerToken, 'POST', { name: '637 key' });
    expect(response.status).toBe(201);
    const key = (await payload(response)).data;
    expect(key.token).toMatch(/^lbo_/);
    expect(key.tokenHash).toBeUndefined();
    expect(JSON.stringify((await payload(await request(`/orgs/${A}/keys`))).data)).not.toContain(key.token);
    const rotated = await request(`/orgs/${A}/keys/${key.id}/rotate`, ownerToken, 'POST', {});
    const next = (await payload(rotated)).data;
    expect(next.token).not.toBe(key.token);
    expect((await request('/orgs', key.token)).status).toBe(401);
    expect((await request('/orgs', next.token)).status).toBe(200);
    expect((await request(`/orgs/${A}/keys/${key.id}`, ownerToken, 'DELETE')).status).toBe(200);
    expect((await request('/orgs', next.token)).status).toBe(401);
  });
  it('creates an org with an owner and re-evaluates queued organization-key capabilities', async () => {
    const response = await request('/orgs', ownerToken, 'POST', { name: '637 new', slug: 'org_637_new' });
    expect(response.status).toBe(201);
    const org = (await payload(response)).data; created.add(org.id);
    expect(org.role).toBe('owner');
    const resolver = new EffectiveCapabilityService({ db, siteId: SA });
    const grant = await resolver.resolve({ type: 'api_key', siteId: SA, apiKeyId: 'key_637_org' });
    expect(grant).toMatchObject({ allowed: true, callerClass: 'organization_api_key', controlPlaneAdmin: true });
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, 'key_637_org'));
    expect(await resolver.resolve({ type: 'api_key', siteId: SA, apiKeyId: 'key_637_org' })).toMatchObject({ allowed: false, code: 'API_KEY_REVOKED' });
  });
  it('lets only an owner rename default and frees that slug for reuse', async () => {
    const [personal] = await db.select().from(organizations).where(eq(organizations.slug, 'default'));
    expect(personal).toBeDefined();
    await db.insert(organizationMembers).values({ organizationId: personal!.id, userId: OWNER, role: 'owner' });
    let replacementId: string | undefined;
    try {
      const renamed = await request(`/orgs/${personal!.id}`, ownerToken, 'PATCH', { slug: 'org_637_default_renamed' });
      expect(renamed.status).toBe(200);
      const replacement = await request('/orgs', ownerToken, 'POST', { name: '637 replacement', slug: 'default' });
      const body = await payload(replacement);
      replacementId = body.data?.id;
      if (replacementId) created.add(replacementId);
      expect(replacement.status).toBe(201);
    } finally {
      if (replacementId) { await db.delete(organizations).where(eq(organizations.id, replacementId)); created.delete(replacementId); }
      await db.update(organizations).set({ slug: 'default' }).where(eq(organizations.id, personal!.id));
    }
  });
  it('gates signup by default and allows a bootstrap operator without the flag', async () => {
    const headers = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };
    const input = { name: '637 gated', slug: 'org_637_gated' };
    const refused = await app.request('/api/v1/orgs', { method: 'POST', headers, body: JSON.stringify(input) }, { JWT_SECRET: secret } as AppEnv['Bindings']);
    expect(refused.status).toBe(403);
    const [existing] = await db.select().from(users).where(eq(users.isBootstrap, true));
    const id = existing?.id ?? 'usr_637_operator';
    if (!existing) await db.insert(users).values({ id, email: 'operator637@example.test', status: 'active', isBootstrap: true });
    else await db.update(users).set({ status: 'active' }).where(eq(users.id, id));
    try {
      const allowed = await app.request('/api/v1/orgs', { method: 'POST', headers: { ...headers, authorization: `Bearer ${await jwt(id, 'studio', existing?.tokenVersion ?? 0)}` }, body: JSON.stringify(input) }, { JWT_SECRET: secret } as AppEnv['Bindings']);
      const body = await payload(allowed);
      if (body.data?.id) created.add(body.data.id);
      expect(allowed.status).toBe(201);
    } finally {
      if (!existing) await db.delete(users).where(eq(users.id, id));
      else await db.update(users).set({ status: existing.status }).where(eq(users.id, id));
    }
  });
  it('uses organization RLS for reads and a guarded system transaction for new-site provisioning', async () => {
    const roleName = `org637_${crypto.randomUUID().replaceAll('-', '')}`;
    const password = crypto.randomUUID();
    let appClient: ReturnType<typeof postgres> | undefined;
    try {
      const policies = readFileSync(new URL('../../../../../packages/database/migrations/rls-policies.sql', import.meta.url), 'utf8');
      await db.execute(sql.raw(policies));
      // Random test-owned identifiers are quoted; the password is generated here.
      await db.execute(sql.raw(`CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`));
      await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${roleName}"`));
      await db.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`));
      const appUrl = new URL(process.env.DATABASE_URL!);
      appUrl.username = roleName; appUrl.password = password;
      appClient = postgres(appUrl.toString(), { max: 1, prepare: false, onnotice: () => undefined });
      const appDb = drizzle(appClient, { schema }) as Database;
      expect(await appDb.select().from(organizations)).toHaveLength(0);
      const rlsApp = new Hono<AppEnv>();
      rlsApp.use('*', async (c, next) => {
        c.set('db', appDb); c.set('systemDb', db);
        c.set('runtime', { cache: new MemoryCacheProvider() } as never); await next();
      });
      rlsApp.use('*', withTenant(), withAuth(), withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());
      rlsApp.route('/api/v1/orgs', orgsRouter);
      const env = { JWT_SECRET: secret, LUMIBASE_DB_RLS: 'enforce' } as AppEnv['Bindings'];
      const headers = { authorization: `Bearer ${orgToken}`, 'content-type': 'application/json' };
      const own = await rlsApp.request(`/api/v1/orgs/${A}`, { headers }, env);
      expect(own.status).toBe(200);
      expect((await payload(own)).data.id).toBe(A);
      expect((await rlsApp.request(`/api/v1/orgs/${B}`, { headers }, env)).status).toBe(404);
      const createdSite = await rlsApp.request(`/api/v1/orgs/${A}/sites`, {
        headers, method: 'POST', body: JSON.stringify({ id: 'site_637_rls', name: 'RLS provisioned' }),
      }, env);
      expect(createdSite.status).toBe(201);
      expect((await payload(createdSite)).data.organizationId).toBe(A);
      const newRoles = await db.select().from(schema.roles).where(eq(schema.roles.siteId, 'site_637_rls'));
      expect(newRoles.map((r) => r.systemKey).sort()).toEqual(['administrator', 'member']);
      expect(await appDb.select().from(organizations)).toHaveLength(0);
    } finally {
      if (appClient) await appClient.end();
      await db.execute(sql.raw(`DROP OWNED BY "${roleName}"`));
      await db.execute(sql.raw(`DROP ROLE IF EXISTS "${roleName}"`));
    }
  });

});
