/**
 * `/api/v1/me/security-history` (#739, epic #674 S10) — the caller's own
 * security timeline, for staff (studio realm) and members (frontend realm)
 * alike. Mounted on the authenticated `api` chain, so `withAuth` has already
 * resolved the principal; a principal without a user (API key, anonymous)
 * gets 401.
 *
 *   GET /                 one page, newest first
 *                         ?cursor=&limit=1..100 (default 25)&scope=site|account
 *   GET /export           every row in scope (cap 5,000)
 *                         ?format=json|csv (default json)&scope=site|account
 *
 * Multi-site: `scope=site` (default) returns only events recorded under the
 * request's site (`X-Lumi-Site`), on the request's RLS-scoped connection.
 * `scope=account` adds every site the caller is a member of (direct
 * `user_sites` rows): password, MFA and lockout state are account-wide, so a
 * password changed through site A is visible from site B. Rows of sites the
 * caller does not belong to are never read. Each item carries its `siteId`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { users, userSites, type Database } from '@lumibase/database';
import type { RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../../env';
import { systemDbFor } from '../../middleware/db';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';
import { decodeCursor } from '../audit/routes';
import {
  exportSecurityHistory,
  historyToCsv,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  querySecurityHistory,
  type SecurityHistorySubject,
} from './service';

export const securityHistoryRouter = new Hono<AppEnv>();

export const HISTORY_EXPORT_LIMIT = 10;
export const HISTORY_EXPORT_WINDOW_SECONDS = 15 * 60;
const fallbackLimiter = new MemoryRateLimiter();

type Scope = 'site' | 'account';

function validation(c: Context<AppEnv>, message: string) {
  return c.json({ errors: [{ code: 'VALIDATION_ERROR', message }] }, 400);
}

function parseScope(raw: string | undefined): Scope | null {
  if (raw === undefined || raw === '' || raw === 'site') return 'site';
  if (raw === 'account') return 'account';
  return null;
}

/** The caller as a history subject, or null when there is no user principal. */
async function resolveSubject(c: Context<AppEnv>): Promise<SecurityHistorySubject | null> {
  const userId = c.get('auth')?.userId;
  if (!userId) return null;
  const [row] = await c
    .get('db')
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return { userId: row.id, email: row.email, createdAt: row.createdAt ?? null };
}

/** The DB handle and site list a scope reads. */
async function resolveScope(
  c: Context<AppEnv>,
  scope: Scope,
  userId: string,
): Promise<{ db: Database; siteIds: string[] }> {
  const siteId = c.get('siteId');
  if (scope === 'site') return { db: c.get('db'), siteIds: siteId ? [siteId] : [] };
  // Cross-site read of the caller's OWN rows: the system handle, filtered to
  // the caller's memberships (never a site the caller does not belong to).
  const db = systemDbFor(c);
  const memberships = await db
    .select({ siteId: userSites.siteId })
    .from(userSites)
    .where(eq(userSites.userId, userId));
  const ids = new Set<string>(memberships.map((m) => m.siteId));
  if (siteId) ids.add(siteId);
  return { db, siteIds: [...ids] };
}

function unauthenticated(c: Context<AppEnv>) {
  return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'No active session.' }] }, 401);
}

securityHistoryRouter.get('/', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) return validation(c, 'scope must be "site" or "account".');

  const rawLimit = c.req.query('limit');
  let limit = HISTORY_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > HISTORY_MAX_LIMIT) {
      return validation(c, `limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}.`);
    }
    limit = n;
  }

  const rawCursor = c.req.query('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return validation(c, 'Malformed cursor.');

  const subject = await resolveSubject(c);
  if (!subject) return unauthenticated(c);

  const { db, siteIds } = await resolveScope(c, scope, subject.userId);
  const page = await querySecurityHistory(db, { subject, siteIds, cursor, limit });

  c.header('Cache-Control', 'no-store');
  return c.json({ data: page.items, meta: { nextCursor: page.nextCursor, limit, scope } });
});

securityHistoryRouter.get('/export', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) return validation(c, 'scope must be "site" or "account".');
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') return validation(c, 'format must be "json" or "csv".');

  const subject = await resolveSubject(c);
  if (!subject) return unauthenticated(c);

  let limiter: RateLimiterProvider | undefined;
  try {
    limiter = c.get('runtime')?.rateLimiter;
  } catch {
    limiter = undefined;
  }
  const key = `rl:security-history-export:user:${subject.userId}`;
  let rl = await consumeRateLimit(limiter, key, HISTORY_EXPORT_LIMIT, HISTORY_EXPORT_WINDOW_SECONDS);
  if (rl.status === 'unavailable') {
    rl = await consumeRateLimit(fallbackLimiter, key, HISTORY_EXPORT_LIMIT, HISTORY_EXPORT_WINDOW_SECONDS);
  }
  if (rl.status === 'block') {
    c.header('Retry-After', String(rl.retryAfterSeconds));
    return c.json(
      {
        errors: [{
          code: 'RATE_LIMITED',
          message: 'Too many exports. Try again later.',
          retryAfterSeconds: rl.retryAfterSeconds,
        }],
      },
      429,
    );
  }

  const { db, siteIds } = await resolveScope(c, scope, subject.userId);
  const { items, truncated } = await exportSecurityHistory(db, { subject, siteIds });
  const exportedAt = new Date();
  const stamp = exportedAt.toISOString().slice(0, 10);

  c.header('Cache-Control', 'no-store');
  c.header('X-Export-Truncated', truncated ? 'true' : 'false');
  if (format === 'csv') {
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="security-history-${stamp}.csv"`);
    return c.body(historyToCsv(items));
  }
  c.header('Content-Disposition', `attachment; filename="security-history-${stamp}.json"`);
  return c.json({
    data: items,
    meta: { exportedAt: exportedAt.toISOString(), count: items.length, truncated, scope },
  });
});
