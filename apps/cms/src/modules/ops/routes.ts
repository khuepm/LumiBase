/**
 * Read-only ops diagnostics plane — `/api/v1/ops/*`
 * (`.kiro/specs/ops-diagnostics/design.md` §2).
 *
 * Gated by the static `LUMIBASE_OPS_TOKEN` (unset or wrong → the canonical
 * 404, so the plane is not discoverable). Not a tenant route: no
 * withTenant/withAuth, no site header. Every route is read-only and returns
 * no row data — only metadata, sanitized errors, booleans and counts.
 */
import { opsErrors, schema as dbSchema } from '@lumibase/database';
import { and, desc, eq, gte, like, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { collectDiagnostics, probeSite } from './diagnostics';
import { sanitizeError } from './sanitize';
import { isOpsAuthorized } from './token';

export const opsRouter = new Hono<AppEnv>();

const notFound = (c: Context<AppEnv>) =>
  c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404);

opsRouter.use('*', async (c, next) => {
  if (!isOpsAuthorized(c.env, c.req.header('authorization'))) return notFound(c);
  // One structured line per ops call — the plane's own access trail.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'ops_access',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
    }),
  );
  c.header('Cache-Control', 'no-store');
  await next();
});

function systemDb(c: Context<AppEnv>) {
  const database = c.get('runtime')?.database;
  if (!database) return null;
  return drizzle(database.getSystemConnection() as never, { schema: dbSchema });
}

opsRouter.get('/diagnostics', async (c) => c.json({ data: await collectDiagnostics(c) }));

const ErrorQuery = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  status: z.coerce.number().int().min(500).max(599).optional(),
  path: z.string().max(512).optional(),
  siteId: z.string().max(128).optional(),
  requestId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

opsRouter.get('/errors', async (c) => {
  const parsed = ErrorQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] }, 400);
  }
  const q = parsed.data;
  const db = systemDb(c);
  if (!db) return c.json({ errors: [{ code: 'NO_DATABASE', message: 'No database provider.' }] }, 503);

  const where: SQL[] = [];
  if (q.since) where.push(gte(opsErrors.createdAt, new Date(q.since)));
  if (q.status) where.push(eq(opsErrors.status, q.status));
  if (q.path) where.push(like(opsErrors.path, `${q.path.replace(/[%_\\]/g, '\\$&')}%`));
  if (q.siteId) where.push(eq(opsErrors.siteId, q.siteId));
  if (q.requestId) where.push(eq(opsErrors.requestId, q.requestId));

  try {
    const rows = await db
      .select()
      .from(opsErrors)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(opsErrors.createdAt))
      .limit(q.limit);
    return c.json({ data: rows, meta: { count: rows.length, limit: q.limit } });
  } catch (err) {
    return c.json(
      {
        errors: [
          {
            code: 'OPS_ERRORS_UNAVAILABLE',
            message: 'lumibase_ops_errors could not be read (migration 0029 not applied?). See error.',
            error: sanitizeError(err),
          },
        ],
      },
      503,
    );
  }
});

opsRouter.get('/errors/:requestId', async (c) => {
  const db = systemDb(c);
  if (!db) return c.json({ errors: [{ code: 'NO_DATABASE', message: 'No database provider.' }] }, 503);
  try {
    const rows = await db
      .select()
      .from(opsErrors)
      .where(eq(opsErrors.requestId, c.req.param('requestId')))
      .orderBy(desc(opsErrors.createdAt))
      .limit(20);
    if (rows.length === 0) {
      return c.json(
        { errors: [{ code: 'NOT_FOUND', message: 'No captured error for that requestId (retention is 14 days).' }] },
        404,
      );
    }
    return c.json({ data: rows });
  } catch (err) {
    return c.json(
      { errors: [{ code: 'OPS_ERRORS_UNAVAILABLE', message: 'lumibase_ops_errors could not be read.', error: sanitizeError(err) }] },
      503,
    );
  }
});

opsRouter.get('/sites/:siteId/probe', async (c) => {
  const siteId = c.req.param('siteId');
  if (siteId.length > 128) return c.json({ errors: [{ code: 'VALIDATION', message: 'siteId too long.' }] }, 400);
  const result = await probeSite(c, siteId);
  if (!result) return c.json({ errors: [{ code: 'NO_DATABASE', message: 'No database provider.' }] }, 503);
  return c.json({ data: result });
});
