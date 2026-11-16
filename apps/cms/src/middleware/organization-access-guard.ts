import { canOrg, type OrgAction, type OrgRole } from '@lumibase/contracts';
import { organizationMembers } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { organizationScopedDbFor, systemDbFor } from './db';
import { isFrontendAudience } from '../services/auth/token-audience';
import { auditSecurityGuardDenied } from './security-audit';

export async function resolveOrganizationRole(c: Context<AppEnv>, organizationId: string): Promise<OrgRole | null> {
  const auth = c.get('auth');
  if (!auth || isFrontendAudience(auth.raw?.aud)) return null;
  if (auth.apiKeyId) {
    return auth.apiKey?.scope === 'organization' && auth.apiKey.organizationId === organizationId ? 'admin' : null;
  }
  if (!auth.userId) return null;
  const [member] = await systemDbFor(c).select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, auth.userId))).limit(1);
  return member?.role ?? null;
}
export const withOrganizationAccessGuard = (action: OrgAction): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  if (!auth || isFrontendAudience(auth.raw?.aud) || (auth.apiKeyId && auth.apiKey?.scope !== 'organization')) {
    await auditSecurityGuardDenied(c, 'organization_access_denied', { reason: 'site_scoped_credential_on_org_plane', action });
    return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
  }
  const orgId = c.req.param('orgId');
  if (!orgId) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const role = await resolveOrganizationRole(c, orgId);
  if (!role) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  if (!canOrg(role, action)) {
    await auditSecurityGuardDenied(c, 'organization_access_denied', { organizationId: orgId, role, action });
    return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
  }
  c.set('organization', { id: orgId, role });
  c.set('db', organizationScopedDbFor(c, orgId));
  return next();
};
