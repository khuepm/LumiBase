import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../env';
import { isFrontendAudience } from '../services/auth/token-audience';
import type { PermissionBundle } from '../services/permission-service';
import { auditSecurityGuardDenied } from './security-audit';

const CONTROL_PLANE_PATHS = [
  '/api/v1/access',
  '/api/v1/api-keys',
  '/api/v1/admin',
  '/api/v1/agent',
  '/api/v1/cdc',
  '/api/v1/flows',
  // Git integration: manage repo connections, OAuth, and GitOps sync (creates
  // agent goals) — admin-only. The PUBLIC webhook + OAuth-callback routes are
  // mounted on the top-level app BEFORE the `api` sub-app, so they never reach
  // this guard; only the authenticated management surface is gated here.
  '/api/v1/integrations/git',
  '/api/v1/materialize',
  '/api/v1/permissions',
  '/api/v1/policies',
  '/api/v1/roles',
  '/api/v1/settings',
  '/api/v1/teams',
  '/api/v1/users',
  '/api/v1/utils/cache',
] as const;

/**
 * Guard system administration and access-management routes. Generated feature
 * code can add new app surfaces later, but control-plane APIs remain behind an
 * admin principal even if a route forgets to perform its own role check.
 */
export const withControlPlaneAccessGuard = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!isControlPlanePath(c.req.path)) return next();

  const auth = c.get('auth');
  if (isAdminPrincipal(auth)) return next();
  if (hasSiteAdminAccess(auth, c.get('access'))) return next();
  if (auth && isSelfIntrospection(c.req.method, c.req.path)) return next();

  await auditSecurityGuardDenied(c, 'control_plane_access_denied', {
    path: c.req.path,
    method: c.req.method,
    reason: 'non_admin_control_plane_route',
    roles: auth?.roles ?? [],
    principalType: auth?.type ?? 'user',
  });

  return c.json(
    {
      errors: [
        {
          code: 'CONTROL_PLANE_FORBIDDEN',
          message: 'System administration endpoints require an admin principal.',
        },
      ],
    },
    403,
  );
};

export function isControlPlanePath(path: string): boolean {
  return CONTROL_PLANE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * `GET /permissions/me` returns the caller's OWN compiled permission bundle —
 * reading it grants nothing. It sits under the control-plane `/permissions`
 * prefix only by URL, and Studio needs it for every signed-in user to decide
 * what to render. Behind the admin backstop every non-bootstrap user got 403,
 * and Studio showed "You do not have read permission" on collections their
 * role could read (RC.3 acceptance, B100). Everything else under
 * `/permissions` (e.g. `POST /check`) stays admin-only.
 */
export function isSelfIntrospection(method: string, path: string): boolean {
  return method === 'GET' && (path === '/api/v1/permissions/me' || path === '/api/v1/permissions/me/');
}

/**
 * A signed-in USER whose role grants admin access in the active site.
 *
 * `isAdminPrincipal` matches role *names*, but an invited user carries its
 * role *id* (`roles: ['<nanoid>']`), so a user holding the Administrator role
 * was refused by every control-plane route while the inner `requireSiteAdmin`
 * — which reads the same permission bundle — would have admitted it (B101).
 * The bundle is the one `withSiteMembership` resolved for this site before the
 * guard runs; nothing is resolved here.
 *
 * Deliberately narrow: API keys, anonymous principals and `frontend`-audience
 * (subscriber) sessions never qualify, whatever their role says. Widening
 * control-plane access for API keys is a separate decision (#472).
 */
export function hasSiteAdminAccess(
  auth: AuthPrincipal | undefined,
  access: PermissionBundle | undefined,
): boolean {
  if (!auth?.userId || auth.apiKeyId || auth.type === 'anonymous') return false;
  if (isFrontendAudience(auth.raw?.aud)) return false;
  return access?.admin === true;
}

export function isAdminPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return false;
  if (auth.raw?.dev === true && auth.roles?.includes('admin')) return true;
  return auth.roles?.some((role) => role === 'admin' || role === 'administrator') ?? false;
}
