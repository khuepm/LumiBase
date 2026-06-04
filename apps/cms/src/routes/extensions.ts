import { extensions } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ExtensionSandbox } from '../extensions/sandbox';

export const extensionsRouter = new Hono<AppEnv>();

const extensionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_:-]+$/).optional(),
  name: z.string(),
  version: z.string(),
  type: z.string(),
  enabled: z.boolean().default(false),
  bundleUrl: z.string(),
  manifest: z.record(z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
});

function extensionKey(input: { key?: string | null; name: string }): string {
  return (
    input.key?.trim() ||
    input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

extensionsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db.select().from(extensions).where(eq(extensions.siteId, siteId));
  return c.json({ data });
});

extensionsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const input = extensionSchema.parse(await c.req.json());

  const [row] = await db
    .insert(extensions)
    .values({
      ...input,
      key: extensionKey(input),
      siteId,
      installedBy: auth?.userId,
    })
    .returning();

  return c.json({ data: row });
});

extensionsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = extensionSchema.partial().parse(await c.req.json());

  const [row] = await db
    .update(extensions)
    .set(input)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

extensionsRouter.delete('/:id', async (c) => {
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
extensionsRouter.all('/:name/*', async (c) => {
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
  });

  if (!mod?.handler) {
    return c.json({ errors: [{ code: 'NO_HANDLER', message: `Extension "${name}" does not export a handler.` }] }, 501);
  }

  // Mount the extension's sub-router on a fresh Hono instance.
  const subApp = new Hono();
  try {
    mod.handler(subApp);
  } catch (err) {
    console.error(`[extensions] handler mount failed for "${name}":`, err);
    return c.json({ errors: [{ code: 'HANDLER_ERROR', message: 'Extension handler threw during mount.' }] }, 500);
  }

  // Strip the /extensions/:name prefix so the sub-app sees a clean path.
  const prefix = `/extensions/${name}`;
  const originalPath = new URL(c.req.url).pathname;
  const subPath = originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) || '/' : '/';
  const subUrl = new URL(subPath + new URL(c.req.url).search, c.req.url);

  return subApp.fetch(new Request(subUrl.toString(), c.req.raw), c.env, c.executionCtx);
});
