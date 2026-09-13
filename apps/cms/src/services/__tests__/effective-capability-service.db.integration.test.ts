import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiKeyPolicies,
  apiKeys,
  permissions,
  policies,
  rolePolicies,
  roles,
  sites,
  users,
  userSites,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { and, eq, inArray } from 'drizzle-orm';
import {
  connectDbIntegration,
  hasDbIntegrationUrl,
} from '../../__tests__/helpers/db-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import {
  PermissionService,
  __resetPermissionProcessCacheForTests,
} from '../permission-service';

const SITE = 'site_g2_cap_it';
const OTHER_SITE = 'site_g2_cap_it_other';
const USER = 'user_g2_cap_it';
const ADMIN_USER = 'user_g2_cap_admin_it';
const SUSPENDED_USER = 'user_g2_cap_suspended_it';
const API_KEY = 'key_g2_cap_it';
const REVOKED_KEY = 'key_g2_cap_revoked_it';
const EXPIRED_KEY = 'key_g2_cap_expired_it';
const OTHER_KEY = 'key_g2_cap_other_it';

describe.skipIf(!hasDbIntegrationUrl)('EffectiveCapabilityService — DB integration', () => {
  let db: Database;
  let cache: MemoryCacheProvider;
  let contentPolicyId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('effective-capability-service');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER_SITE])).catch(() => undefined);
    await db
      .delete(users)
      .where(inArray(users.id, [USER, ADMIN_USER, SUSPENDED_USER]))
      .catch(() => undefined);
  });

  beforeEach(async () => {
    cache = new MemoryCacheProvider();
    __resetPermissionProcessCacheForTests();

    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER_SITE]));
    await db.delete(users).where(inArray(users.id, [USER, ADMIN_USER, SUSPENDED_USER]));

    await db.insert(sites).values([
      { id: SITE, name: 'G2 capability integration' },
      { id: OTHER_SITE, name: 'G2 capability integration other' },
    ]);

    const [editorRole, adminRole] = await db
      .insert(roles)
      .values([
        { siteId: SITE, name: 'G2 Editor', adminAccess: false, appAccess: true },
        { siteId: SITE, name: 'G2 Admin', adminAccess: true, appAccess: true },
      ])
      .returning({ id: roles.id, name: roles.name });

    contentPolicyId = (
      await db
        .insert(policies)
        .values({ siteId: SITE, name: 'G2 posts editor', adminAccess: false })
        .returning({ id: policies.id })
    )[0]!.id;

    await db.insert(permissions).values([
      {
        siteId: SITE,
        policyId: contentPolicyId,
        collection: 'posts',
        action: 'read',
        fields: ['title'],
      },
      {
        siteId: SITE,
        policyId: contentPolicyId,
        collection: 'posts',
        action: 'update',
        permissions: { status: { _eq: 'draft' } },
        fields: ['title'],
      },
      {
        siteId: SITE,
        policyId: contentPolicyId,
        collection: 'schema',
        action: 'schema:read',
        fields: ['*'],
      },
    ]);

    const editorRoleId = editorRole!.id;
    const adminRoleId = adminRole!.id;
    await db.insert(rolePolicies).values({ roleId: editorRoleId, policyId: contentPolicyId });

    await db.insert(users).values([
      { id: USER, email: 'g2-cap-user@example.test', status: 'active' },
      { id: ADMIN_USER, email: 'g2-cap-admin@example.test', status: 'active' },
      { id: SUSPENDED_USER, email: 'g2-cap-suspended@example.test', status: 'suspended' },
    ]);
    await db.insert(userSites).values([
      { userId: USER, siteId: SITE, roleId: editorRoleId },
      { userId: ADMIN_USER, siteId: SITE, roleId: adminRoleId },
      { userId: SUSPENDED_USER, siteId: SITE, roleId: editorRoleId },
    ]);

    await db.insert(apiKeys).values([
      {
        id: API_KEY,
        siteId: SITE,
        name: 'G2 minimal key',
        prefix: 'lmbg2cap',
        tokenHash: 'g2-cap-active-token-hash',
      },
      {
        id: REVOKED_KEY,
        siteId: SITE,
        name: 'G2 revoked key',
        prefix: 'lmbg2rev',
        tokenHash: 'g2-cap-revoked-token-hash',
        revokedAt: new Date('2026-09-13T00:00:00.000Z'),
      },
      {
        id: EXPIRED_KEY,
        siteId: SITE,
        name: 'G2 expired key',
        prefix: 'lmbg2exp',
        tokenHash: 'g2-cap-expired-token-hash',
        expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      },
      {
        id: OTHER_KEY,
        siteId: OTHER_SITE,
        name: 'G2 other-site key',
        prefix: 'lmbg2oth',
        tokenHash: 'g2-cap-other-token-hash',
      },
    ]);
    await db.insert(apiKeyPolicies).values({
      apiKeyId: API_KEY,
      siteId: SITE,
      policyId: contentPolicyId,
      priority: 0,
    });
  });

  function service(siteId = SITE): EffectiveCapabilityService {
    return new EffectiveCapabilityService({
      db,
      siteId,
      cache,
      ip: '203.0.113.10',
      headers: {},
      now: () => new Date('2026-09-14T00:00:00.000Z'),
    });
  }

  it('resolves the same minimal content/schema capabilities for a user and API key', async () => {
    const user = await service().resolve({ type: 'user', siteId: SITE, userId: USER });
    const apiKey = await service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: API_KEY });

    expect(user).toMatchObject({
      allowed: true,
      capabilities: ['items:read', 'items:update', 'items:write', 'schema:read'],
      controlPlaneAdmin: false,
    });
    expect(apiKey).toMatchObject({
      allowed: true,
      capabilities: ['items:read', 'items:update', 'items:write', 'schema:read'],
      controlPlaneAdmin: false,
    });

    if (!user.allowed || !apiKey.allowed) throw new Error('expected grants');
    expect(user.bundle.byKey['posts::read']?.fields).toEqual(['title']);
    expect(apiKey.bundle.byKey['posts::update']?.rule).toEqual({ status: { _eq: 'draft' } });
    expect(apiKey.capabilities).not.toContain('*');
    expect(apiKey.capabilities).not.toContain('admin');
  });

  it('honours the human admin backstop without minting wildcard capabilities', async () => {
    const admin = await service().resolve({
      type: 'user',
      siteId: SITE,
      userId: ADMIN_USER,
    });

    expect(admin).toMatchObject({
      allowed: true,
      capabilities: ['admin'],
      controlPlaneAdmin: true,
    });
    if (!admin.allowed) throw new Error('expected admin grant');
    expect(admin.capabilities).not.toContain('*');
  });

  it('fails closed for suspended users, revoked/expired keys and wrong-tenant keys', async () => {
    await expect(
      service().resolve({ type: 'user', siteId: SITE, userId: SUSPENDED_USER }),
    ).resolves.toMatchObject({ allowed: false, code: 'PRINCIPAL_INACTIVE', capabilities: [] });
    await expect(
      service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: REVOKED_KEY }),
    ).resolves.toMatchObject({ allowed: false, code: 'API_KEY_REVOKED', capabilities: [] });
    await expect(
      service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: EXPIRED_KEY }),
    ).resolves.toMatchObject({ allowed: false, code: 'API_KEY_EXPIRED', capabilities: [] });
    await expect(
      service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: OTHER_KEY }),
    ).resolves.toMatchObject({ allowed: false, code: 'PRINCIPAL_NOT_FOUND', capabilities: [] });
  });

  it('re-resolves a permission change instead of preserving a stale capability snapshot', async () => {
    const before = await service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: API_KEY });
    expect(before).toMatchObject({ allowed: true, capabilities: expect.arrayContaining(['items:write']) });

    await db
      .delete(apiKeyPolicies)
      .where(and(eq(apiKeyPolicies.apiKeyId, API_KEY), eq(apiKeyPolicies.siteId, SITE)));
    await PermissionService.bumpVersion(cache, SITE);

    const after = await service().resolve({ type: 'api_key', siteId: SITE, apiKeyId: API_KEY });
    expect(after).toMatchObject({ allowed: true, capabilities: [] });
  });
});
