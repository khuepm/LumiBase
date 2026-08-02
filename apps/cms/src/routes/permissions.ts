import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import type { MagicContext } from '../services/permission-dsl';

/**
 * /permissions — runtime introspection.
 *
 *   GET  /permissions/me            → compiled bundle for the active user.
 *   POST /permissions/check         → evaluate (collection, action, item) and
 *                                     return `{ allowed, reason, fields }` so
 *                                     the Studio can preview the verdict.
 */

export const permissionsRouter = new Hono<AppEnv>();

const buildContext = (c: Context<AppEnv>): MagicContext => {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    userId: auth?.userId ?? null,
    siteId: c.get('siteId'),
    roleId: auth?.roleId ?? null,
    user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
    ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
};

permissionsRouter.get('/me', async (c) => {
  const resolved = c.get('access');
  if (resolved) return c.json({ data: resolved });

  const service = new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: buildContext(c),
  });
  const bundle = await service.bundle();
  return c.json({ data: bundle });
});

const checkSchema = z.object({
  collection: z.string(),
  action: z.enum(['create', 'read', 'update', 'delete', 'share']),
  item: z.record(z.string(), z.unknown()).optional(),
});

permissionsRouter.post('/check', async (c) => {
  const parsed = checkSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const service = new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: buildContext(c),
  });
  const perm = await service.canAccess(parsed.data.collection, parsed.data.action);
  if (!perm) {
    return c.json({ data: { allowed: false, reason: 'NO_PERMISSION', fields: [] } });
  }
  if (parsed.data.item) {
    const ok = service.matches(perm, parsed.data.item);
    return c.json({
      data: {
        allowed: ok,
        reason: ok ? null : 'RULE_MISMATCH',
        fields: perm.fields,
        rule: perm.rule,
        presets: perm.presets,
      },
    });
  }
  return c.json({
    data: { allowed: true, reason: null, fields: perm.fields, rule: perm.rule, presets: perm.presets },
  });
});
