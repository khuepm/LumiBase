import { organizationMembers, sites, type Database } from '@lumibase/database';
import type { OrgRole } from '@lumibase/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';

export function isOrganizationPath(path: string): boolean {
  return path === '/api/v1/orgs' || path.startsWith('/api/v1/orgs/');
}
/** Use a system/authorization DB when RLS is enabled. Never accept a client role. */
export async function organizationRoleForSite(db: Database, userId: string, siteId: string): Promise<OrgRole | null> {
  const [site] = await db.select({ organizationId: sites.organizationId }).from(sites)
    .where(eq(sites.id, siteId)).limit(1);
  if (typeof site?.organizationId !== 'string') return null;
  const [row] = await db.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, site.organizationId),
      eq(organizationMembers.userId, userId), inArray(organizationMembers.role, ['owner', 'admin']))).limit(1);
  return row?.role === 'owner' || row?.role === 'admin' ? row.role : null;
}

/** Project with a site-membership read on an authorization DB (explicit IDs). */
export function organizationRoleExpression(userId: string, siteId: string) {
  return sql<OrgRole | null>`(SELECT om.role FROM lumibase_organization_members om
    JOIN lumibase_sites os ON os.organization_id = om.organization_id
    WHERE os.id = ${siteId} AND om.user_id = ${userId} AND om.role IN ('owner','admin') LIMIT 1)`;
}
