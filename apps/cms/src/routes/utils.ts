import { settings } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import { renderTemplate } from '../services/template';
import { dispatchRevalidation, parseTargets } from '../services/revalidation';

export const utilsRouter = new Hono<AppEnv>();

/** Authenticated cache purge surface — mounted on the `api` sub-app. */
export const cacheUtilsRouter = new Hono<AppEnv>();

utilsRouter.get('/health', (c) =>
  c.json({ status: 'ok', env: c.env.LUMIBASE_ENV, ts: new Date().toISOString() }),
);

utilsRouter.get('/version', (c) =>
  c.json({
    name: 'lumibase-cms',
    version: '0.1.0',
    apiVersion: 1,
    env: c.env.LUMIBASE_ENV,
  }),
);

const renderTemplateSchema = z.object({
  template: z.string(),
  data: z.record(z.string(), z.unknown()),
});

utilsRouter.post('/render-template', async (c) => {
  const parsed = renderTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  return c.json({ data: { rendered: renderTemplate(parsed.data.template, parsed.data.data) } });
});

// ---------------------------------------------------------------------------
// POST /api/v1/utils/revalidate
// Tag-based cache invalidation for Next.js ISR (or any ISR-capable frontend).
// Requires auth (withTenant + withAuth applied at api-router level).
// Body: { tags: string[] }
// Reads revalidation targets from settings key `revalidation.targets`.
// ---------------------------------------------------------------------------
const revalidateSchema = z.object({
  tags: z.array(z.string().min(1)).min(1),
});

utilsRouter.post('/revalidate', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const parsed = revalidateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  // Load revalidation targets from site settings.
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'revalidation.targets')));

  const targets = parseTargets(row?.value);
  if (targets.length === 0) {
    return c.json({ data: { dispatched: 0, results: [] } });
  }

  const results = await dispatchRevalidation(targets, parsed.data.tags);
  const successCount = results.filter((r) => r.ok).length;

  return c.json({
    data: {
      dispatched: results.length,
      succeeded: successCount,
      failed: results.length - successCount,
      results,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/utils/cache/purge
// Admin-only tag/key purge for the current tenant (ADR-004; design §4.4).
// Mounted on the authenticated `api` sub-app so control-plane guard applies.
// ---------------------------------------------------------------------------

const purgeSchema = z
  .object({
    tags: z.array(z.string().min(1)).optional(),
    keys: z.array(z.string().min(1)).optional(),
  })
  .refine((body) => (body.tags?.length ?? 0) + (body.keys?.length ?? 0) > 0, {
    message: 'At least one tag or key is required',
  });

/** True when the acting principal has an admin-bypass role for this site. */
async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: {
      userId: auth?.userId ?? null,
      siteId: c.get('siteId'),
      roleId: auth?.roleId ?? null,
      user: null,
      ip: c.get('ip') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
  }).bundle();
  return bundle.admin === true;
}

/**
 * Namespaces a purge target may live in. The `siteId` must occupy the tenant
 * *segment* — `items:${siteId}:…`, not merely appear somewhere in the string.
 *
 * `value.includes(siteId)` was not enough: site ids are not all 21-char nanoids
 * (the Req 19 shape survey found `site-a`, `site_test`, `__default__` in live
 * use), so a tenant named `site-a` would pass the check for
 * `items:site-abc:posts` and purge a neighbour's cache. Cross-tenant purge is a
 * DoD 2b violation and a cache-stampede lever against another tenant.
 */
const PURGE_NAMESPACES = ['items', 'deliver', 'schema', 'perm', 'neg'] as const;

/** Reject purge targets that do not belong to the active tenant namespace. */
export function isTenantScoped(siteId: string, value: string): boolean {
  // Anchored on both sides: `<namespace>:<siteId>` followed by `:` or end.
  for (const namespace of PURGE_NAMESPACES) {
    const prefix = `${namespace}:${siteId}`;
    if (value === prefix || value.startsWith(`${prefix}:`)) return true;
  }
  // Site-level tombstone is the one flat key (design §14.5 / §17 exception).
  return value === `neg:site:${siteId}`;
}

cacheUtilsRouter.post('/purge', async (c) => {
  if (!(await isAdmin(c))) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Cache purge requires an admin principal.' }] },
      403,
    );
  }

  const parsed = purgeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const siteId = c.get('siteId');
  const tags = parsed.data.tags ?? [];
  const keys = parsed.data.keys ?? [];

  for (const tag of tags) {
    if (!isTenantScoped(siteId, tag)) {
      return c.json(
        {
          errors: [
            {
              code: 'FORBIDDEN',
              message: `Tag "${tag}" is outside the current site namespace.`,
            },
          ],
        },
        403,
      );
    }
  }
  for (const key of keys) {
    if (!isTenantScoped(siteId, key)) {
      return c.json(
        {
          errors: [
            {
              code: 'FORBIDDEN',
              message: `Key "${key}" is outside the current site namespace.`,
            },
          ],
        },
        403,
      );
    }
  }

  const cache = c.get('runtime').cache;
  await Promise.all([
    ...tags.map((tag) => cache.invalidateByTag(tag)),
    ...keys.map((key) => cache.delete(key)),
  ]);

  return c.json({
    data: {
      purgedTags: tags.length,
      purgedKeys: keys.length,
    },
  });
});

