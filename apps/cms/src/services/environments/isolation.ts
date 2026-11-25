/**
 * Side-system isolation for Content Environments (#853 task 5.2, design §4).
 *
 * The first line of defence is data: a fork copies webhooks and flows
 * inactive and never copies revalidation targets, Firebase pipelines, CDC
 * subscriptions or deployments, so every channel that reads its configuration
 * by `site_id` finds nothing to fire for the environment.
 *
 * This module is the second line. The child site carries a platform-owned
 * marker setting, `environment.origin` (reserved: the settings API refuses to
 * write or delete it), and each outbound dispatch point asks
 * {@link isEnvironmentSite} before it sends anything. A setting rather than a
 * lookup in `lumibase_environments` because that table belongs to the ORIGIN:
 * under `LUMIBASE_DB_RLS=enforce` a connection scoped to the child cannot see
 * it, while the child's own settings are always visible to it.
 *
 * Results are cached per process for a short time: a site's environment-ness
 * only changes when it is created (marker written in the same transaction as
 * the site) or deleted (the site is gone).
 */

import { and, eq } from 'drizzle-orm';
import { settings, type Database } from '@lumibase/database';

export const ENVIRONMENT_MARKER_KEY = 'environment.origin';
export const NOTIFICATIONS_KEY = 'environments.sideEffects.notifications';

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { value: string | null; at: number }>();

type Reader = Pick<Database, 'select'>;

/** The origin site id when `siteId` is an environment, else null. */
export async function environmentOriginOf(db: Reader, siteId: string): Promise<string | null> {
  const hit = cache.get(siteId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    // (site_id, key) is unique: at most one row, so no LIMIT is needed.
    .where(and(eq(settings.siteId, siteId), eq(settings.key, ENVIRONMENT_MARKER_KEY)));
  const origin = row ? originFromMarker(row.value) : null;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(siteId, { value: origin, at: Date.now() });
  return origin;
}

function originFromMarker(value: unknown): string | null {
  const v = value as { originSiteId?: unknown } | null;
  return v && typeof v.originSiteId === 'string' ? v.originSiteId : null;
}

/**
 * Whether `siteId` is an environment. Fails CLOSED: if the marker cannot be
 * read, the caller treats the site as an environment and does not send.
 */
export async function isEnvironmentSite(db: Reader | undefined, siteId: string | null | undefined): Promise<boolean> {
  if (!db || !siteId) return false;
  try {
    return (await environmentOriginOf(db, siteId)) !== null;
  } catch {
    return true;
  }
}

/**
 * Whether an environment may send email/push (Req 4.3): only once an admin of
 * the environment turned `environments.sideEffects.notifications` on.
 */
export async function environmentNotificationsAllowed(db: Reader, siteId: string): Promise<boolean> {
  if (!(await isEnvironmentSite(db, siteId))) return true;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.siteId, siteId), eq(settings.key, NOTIFICATIONS_KEY)));
    return row?.value === true;
  } catch {
    return false;
  }
}

/** Test hook and post-delete hygiene. */
export function forgetEnvironmentSite(siteId?: string): void {
  if (siteId) cache.delete(siteId);
  else cache.clear();
}
