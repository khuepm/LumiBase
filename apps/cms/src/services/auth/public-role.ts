/**
 * Anonymous (`public`) realm provisioning.
 *
 * The third realm alongside staff and subscribers (ADR-011): callers with NO
 * credential at all. Where `subscriber` is "registered but least-privilege",
 * `public` is "not logged in" — the role an unauthenticated request resolves
 * to so its access still flows through the ordinary
 * Role → Policy → Permission chain instead of bypassing it.
 *
 * Two properties make this safe to have on the unauthenticated path:
 *
 * 1. **Opt-in per site.** The role only exists once an operator explicitly
 *    enables public access. `withAuth` treats "no public role" as "no
 *    anonymous access" and keeps returning 401, so existing deployments are
 *    unchanged until someone turns this on.
 * 2. **Structurally least-privilege.** The role can never carry
 *    `adminAccess` / `appAccess`, and only `read` permissions may be attached
 *    to its policy. Both are enforced here AND by a DB check constraint
 *    (migration `0012`), so a misconfiguration through another code path
 *    cannot widen it.
 *
 * Caching: anonymous traffic is the highest-volume path this codebase has, so
 * the role lookup is cached per site. The compiled permission bundle is cached
 * separately by `PermissionService` under a `role:{id}` principal key — every
 * anonymous visitor on a site therefore shares ONE bundle entry.
 */

import { permissions, policies, rolePolicies, roles, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';

/** Stable `system_key` for the anonymous role. Unique per site. */
export const PUBLIC_SYSTEM_KEY = 'public';

/** Stable per-site key for the policy carrying the anonymous grants. */
export const PUBLIC_POLICY_KEY = 'public';

/**
 * The only action an anonymous principal may ever be granted.
 *
 * Anonymous writes are deliberately out of scope: a spam-resistant public
 * write surface needs its own throttle/captcha story, and expressing it as a
 * generic permission grant would hand every unauthenticated caller an
 * unmetered write path. Public `create` belongs behind a purpose-built
 * endpoint, not here.
 */
export const PUBLIC_ALLOWED_ACTIONS = ['read'] as const;
export type PublicAction = (typeof PUBLIC_ALLOWED_ACTIONS)[number];

const CACHE_TTL_SECONDS = 60;

const cacheKey = (siteId: string) => `public-role:${siteId}`;

interface CachedPublicRole {
  roleId: string | null;
}

/**
 * Read the site's `public` role id, or null when public access is disabled.
 *
 * Read-only by design — this runs on the unauthenticated hot path and must
 * never write. Provisioning is an explicit admin action
 * ({@link enablePublicAccess}).
 */
export async function resolvePublicRoleId(
  db: Database,
  siteId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, PUBLIC_SYSTEM_KEY)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Cached {@link resolvePublicRoleId}. Negative results are cached too, so a
 * site with public access off does not pay a query per anonymous probe.
 *
 * Best-effort: any cache failure falls through to the direct read rather than
 * failing the request. Staleness is bounded by the 60s TTL and by the explicit
 * {@link invalidatePublicRoleCache} call the enable/disable routes make.
 */
export async function resolvePublicRoleIdCached(
  db: Database,
  siteId: string,
  cache: CacheProvider | null | undefined,
): Promise<string | null> {
  if (!cache) return resolvePublicRoleId(db, siteId);

  try {
    const cached = await cache.get<CachedPublicRole>(cacheKey(siteId));
    if (cached && typeof cached === 'object' && 'roleId' in cached) {
      return cached.roleId;
    }
  } catch {
    // Cache read failed — fall through to the authoritative read.
  }

  const roleId = await resolvePublicRoleId(db, siteId);
  try {
    await cache.set(cacheKey(siteId), JSON.stringify({ roleId }), { ttl: CACHE_TTL_SECONDS });
  } catch {
    // Non-fatal: the next request just repeats the read.
  }
  return roleId;
}

/** Drop the cached public-role pointer for a site after enable/disable. */
export async function invalidatePublicRoleCache(
  cache: CacheProvider | null | undefined,
  siteId: string,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(cacheKey(siteId));
  } catch (error) {
    console.warn('[public-role] cache invalidation failed; relying on TTL', error);
  }
}

/**
 * Enable public access: provision the `public` role + its policy and bind
 * them. Idempotent — calling it again returns the existing ids.
 *
 * The role and policy are created with every elevation flag off. They are
 * additionally pinned off by the `0012` check constraints, so this is the
 * guarantee-by-construction half of a two-layer guard.
 */
export async function enablePublicAccess(
  db: Database,
  siteId: string,
): Promise<{ roleId: string; policyId: string }> {
  const insertedRole = await db
    .insert(roles)
    .values({
      siteId,
      key: PUBLIC_SYSTEM_KEY,
      systemKey: PUBLIC_SYSTEM_KEY,
      name: 'Public',
      description:
        'Unauthenticated visitors. Never has Studio or admin access; only ' +
        'read permissions explicitly granted on this role apply.',
      icon: 'globe',
      adminAccess: false,
      appAccess: false,
    })
    // Conflict on the system-key index only. A collision on the `key` index
    // instead means an operator hand-made a role literally keyed `public`
    // with a different system_key — that surfaces as an error rather than
    // silently binding anonymous traffic to an operator-defined role that
    // could carry flags the anonymous realm must never have.
    .onConflictDoNothing({ target: [roles.siteId, roles.systemKey] })
    .returning({ id: roles.id });

  let roleId = insertedRole[0]?.id;
  if (!roleId) {
    roleId = (await resolvePublicRoleId(db, siteId)) ?? undefined;
  }
  if (!roleId) {
    throw new Error(`Failed to provision public role for site ${siteId}`);
  }

  const insertedPolicy = await db
    .insert(policies)
    .values({
      siteId,
      key: PUBLIC_POLICY_KEY,
      name: 'Public',
      description: 'Content readable by unauthenticated visitors.',
      icon: 'globe',
      adminAccess: false,
      appAccess: false,
      enforceTfa: false,
    })
    .onConflictDoNothing()
    .returning({ id: policies.id });

  let policyId = insertedPolicy[0]?.id;
  if (!policyId) {
    const [existing] = await db
      .select({ id: policies.id })
      .from(policies)
      .where(and(eq(policies.siteId, siteId), eq(policies.key, PUBLIC_POLICY_KEY)))
      .limit(1);
    policyId = existing?.id;
  }
  if (!policyId) {
    throw new Error(`Failed to provision public policy for site ${siteId}`);
  }

  await db
    .insert(rolePolicies)
    .values({ roleId, policyId, priority: 0 })
    .onConflictDoNothing();

  return { roleId, policyId };
}

/**
 * Disable public access: remove the role, its policy and every grant on it.
 *
 * Deleting the role is what actually closes the door — `withAuth` resolves
 * anonymous principals through it, so once it is gone unauthenticated
 * requests are 401 again. The policy and permission rows are removed too so a
 * later re-enable starts from a clean slate rather than silently restoring
 * grants the operator has since forgotten about.
 */
export async function disablePublicAccess(
  db: Database,
  siteId: string,
): Promise<boolean> {
  const [policy] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.siteId, siteId), eq(policies.key, PUBLIC_POLICY_KEY)))
    .limit(1);

  if (policy?.id) {
    await db
      .delete(permissions)
      .where(and(eq(permissions.siteId, siteId), eq(permissions.policyId, policy.id)));
    // role_policies rows cascade from either side.
    await db.delete(policies).where(and(eq(policies.siteId, siteId), eq(policies.id, policy.id)));
  }

  const deleted = await db
    .delete(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, PUBLIC_SYSTEM_KEY)))
    .returning({ id: roles.id });

  return deleted.length > 0 || Boolean(policy?.id);
}

/**
 * True when the role id is the site's `public` role.
 *
 * Used by the role/policy management routes to refuse edits that would give
 * the anonymous realm Studio or admin access. The DB constraint is the
 * backstop; this exists so the operator gets a readable 4xx instead of a
 * constraint violation.
 */
export async function isPublicRole(
  db: Database,
  siteId: string,
  roleId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ systemKey: roles.systemKey })
    .from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.id, roleId)))
    .limit(1);
  return row?.systemKey === PUBLIC_SYSTEM_KEY;
}

/**
 * Which elevation flags a policy would hand the anonymous realm.
 *
 * The `0012` check constraints only cover the canonical `public` role and
 * policy rows. An operator can also attach an arbitrary policy to the public
 * role, and a table-level check cannot see across the `role_policies` join —
 * so this screen runs at the attach point and returns the offending flags.
 * Empty array = safe to attach.
 */
export async function screenPolicyForPublicRole(
  db: Database,
  siteId: string,
  policyId: string,
): Promise<string[]> {
  const [policy] = await db
    .select({
      adminAccess: policies.adminAccess,
      appAccess: policies.appAccess,
      enforceTfa: policies.enforceTfa,
    })
    .from(policies)
    .where(and(eq(policies.siteId, siteId), eq(policies.id, policyId)))
    .limit(1);
  if (!policy) return [];

  const violations: string[] = [];
  if (policy.adminAccess) violations.push('adminAccess');
  if (policy.appAccess) violations.push('appAccess');
  // `enforceTfa` is not an elevation, but an anonymous principal can never
  // satisfy it — the policy would silently drop out of every bundle, which
  // reads as "the grant does not work" rather than as a misconfiguration.
  if (policy.enforceTfa) violations.push('enforceTfa');
  return violations;
}

/**
 * True when the policy is reachable by anonymous callers, i.e. bound to the
 * site's `public` role.
 *
 * Used to hold the write-action line on the generic policy-permission editor:
 * grants added there land in the same effective bundle as ones added through
 * the public-access API, so both need the same read-only screen.
 */
export async function isPolicyBoundToPublicRole(
  db: Database,
  siteId: string,
  policyId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ roleId: rolePolicies.roleId })
    .from(rolePolicies)
    .innerJoin(roles, eq(roles.id, rolePolicies.roleId))
    .where(
      and(
        eq(rolePolicies.policyId, policyId),
        eq(roles.siteId, siteId),
        eq(roles.systemKey, PUBLIC_SYSTEM_KEY),
      ),
    )
    .limit(1);
  return Boolean(row);
}
