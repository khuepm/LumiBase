import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../env';
import { auditSecurityGuardDenied } from './security-audit';

const CONTROL_PLANE_PATHS = [
  '/api/v1/access',
  '/api/v1/api-keys',
  '/api/v1/admin',
  '/api/v1/agent',
  '/api/v1/cdc',
  '/api/v1/flows',
  '/api/v1/materialize',
  '/api/v1/permissions',
  '/api/v1/policies',
  '/api/v1/roles',
  '/api/v1/settings',
  '/api/v1/teams',
  '/api/v1/users',
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

export function isAdminPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return false;
  if (auth.raw?.dev === true && auth.roles?.includes('admin')) return true;
  return auth.roles?.some((role) => role === 'admin' || role === 'administrator') ?? false;
}
