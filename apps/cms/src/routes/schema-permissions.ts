import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService, type PermissionAction } from '../services/permission-service';

export type SchemaPermissionAction =
  | 'schema:read'
  | 'schema:create'
  | 'schema:update'
  | 'schema:delete'
  | 'schema:migrate';

export function permissionCtx(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    userId: auth?.userId ?? null,
    siteId: c.get('siteId'),
    roleId: null,
    user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
    ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
}

export async function requireSchemaPermission(
  c: Context<AppEnv>,
  action: SchemaPermissionAction,
): Promise<Response | null> {
  const perm = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: permissionCtx(c),
  }).canAccess('schema', action as PermissionAction);

  if (perm) return null;
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `Action "schema:${action.replace('schema:', '')}" is not allowed.` }] },
    403,
  );
}
