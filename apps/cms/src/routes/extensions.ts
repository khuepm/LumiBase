import { extensions } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PermissionService, type PermissionAction } from '../services/permission-service';
import {
  ExtensionVerifierService,
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

/**
 * Allowed extension slot types. Constrained to an enum so an arbitrary `type`
 * string can never reach the loader's dynamic-mount path.
 */
const EXTENSION_TYPES = [
  'interface', 'display', 'layout', 'panel', 'module',
  'hook', 'endpoint',
] as const;

/**
 * Shallow protocol gate for `bundleUrl` at the API boundary. The runtime
 * `validateExtensionBundleUrl` + `EXTENSION_BUNDLE_ORIGINS` allowlist remain the
 * authoritative SSRF/trust check at load time; this just rejects obviously
 * dangerous schemes (javascript:, vbscript:, file:, blob:) before they are ever
 * persisted. `data:text/javascript` stays permitted to match the loader.
 */
const bundleUrlSchema = z
  .string()
  .min(1)
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol === 'https:' || url.protocol === 'http:') return true;
      if (url.protocol === 'data:') return url.pathname.startsWith('text/javascript');
      return false;
    },
    { message: 'bundleUrl must be an https:, http:, or data:text/javascript URL.' },
  );

const extensionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_:-]+$/).optional(),
  name: z.string(),
  version: z.string(),
  type: z.enum(EXTENSION_TYPES),
  enabled: z.boolean().default(false),
  bundleUrl: bundleUrlSchema,
  manifest: z.record(z.string(), z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
});

function extensionKey(input: { key?: string | null; name: string }): string {
  return (
    input.key?.trim() ||
    input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

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

function createActions(input: z.infer<typeof extensionSchema>): PermissionAction[] {
  const actions = new Set<PermissionAction>(['install']);
  if (input.enabled) actions.add('enable');
  if (input.capabilities.length > 0) actions.add('grant_capability');
  return [...actions];
}

function patchActions(input: Partial<z.infer<typeof extensionSchema>>): PermissionAction[] {
  const actions = new Set<PermissionAction>();
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) actions.add('enable');
  if (Object.prototype.hasOwnProperty.call(input, 'capabilities')) actions.add('grant_capability');
  if (
    ['key', 'name', 'version', 'type', 'bundleUrl', 'manifest'].some((field) =>
      Object.prototype.hasOwnProperty.call(input, field),
    )
  ) {
    actions.add('configure');
  }
  if (!actions.size) actions.add('configure');
  return [...actions];
}

function optionalExecutionCtx(c: Context<AppEnv>): ExecutionContext | undefined {
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

extensionsRouter.post('/', adminOnly, async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const input = extensionSchema.parse(await c.req.json());

  for (const action of createActions(input)) {
    const denied = await requireExtensionPermission(c, action);
    if (denied) return denied;
  }

  // Verify the bundle signature and DERIVE the official flag server-side — the
  // request body cannot self-assert official status. `lumibase-*` must be
  // signed by an official key; third-party follows the site signature policy.
  const verifier = new ExtensionVerifierService(db, c.env);
  const verdict = await verifier.verifyByMetadata(input.name, {
    bundleUrl: input.bundleUrl,
    bundleSha256: null,
    signature: null,
    publisherKeyId: null,
    signatureAlg: null,
  });
  const isReserved = ExtensionVerifierService.isReservedName(input.name);
  const requireSignature =
    isReserved || (c.env.LUMIBASE_EXT_SIGNATURE_POLICY ?? 'require') !== 'warn';

  if (isReserved && !verdict.isOfficial) {
    return c.json(
      { errors: [{ code: 'RESERVED_NAMESPACE', message: 'lumibase-* requires an official signature.' }] },
      400,
    );
  }
  if (requireSignature && !verdict.ok) {
    return c.json(
      { errors: [{ code: 'SIGNATURE_REQUIRED', message: `Signature check failed: ${verdict.reason}` }] },
      400,
    );
  }

  const [row] = await db
    .insert(extensions)
    .values({
      ...input,
      key: extensionKey(input),
      siteId,
      installedBy: auth?.userId,
      isOfficial: verdict.isOfficial,
      verifiedAt: verdict.ok ? new Date() : null,
    })
    .returning();

  return c.json({ data: row });
});

extensionsRouter.patch('/:id', adminOnly, async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = extensionSchema.partial().parse(await c.req.json());
  for (const action of patchActions(input)) {
    const denied = await requireExtensionPermission(c, action);
    if (denied) return denied;
  }

  const [current] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.id, id)))
    .limit(1);
  if (!current) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);

  // Enabling an official extension whose signature does not currently verify is
  // refused (fail-closed). `verifiedAt` is the persisted proof of a prior check.
  const willEnable = input.enabled === true;
  if (willEnable && current.isOfficial && !current.verifiedAt) {
    return c.json(
      { errors: [{ code: 'SIGNATURE_REQUIRED', message: 'Cannot enable an unverified official extension.' }] },
      400,
    );
  }

  const [row] = await db
    .update(extensions)
    .set(input)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);

  // A bundle/version change invalidates the cached module and any prior
  // verification — evict the sandbox cache so the next load re-verifies.
  if (input.bundleUrl !== undefined || input.version !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new ExtensionSandbox(c.env as unknown as Record<string, unknown>).evict(row.name);
  }

  // Change Feed (Req 3.4): enabling a hook extension with cdc:subscribe:*
  // capabilities upserts its `ext:<name>` subscription; disabling pauses it.
  // Best-effort — a sync failure must not fail the admin's enable/disable.
  try {
    const { syncExtensionCdcSubscription } = await import(
      '../modules/cdc/change-feed/extension-sender'
    );
    await syncExtensionCdcSubscription(
      db,
      siteId,
      {
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        capabilities: (row.capabilities as string[]) ?? [],
      },
      c.get('runtime')?.cache,
    );
  } catch (err) {
    console.error('[extensions] cdc subscription sync failed:', err instanceof Error ? err.message : err);
  }
  return c.json({ data: row });
});

extensionsRouter.delete('/:id', adminOnly, async (c) => {
  const denied = await requireExtensionPermission(c, 'delete');
  if (denied) return denied;

  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(extensions)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
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
