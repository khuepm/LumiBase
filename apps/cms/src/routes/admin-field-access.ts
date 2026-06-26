/**
 * Field Access Log query route (regulated-content-readiness task 5.3; Req 6.3).
 *
 *   GET /api/v1/admin/field-access-log?actor=&collection=&from=&to=&limit=&offset=
 *
 * Admin-only, paginated, site-scoped. Returns audit rows of decrypted pii/phi
 * reads — never the decrypted values (those were never stored).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { fieldAccessLog, scopeSite } from '@lumibase/database';
import type { AppEnv } from '../env';

export const adminFieldAccessRouter = new Hono<AppEnv>();

const querySchema = z.object({
  actor: z.string().max(254).optional(),
  collection: z.string().max(128).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
  }
  return null;
}

adminFieldAccessRouter.get('/', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const { actor, collection, from, to } = parsed.data;
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const db = c.get('db');
  const siteId = c.get('siteId');

  const where = and(
    scopeSite(fieldAccessLog.siteId, siteId),
    actor ? eq(fieldAccessLog.actor, actor) : undefined,
    collection ? eq(fieldAccessLog.collection, collection) : undefined,
    from ? gte(fieldAccessLog.timestamp, new Date(from)) : undefined,
    to ? lte(fieldAccessLog.timestamp, new Date(to)) : undefined,
  );

  const rows = await db
    .select()
    .from(fieldAccessLog)
    .where(where)
    .orderBy(desc(fieldAccessLog.timestamp))
    .limit(limit)
    .offset(offset);

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fieldAccessLog)
    .where(where);

  return c.json({ data: rows, meta: { total: count, limit, offset } });
});
