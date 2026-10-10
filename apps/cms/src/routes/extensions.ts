import { ExtensionsService, ExtensionMutationError } from '../services/extensions-service';
import { extensions } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PermissionService, type PermissionAction } from '../services/permission-service';
import {
  buildSandboxVerifyOptions,
} from '../services/extension-verifier';
import { formatSafeError } from '@lumibase/contracts/utils';

export const extensionsRouter = new Hono<AppEnv>();

function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? auth.roles : [];
  if (!roles.includes('admin')) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] },
      403,
    );
  }
  return null;
}

const adminOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  return next();
};

function permissionCtx(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    userId: auth?.userId ?? null,
    siteId: c.get('siteId'),
    roleId: auth?.roleId ?? null,
    user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
    ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
}

async function requireExtensionPermission(
  c: Context<AppEnv>,
  action: PermissionAction,
): Promise<Response | null> {
  const perm = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: permissionCtx(c),
  }).canAccess('extensions', action);

  if (perm) return null;
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `Action "extensions:${action}" is not allowed.` }] },
    403,
  );
}

// Return type is inferred from Hono's own `executionCtx`, which is a narrower
// shape than the global `ExecutionContext` that @cloudflare/workers-types v5
// widened (it now requires `tracing`/`abort`). The value only ever flows back
// into `subApp.fetch()`, which expects exactly Hono's shape.
function optionalExecutionCtx(c: Context<AppEnv>) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

extensionsRouter.get('/', adminOnly, async (c) => {
  const denied = await requireExtensionPermission(c, 'read');
  if (denied) return denied;

  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db.select().from(extensions).where(eq(extensions.siteId, siteId));
  return c.json({ data });
});

function extensionService(c: Context<AppEnv>) {
  return new ExtensionsService({
    db: c.get('db'), siteId: c.get('siteId'), userId: c.get('auth')?.userId,
    permissionCtx: permissionCtx(c), cache: c.get('runtime')?.cache, env: c.env,
  });
}

extensionsRouter.post('/', adminOnly, async (c) => {
  try {
    return c.json({ data: await extensionService(c).installExtension(await c.req.json()) });
  } catch (error) {
    if (error instanceof ExtensionMutationError) return c.json({ errors: [{ code: error.code, message: error.message }] }, error.status);
    throw error;
  }
});

extensionsRouter.patch('/:id', adminOnly, async (c) => {
  try {
    return c.json({ data: await extensionService(c).updateExtension(c.req.param('id'), await c.req.json()) });
  } catch (error) {
    if (error instanceof ExtensionMutationError) return c.json({ errors: [{ code: error.code, message: error.message }] }, error.status);
    throw error;
  }
});

extensionsRouter.delete('/:id', adminOnly, async (c) => {
  try {
    await extensionService(c).uninstallExtension(c.req.param('id'));
    return c.json({ data: null });
  } catch (error) {
    if (error instanceof ExtensionMutationError) return c.json({ errors: [{ code: error.code, message: error.message }] }, error.status);
    throw error;
  }
});

/**
 * Dynamic endpoint mount — forwards requests to extension-provided Hono sub-apps.
 *
 * Extensions of type `endpoint` may export a `handler(app)` function that mounts
 * routes on a Hono instance. Those routes are served under /extensions/:name/*.
 *
 * The extension bundle is loaded lazily via ExtensionSandbox and cached.
 * If the extension does not exist, is not enabled, or has no handler, 404 is returned.
 */
extensionsRouter.all('/:name/*', adminOnly, async (c) => {
  const denied = await requireExtensionPermission(c, 'execute');
  if (denied) return denied;

  const name = c.req.param('name');
  const siteId = c.get('siteId');
  const db = c.get('db');

  // Look up the extension in DB.
  const [ext] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.name, name), eq(extensions.enabled, true)))
    .limit(1);

  if (!ext || ext.type !== 'endpoint') {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: `Extension "${name}" not found or not enabled.` }] }, 404);
  }

  // Load via sandbox.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = new ExtensionSandbox(c.env as unknown as Record<string, unknown>, db as any);
  const mod = await sandbox.load({
    name: ext.name,
    bundleUrl: ext.bundleUrl,
    capabilities: (ext.capabilities as string[]) ?? [],
    ...buildSandboxVerifyOptions(ext, db, c.env),
  });

  if (!mod?.handler) {
    return c.json({ errors: [{ code: 'NO_HANDLER', message: `Extension "${name}" does not export a handler.` }] }, 501);
  }

  // Mount the extension's sub-router on a fresh Hono instance.
  const subApp = new Hono();
  try {
    mod.handler(subApp);
  } catch (err) {
    console.error(`[extensions] handler mount failed for "${name}":`, formatSafeError(err));
    return c.json({ errors: [{ code: 'HANDLER_ERROR', message: 'Extension handler threw during mount.' }] }, 500);
  }

  // Strip the /extensions/:name prefix so the sub-app sees a clean path.
  const prefix = `/extensions/${name}`;
  const originalPath = new URL(c.req.url).pathname;
  const subPath = originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) || '/' : '/';
  const subUrl = new URL(subPath + new URL(c.req.url).search, c.req.url);

  // Do not forward the CMS environment bindings or execution context into
  // third-party extension handlers; the capability-checked ctx is the only
  // supported way to expose host resources.
  return subApp.fetch(new Request(subUrl.toString(), c.req.raw), c.env, optionalExecutionCtx(c));
});
