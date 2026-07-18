import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { PageviewService } from './service';
import { shouldRecord } from './bot-filter';

/**
 * Pageview HTTP surface, split into two routers:
 *   - {@link pageviewsPublicRouter} `POST /:site_id/hit` — unauthenticated beacon
 *     from public sites (navigator.sendBeacon). Mounted at `/api/v1/pageviews`
 *     at the top level with `withDb()` + a rate limiter (siteId in the path,
 *     like the delivery API). Bot-filtered; returns 204.
 *   - {@link pageviewsRouter} `GET /stats` — authenticated admin read, mounted
 *     inside the `api` sub-app so the tenant/auth/db chain runs upstream.
 */

const hitSchema = z.object({
  path: z.string().min(1).max(2048),
  referrer: z.string().max(2048).optional(),
});

export const pageviewsPublicRouter = new Hono<AppEnv>();

pageviewsPublicRouter.post('/:site_id/hit', async (c) => {
  const siteId = c.req.param('site_id');
  const db = c.get('db');
  const runtime = c.get('runtime');

  // Honour bots / DNT / GPC before doing any work.
  const gate = shouldRecord({
    userAgent: c.req.header('user-agent'),
    dnt: c.req.header('dnt'),
    gpc: c.req.header('sec-gpc'),
  });
  if (!gate.record) {
    // 204 regardless — never reveal filtering to the client.
    return c.body(null, 204);
  }

  let body: z.infer<typeof hitSchema>;
  try {
    body = hitSchema.parse(await c.req.json());
  } catch {
    return c.json({ errors: [{ code: 'INVALID_BODY' }] }, 400);
  }

  const service = new PageviewService({ db, runtime });
  try {
    await service.recordHit(siteId, {
      path: body.path,
      userId: c.get('auth')?.userId,
      ip: c.get('ip'),
      userAgent: c.req.header('user-agent'),
      referrer: body.referrer ?? c.req.header('referer'),
      countryCode: c.req.header('cf-ipcountry') ?? undefined,
    });
  } catch (err) {
    // Fail-open: a counting error must never break the visitor's request.
    console.warn('[pageviews] recordHit failed (non-fatal)', err);
  }
  return c.body(null, 204);
});

const statsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  path: z.string().optional(),
});

export const pageviewsRouter = new Hono<AppEnv>();

pageviewsRouter.get('/stats', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const runtime = c.get('runtime');

  const parsed = statsQuerySchema.safeParse({
    from: c.req.query('from'),
    to: c.req.query('to'),
    path: c.req.query('path'),
  });
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'INVALID_QUERY' }] }, 400);
  }

  const service = new PageviewService({ db, runtime });
  const stats = await service.getStats(siteId, parsed.data);
  return c.json({ data: stats });
});
