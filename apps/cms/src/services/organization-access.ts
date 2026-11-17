import { organizationMembers, sites, type Database } from '@lumibase/database';
import type { OrgRole } from '@lumibase/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';

export function isOrganizationPath(path: string): boolean {
  return path === '/api/v1/orgs' || path.startsWith('/api/v1/orgs/');
}
/** Use a system/authorization DB when RLS is enabled. Never accept a client role. */
export async function organizationRoleForSite(db: Database, userId: string, siteId: string): Promise<OrgRole | null> {
  const [site] = await db.select({ organizationId: sites.organizationId, strict: sites.emailIdentityStrict }).from(sites)
    .where(eq(sites.id, siteId)).limit(1);
  if (typeof site?.organizationId !== 'string') return null;
  const [row] = await db.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, site.organizationId),
      eq(organizationMembers.userId, userId), inArray(organizationMembers.role, ['owner', 'admin']))).limit(1);
  const role = row?.role === 'owner' || row?.role === 'admin' ? row.role : null;
  if (role && site.strict === true && await strictSeatHeldByAlias(db, userId, siteId, site.organizationId)) return null;
  return role;
}

/**
 * Strict sites admit one account per root mailbox (#794). That rule is a
 * `user_sites` unique index, and access inherited from an organization role
 * writes no `user_sites` row — so without this check two aliases of one mailbox
 * could both reach a strict site through the organization (#861).
 *
 * The site's seat for a mailbox belongs to the alias that is a member of the
 * site; when no alias is, to the earliest-created alias holding an owner/admin
 * role in the site's organization. True when `userId` does not hold the seat
 * because another account with the same `email_root` does. An account with no
 * `email_root` (rows written before migration 0027) is never refused here,
 * matching the index, where a null key never collides.
 */
async function strictSeatHeldByAlias(db: Database, userId: string, siteId: string, organizationId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM lumibase_users me
      JOIN lumibase_users other ON other.email_root = me.email_root AND other.id <> me.id
     WHERE me.id = ${userId}
       AND me.email_root IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lumibase_user_sites mine
                        WHERE mine.site_id = ${siteId} AND mine.user_id = me.id)
       AND (EXISTS (SELECT 1 FROM lumibase_user_sites theirs
                     WHERE theirs.site_id = ${siteId} AND theirs.user_id = other.id)
            OR (EXISTS (SELECT 1 FROM lumibase_organization_members om
                         WHERE om.organization_id = ${organizationId} AND om.user_id = other.id
                           AND om.role IN ('owner','admin'))
                AND (other.created_at, other.id) < (me.created_at, me.id)))
     LIMIT 1`);
  return (rows as unknown as ArrayLike<unknown>).length > 0;
}

/** Project with a site-membership read on an authorization DB (explicit IDs). */
export function organizationRoleExpression(userId: string, siteId: string) {
  return sql<OrgRole | null>`(SELECT om.role FROM lumibase_organization_members om
    JOIN lumibase_sites os ON os.organization_id = om.organization_id
    WHERE os.id = ${siteId} AND om.user_id = ${userId} AND om.role IN ('owner','admin') LIMIT 1)`;
}

export function isMcpPath(path: string): boolean {
  return path === '/api/v1/mcp' || path === '/api/v1/mcp/';
}
