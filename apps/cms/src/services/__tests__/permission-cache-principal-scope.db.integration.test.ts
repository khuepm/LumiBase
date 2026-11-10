import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  sites,
  userPolicies,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { PermissionService, __resetPermissionProcessCacheForTests } from '../permission-service';
import type { MagicContext } from '../permission-dsl';

/**
 * Permission bundle cache: principal scope and request-bound policies (#583).
 *
 * ## What was wrong (measured at 5a92d6ea, before the fix)
 *
 * F1. The bundle cache key was `perm:{site}:v{n}:role:{roleId}` whenever the
 * context carried a role, even when it also carried a user.
 * `EffectiveCapabilityService.resolveUser` passes both (user + membership
 * role), so every governed AI path (Copilot tool calls, MCP, Agent API, the
 * agent-runs worker, approvals, Flows `ai:decision`) cached one member's bundle
 * under the role and served it to the next member of that role for up to 60 s.
 * A policy granted to one user directly (here: admin access) became the other
 * member's. A share link (`ctx.roleId` only) read the same key.
 *
 * F2. Policies with an IP allow/deny list or a validity window were filtered
 * against the first request's ip/clock, and the result was cached under a key
 * without the ip, so a request from a denied address was granted the policy
 * for up to 60 s.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL, a REAL shared `MemoryCacheProvider` (the same SWR + process
 * cache path production uses), REAL `ItemService` for the data assertions. No
 * network, no LLM. Every case runs well inside the 60 s entry TTL and the 5 s
 * process TTL, so a pass cannot come from expiry.
 */
const SITE_A = 'site_583_cache_a';
const SITE_B = 'site_583_cache_b';
const ROLE_A = 'role_583_editor_a';
const ROLE_B = 'role_583_editor_b';
const ALICE = 'usr_583_alice';
const BOB = 'usr_583_bob';
const ALLOWED_IP = '10.58.3.1';
const DENIED_IP = '10.58.3.2';

describe.skipIf(!hasDbIntegrationUrl)('#583 permission cache principal scope — DB integration', () => {
  let db: Database;
  let cache: MemoryCacheProvider;

  beforeAll(async () => {
    db = await connectDbIntegration('permission-cache-principal-scope');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B])).catch(() => undefined);
    await db.delete(users).where(inArray(users.id, [ALICE, BOB])).catch(() => undefined);
  });

  async function policy(siteId: string, name: string, extra: Partial<typeof policies.$inferInsert> = {}) {
    const [row] = await db
      .insert(policies)
      .values({ siteId, name, adminAccess: false, appAccess: false, ...extra })
      .returning({ id: policies.id });
    return row!.id;
  }

  async function collection(siteId: string, name: string) {
    const [row] = await db.insert(collections).values({ siteId, name, label: name }).returning();
    await db.insert(fields).values({ siteId, collectionId: row!.id, name: 'title', type: 'string', interface: 'input' });
    await db.insert(items).values({ siteId, collectionId: row!.id, status: 'draft', data: { title: `${name} row` } });
  }

  beforeEach(async () => {
    // Shared across both principals of a case, as in a production isolate.
    cache = new MemoryCacheProvider();
    __resetPermissionProcessCacheForTests();
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
    await db.insert(sites).values([
      { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE_A, name: '583 A' },
      { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE_B, name: '583 B' },
    ]);
    await db.insert(users).values([
      { id: ALICE, email: 'audit-583-alice@example.dev' },
      { id: BOB, email: 'audit-583-bob@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: ROLE_A, siteId: SITE_A, name: '583 Editor', adminAccess: false, appAccess: true },
      { id: ROLE_B, siteId: SITE_B, name: '583 Editor B', adminAccess: false, appAccess: true },
    ]);
    // Both are members of the same role; Alice also lives in site B.
    await db.insert(userSites).values([
      { userId: ALICE, siteId: SITE_A, roleId: ROLE_A },
      { userId: BOB, siteId: SITE_A, roleId: ROLE_A },
      { userId: ALICE, siteId: SITE_B, roleId: ROLE_B },
    ]);
    await collection(SITE_A, 'posts');
    await collection(SITE_A, 'secret');
    await collection(SITE_B, 'secret');
    // The role reads posts only.
    const reader = await policy(SITE_A, '583 posts reader');
    await db.insert(permissionsTable).values({ siteId: SITE_A, policyId: reader, collection: 'posts', action: 'read', fields: ['*'] });
    await db.insert(rolePolicies).values({ roleId: ROLE_A, policyId: reader, priority: 0 });
    // Alice alone is granted admin access in site A, directly.
    const aliceAdmin = await policy(SITE_A, '583 alice admin', { adminAccess: true });
    await db.insert(userPolicies).values({ userId: ALICE, siteId: SITE_A, policyId: aliceAdmin, priority: 0 });
  });

  const resolver = (siteId: string, ip: string | null = null) =>
    new EffectiveCapabilityService({ db, siteId, cache, ip, environment: 'production' });

  async function grantOf(userId: string, siteId = SITE_A, ip: string | null = null) {
    const grant = await resolver(siteId, ip).resolve({ type: 'user', siteId, userId });
    expect(grant.allowed, `${userId} must resolve`).toBe(true);
    return grant as Extract<typeof grant, { allowed: true }>;
  }

  async function secretRows(userId: string, siteId = SITE_A, ip: string | null = null) {
    const grant = await grantOf(userId, siteId, ip);
    const service = itemServiceForPrincipal({ db, siteId, userId, cache }, grant.permissionContext!);
    return service.list('secret', {}).then(
      (result) => result.data.length,
      (error: unknown) => (error as { code?: string }).code ?? 'ERROR',
    );
  }

  // ── F1: principal scope ─────────────────────────────────────────────────

  it('a member of the same role does not inherit a policy granted to another member (F1)', async () => {
    const alice = await grantOf(ALICE);
    expect(alice.controlPlaneAdmin).toBe(true);

    const bob = await grantOf(BOB);
    expect(bob.controlPlaneAdmin).toBe(false);
    expect(bob.bundle.admin).toBe(false);
    expect(Object.keys(bob.bundle.byKey)).toEqual(['posts::read']);
  });

  it('the AI item path of the other member cannot read a collection outside its grant (F1)', async () => {
    expect(await secretRows(ALICE)).toBe(1);
    expect(await secretRows(BOB)).toBe('FORBIDDEN');
  });

  it('a narrower member resolved first does not narrow the other member (F1)', async () => {
    expect((await grantOf(BOB)).controlPlaneAdmin).toBe(false);
    expect((await grantOf(ALICE)).controlPlaneAdmin).toBe(true);
  });

  it('a role-only context (share link, public role) does not read a member bundle (F1)', async () => {
    await grantOf(ALICE);
    // The context ShareService builds for a link that grants ROLE_A.
    const shareCtx: MagicContext = { siteId: SITE_A, roleId: ROLE_A, userId: null, user: null, ip: null, headers: {}, apiKey: null };
    const bundle = await new PermissionService({ db, cache, ctx: shareCtx }).bundle();
    expect(bundle.admin).toBe(false);
    expect(Object.keys(bundle.byKey)).toEqual(['posts::read']);
  });

  it('the same user in another site gets that site bundle (two-site isolation)', async () => {
    expect((await grantOf(ALICE, SITE_A)).controlPlaneAdmin).toBe(true);
    const inB = await grantOf(ALICE, SITE_B);
    expect(inB.controlPlaneAdmin).toBe(false);
    expect(await secretRows(ALICE, SITE_B)).toBe('FORBIDDEN');
  });

  // ── F2: request-bound policies ──────────────────────────────────────────

  async function ipLockedSecretForBob() {
    const locked = await policy(SITE_A, '583 bob secret from office', { ipAllow: [ALLOWED_IP] });
    await db.insert(permissionsTable).values({ siteId: SITE_A, policyId: locked, collection: 'secret', action: 'read', fields: ['*'] });
    await db.insert(userPolicies).values({ userId: BOB, siteId: SITE_A, policyId: locked, priority: 1 });
  }

  it('an IP-locked policy granted from the allowed address is not served to another address (F2)', async () => {
    await ipLockedSecretForBob();
    expect(await secretRows(BOB, SITE_A, ALLOWED_IP)).toBe(1);
    expect(await secretRows(BOB, SITE_A, DENIED_IP)).toBe('FORBIDDEN');
    expect(await secretRows(BOB, SITE_A, ALLOWED_IP)).toBe(1);
  });

  it('a request from the denied address first does not deny the allowed address (F2)', async () => {
    await ipLockedSecretForBob();
    expect(await secretRows(BOB, SITE_A, DENIED_IP)).toBe('FORBIDDEN');
    expect(await secretRows(BOB, SITE_A, ALLOWED_IP)).toBe(1);
  });

  it('a validity window is evaluated at each request clock (F2)', async () => {
    const until = new Date(Date.now() + 60 * 60_000);
    const windowed = await policy(SITE_A, '583 bob secret until', { validUntil: until });
    await db.insert(permissionsTable).values({ siteId: SITE_A, policyId: windowed, collection: 'secret', action: 'read', fields: ['*'] });
    await db.insert(userPolicies).values({ userId: BOB, siteId: SITE_A, policyId: windowed, priority: 1 });
    const at = (now: Date) =>
      new EffectiveCapabilityService({ db, siteId: SITE_A, cache, environment: 'production', now: () => now })
        .resolve({ type: 'user', siteId: SITE_A, userId: BOB });
    const before = await at(new Date());
    expect(before.allowed && Object.keys(before.bundle.byKey).sort()).toEqual(['posts::read', 'secret::read']);
    const after = await at(new Date(until.getTime() + 1_000));
    expect(after.allowed && Object.keys(after.bundle.byKey)).toEqual(['posts::read']);
  });

  it('the cache-only marker never reaches a caller', async () => {
    await ipLockedSecretForBob();
    const grant = await grantOf(BOB, SITE_A, ALLOWED_IP);
    expect('contextBound' in grant.bundle).toBe(false);
    const again = await grantOf(BOB, SITE_A, ALLOWED_IP);
    expect('contextBound' in again.bundle).toBe(false);
  });

  it('an unguarded principal is still served from the cache', async () => {
    await grantOf(BOB);
    const keys = [...(cache as unknown as { store: Map<string, unknown> }).store.keys()];
    expect(keys).toContain(`perm:${SITE_A}:v1:user:${BOB}|role:${ROLE_A}`);
  });

  it('concurrent resolutions of two members each get their own bundle', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => grantOf(i % 2 === 0 ? ALICE : BOB)),
    );
    expect(results.map((r) => r.controlPlaneAdmin)).toEqual([true, false, true, false, true, false, true, false]);
  });

  it('a deleted tenant is denied even while its bundle is still cached', async () => {
    expect((await grantOf(ALICE, SITE_B)).allowed).toBe(true);
    await db.delete(sites).where(eq(sites.id, SITE_B));
    const after = await resolver(SITE_B).resolve({ type: 'user', siteId: SITE_B, userId: ALICE });
    expect(after.allowed).toBe(false);
    expect(after.allowed === false && after.code).toBe('PRINCIPAL_NOT_MEMBER');
  });

  it('removing the user grant takes effect on the next resolution (no stale admin)', async () => {
    expect((await grantOf(ALICE)).controlPlaneAdmin).toBe(true);
    await db.delete(userPolicies).where(eq(userPolicies.userId, ALICE));
    await PermissionService.bumpVersion(cache, SITE_A);
    expect((await grantOf(ALICE)).controlPlaneAdmin).toBe(false);
  });
});
