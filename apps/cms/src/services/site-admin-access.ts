import { AuditLogger } from '../modules/audit/logger';
import { getRequestContext } from '../middleware/request-context';
import type { Context } from 'hono';
import { roles, sites } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { systemDbFor } from '../middleware/db';
import { isFrontendAudience } from './auth/token-audience';
import { organizationRoleForSite } from './organization-access';
import { PermissionService } from './permission-service';

/** Resolve the site administrator role only after organization ownership proof. */
export async function inheritedAdministratorRole(c: Context<AppEnv>): Promise<string | null> {
  try {
    const auth = c.get('auth');
    const siteId = c.get('siteId');
    if (!auth || !siteId || isFrontendAudience(auth.raw?.aud) || auth.type === 'anonymous') return null;
    if (!auth.apiKeyId && !auth.userId) return null;
    if (c.get('siteAdminVia') === 'organization' && auth.roleId) return auth.roleId;
    const db = systemDbFor(c);
    let inherited = c.get('siteAdminVia') === 'organization';
    if (auth.apiKeyId) {
      if (auth.apiKey?.scope !== 'organization' || typeof auth.apiKey.organizationId !== 'string') return null;
      const [site] = await db.select({ organizationId: sites.organizationId }).from(sites)
        .where(eq(sites.id, siteId)).limit(1);
      inherited = site?.organizationId === auth.apiKey.organizationId;
    } else if (!inherited && auth.userId) {
      const known = getRequestContext(c).organizationRole;
      inherited = known !== undefined ? known === 'owner' || known === 'admin' : Boolean(await organizationRoleForSite(db, auth.userId, siteId));
    }
    if (!inherited) return null;
    const [role] = await db.select({ id: roles.id }).from(roles)
      .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, 'administrator'))).limit(1);
    if (!role) return null;
    c.set('siteAdminVia', 'organization');
    c.set('auth', { ...auth, roleId: role.id });
    if (!c.get('organizationAccessAudited')) {
      c.set('organizationAccessAudited', true);
      await new AuditLogger({ db, siteId }).write({
        event: 'organization_site_access', actorEmail: auth.email ?? null, requestId: c.get('requestId') ?? null,
        metadata: { via: 'organization', siteId, userId: auth.userId ?? null, apiKeyId: auth.apiKeyId ?? null },
      });
    }
    return role.id;
  } catch { return null; }
}

export async function resolveSiteAdminAccess(c: Context<AppEnv>): Promise<{
  allowed: boolean; via: 'role' | 'bootstrap' | 'organization' | null;
}> {
  try {
    const auth = c.get('auth');
    if (auth?.apiKeyId && auth.apiKey?.scope !== 'organization') return { allowed: false, via: null };
    if (!auth || !c.get('siteId') || auth.type === 'anonymous' || isFrontendAudience(auth.raw?.aud)) return { allowed: false, via: null };
    if (auth.raw?.dev === true && auth.roles?.includes('admin')) return { allowed: true, via: 'bootstrap' };
    if (c.get('access')?.admin && auth.apiKey?.scope !== 'organization') return { allowed: true, via: auth.raw?.isBootstrap ? 'bootstrap' : 'role' };
    const inheritedRole = await inheritedAdministratorRole(c);
    const current = c.get('auth');
    const bundle = c.get('access') ?? await new PermissionService({
      db: c.get('db'), cache: c.get('runtime')?.cache,
      ctx: { siteId: c.get('siteId'), userId: current.userId ?? null,
        roleId: inheritedRole ?? current.roleId ?? null, apiKey: current.apiKey ?? null,
        user: current.userId ? { id: current.userId, ...(current.raw ?? {}) } : null,
        ip: c.get('ip') ?? null, headers: Object.fromEntries(c.req.raw.headers),
      },
    }).bundle();
    const allowed = bundle.admin || Boolean(inheritedRole);
    const via = allowed ? inheritedRole ? 'organization' : auth.raw?.isBootstrap ? 'bootstrap' : 'role' : null;
    c.set('siteAdminVia', via);
    return { allowed, via };
  } catch { return { allowed: false, via: null }; }
}
