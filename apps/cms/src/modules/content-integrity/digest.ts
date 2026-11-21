/**
 * "What went live" digest (#989).
 *
 * The content-integrity monitor raises alerts on the write that looks wrong.
 * The digest is the other half: a regular, boring summary of everything that
 * went live, so an injection the scan cannot see (a plausible-looking lure
 * page, an account that should not be publishing at all) still crosses a
 * human's desk. Gootloader sites ran for months because nobody looked.
 *
 *   - {@link buildContentDigest}: items first published in the window, grouped
 *     by the account that last wrote them, plus the window's alerts by
 *     signal. Served by `GET /api/v1/admin/security/content-integrity/digest`.
 *   - {@link runWeeklyContentDigest}: from the hourly cron, once every 7 days
 *     per site, a Studio notification to each site administrator. Skipped
 *     when nothing went live and nothing alerted, or when the site turned
 *     the monitor or `weeklyDigest` off. Never throws.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
  auditLog, collections, items, notifications, roles, settings, sites, userSites, users, type Database,
} from '@lumibase/database';
import type { RealtimeProvider } from '@lumibase/runtime';
import { CONTENT_INTEGRITY_EVENT, CONTENT_INTEGRITY_SETTING, parseContentIntegrityPolicy } from './monitor';

/** `notifications.collection` marker for digest rows (also the 7-day dedupe key). */
export const CONTENT_DIGEST_MARKER = 'lumibase_content_digest';
export const CONTENT_DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Slack for an hourly cron whose ticks drift: a digest is "due" after 6 d 23 h. */
const DUE_SLACK_MS = 60 * 60 * 1000;
const MAX_ITEMS = 100;
const MAX_ALERT_ROWS = 1000;
const MAX_RECIPIENTS = 50;

export interface ContentDigest {
  from: string;
  to: string;
  published: {
    total: number;
    byPrincipal: Array<{ userId: string | null; email: string | null; count: number }>;
    items: Array<{ collection: string; itemId: string; firstPublishedAt: string; userId: string | null }>;
  };
  alerts: { total: number; bySignal: Record<string, number> };
}

export async function buildContentDigest(input: {
  db: Database;
  siteId: string;
  now?: number;
  days?: number;
}): Promise<ContentDigest> {
  const now = input.now ?? Date.now();
  const days = Math.min(31, Math.max(1, Math.floor(input.days ?? 7)));
  const from = new Date(now - days * 24 * 60 * 60 * 1000);
  const to = new Date(now);
  const { db, siteId } = input;
  const window = and(
    eq(items.siteId, siteId),
    isNull(items.deletedAt),
    isNotNull(items.firstPublishedAt),
    gte(items.firstPublishedAt, from),
    lte(items.firstPublishedAt, to),
  );

  const [totalRow] = await db.select({ n: count() }).from(items).where(window);
  const grouped = await db
    .select({ userId: items.userUpdated, n: count() })
    .from(items)
    .where(window)
    .groupBy(items.userUpdated)
    .orderBy(desc(count()))
    .limit(MAX_RECIPIENTS);
  const ids = grouped.map((g) => g.userId).filter((v): v is string => typeof v === 'string');
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    for (const row of await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids))) {
      emails.set(row.id, row.email);
    }
  }
  const itemRows = await db
    .select({
      collection: collections.name,
      itemId: items.id,
      firstPublishedAt: items.firstPublishedAt,
      userId: items.userUpdated,
    })
    .from(items)
    .innerJoin(collections, and(eq(collections.id, items.collectionId), eq(collections.siteId, siteId)))
    .where(window)
    .orderBy(desc(items.firstPublishedAt))
    .limit(MAX_ITEMS);

  const alertRows = await db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, CONTENT_INTEGRITY_EVENT), gte(auditLog.timestamp, from), lte(auditLog.timestamp, to)))
    .limit(MAX_ALERT_ROWS);
  const bySignal: Record<string, number> = {};
  for (const row of alertRows) {
    const signals = (row.metadata as { signals?: Array<{ kind?: unknown }> } | null)?.signals;
    const kinds = new Set((Array.isArray(signals) ? signals : []).map((s) => (typeof s?.kind === 'string' ? s.kind : 'unknown')));
    for (const kind of kinds) bySignal[kind] = (bySignal[kind] ?? 0) + 1;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    published: {
      total: Number(totalRow?.n ?? 0),
      byPrincipal: grouped.map((g) => ({
        userId: g.userId ?? null,
        email: g.userId ? (emails.get(g.userId) ?? null) : null,
        count: Number(g.n),
      })),
      items: itemRows.map((r) => ({
        collection: r.collection,
        itemId: r.itemId,
        firstPublishedAt: (r.firstPublishedAt as Date).toISOString(),
        userId: r.userId ?? null,
      })),
    },
    alerts: { total: alertRows.length, bySignal },
  };
}

/** One-line summary used as the notification message. */
export function digestMessage(digest: ContentDigest): string {
  const people = digest.published.byPrincipal
    .slice(0, 5)
    .map((p) => `${p.email ?? (p.userId ? p.userId : 'API key / system')}: ${p.count}`)
    .join(', ');
  const signals = Object.entries(digest.alerts.bySignal).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `${digest.published.total} item(s) went live${people ? ` (${people})` : ''}.`,
    `${digest.alerts.total} content-integrity alert(s)${signals ? ` (${signals})` : ''}.`,
    'Review them in Settings → Content integrity.',
  ].join(' ');
}

export interface WeeklyDigestDeps {
  db: Database;
  now?: number;
  realtime?: RealtimeProvider;
}

export async function runWeeklyContentDigest(deps: WeeklyDigestDeps): Promise<{ sent: number } | null> {
  try {
    const now = deps.now ?? Date.now();
    let sent = 0;
    for (const { id: siteId } of await deps.db.select({ id: sites.id }).from(sites)) {
      const [setting] = await deps.db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.siteId, siteId), eq(settings.key, CONTENT_INTEGRITY_SETTING)))
        .limit(1);
      const policy = parseContentIntegrityPolicy(setting?.value);
      if (!policy.enabled || !policy.weeklyDigest) continue;

      const since = new Date(now - CONTENT_DIGEST_INTERVAL_MS + DUE_SLACK_MS);
      const [recent] = await deps.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.siteId, siteId), eq(notifications.collection, CONTENT_DIGEST_MARKER), gte(notifications.createdAt, since)))
        .limit(1);
      if (recent) continue;

      const digest = await buildContentDigest({ db: deps.db, siteId, now });
      if (digest.published.total === 0 && digest.alerts.total === 0) continue;

      const admins = await deps.db
        .selectDistinct({ userId: userSites.userId })
        .from(userSites)
        .innerJoin(roles, and(eq(roles.id, userSites.roleId), eq(roles.siteId, siteId)))
        .where(and(eq(userSites.siteId, siteId), eq(roles.adminAccess, true)))
        .limit(MAX_RECIPIENTS);
      if (admins.length === 0) continue;

      const { NotificationService } = await import('../../services/notification-service');
      const service = new NotificationService({ db: deps.db, siteId, realtime: deps.realtime });
      const message = digestMessage(digest);
      for (const { userId } of admins) {
        await service.create({ recipient: userId, subject: 'What went live this week', message, collection: CONTENT_DIGEST_MARKER });
        sent += 1;
      }
    }
    return { sent };
  } catch (err) {
    console.error('[content-integrity] weekly digest failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}
