/**
 * Publication state on items (#687 / #688).
 *
 * Two concerns live here so every write path and every read path agrees:
 *
 * 1. **Stamps** — `firstPublishedAt`, `publishedAt`, `hasUnpublishedChanges`.
 *    A write is a *publish* when the item ends up `published` and either it
 *    was not published before, or the caller explicitly asked for
 *    `status: 'published'` (a re-publish, e.g. a release or an editor pressing
 *    Publish again). A publish stamps `publishedAt`, stamps `firstPublishedAt`
 *    only if it was never set, and clears `hasUnpublishedChanges`. Any other
 *    write that changes the data of an item that has been published flips
 *    `hasUnpublishedChanges` on. Unpublishing keeps both timestamps.
 *
 * 2. **Cohorts** — `publicationState=live|preview|all` (#688) selects which
 *    items a read returns. `live` is what an anonymous visitor may see;
 *    `preview` adds drafts; `all` applies no cohort filter. Anonymous callers
 *    can never widen past `live`.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { items } from '@lumibase/database';

export interface PublicationSnapshot {
  status: string;
  firstPublishedAt?: Date | null;
  hasUnpublishedChanges?: boolean | null;
}

export interface PublicationWrite {
  /** Status the row will have after the write. */
  status: string;
  /** Whether the write changes item data (not just status/sort/schedule). */
  dataChanged: boolean;
  /** The caller sent `status: 'published'` explicitly (re-publish intent). */
  publishRequested?: boolean;
}

export interface PublicationStamps {
  firstPublishedAt?: Date;
  publishedAt?: Date;
  hasUnpublishedChanges?: boolean;
}

/** True when this write counts as a publish (see module doc). */
export function isPublishWrite(prev: PublicationSnapshot | null, next: PublicationWrite): boolean {
  if (next.status !== 'published') return false;
  if (!prev || prev.status !== 'published') return true;
  return next.publishRequested === true;
}

/**
 * Columns to set on the row for this write. Returns only the columns that
 * change, so it can be spread into an `UPDATE ... SET` without touching the
 * others. `prev` is null for an insert.
 */
export function publicationStamps(
  prev: PublicationSnapshot | null,
  next: PublicationWrite,
  now: Date = new Date(),
): PublicationStamps {
  if (isPublishWrite(prev, next)) {
    return {
      publishedAt: now,
      ...(prev?.firstPublishedAt ? {} : { firstPublishedAt: now }),
      hasUnpublishedChanges: false,
    };
  }
  const everPublished = Boolean(prev?.firstPublishedAt) || prev?.status === 'published';
  if (next.dataChanged && everPublished && prev?.hasUnpublishedChanges !== true) {
    return { hasUnpublishedChanges: true };
  }
  return {};
}

export const PUBLICATION_STATES = ['live', 'preview', 'all'] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export function isPublicationState(value: unknown): value is PublicationState {
  return typeof value === 'string' && (PUBLICATION_STATES as readonly string[]).includes(value);
}

/**
 * The cohort a caller actually gets. Anonymous callers (no user, no API key)
 * are clamped to `live`: asking for `preview`/`all` cannot surface drafts.
 * When the caller did not ask, `undefined` keeps the historical behaviour
 * (no cohort filter; RBAC alone decides).
 */
export function effectivePublicationState(
  requested: PublicationState | undefined,
  anonymous: boolean,
): PublicationState | undefined {
  if (requested === undefined) return undefined;
  return anonymous ? 'live' : requested;
}

/** SQL clause selecting the cohort, or `undefined` for `all`/unset. */
export function publicationStateClause(
  state: PublicationState | undefined,
  now: Date = new Date(),
): SQL | undefined {
  if (state === 'live') {
    return and(
      eq(items.status, 'published'),
      or(isNull(items.publishAt), lte(items.publishAt, now)),
      or(isNull(items.unpublishAt), gt(items.unpublishAt, now)),
    );
  }
  if (state === 'preview') return inArray(items.status, ['draft', 'published']);
  return undefined;
}

/** In-memory twin of {@link publicationStateClause} for a loaded row. */
export function matchesPublicationState(
  row: { status: string; publishAt?: Date | string | null; unpublishAt?: Date | string | null },
  state: PublicationState | undefined,
  now: Date = new Date(),
): boolean {
  if (state === 'live') {
    if (row.status !== 'published') return false;
    const publishAt = row.publishAt ? new Date(row.publishAt) : null;
    const unpublishAt = row.unpublishAt ? new Date(row.unpublishAt) : null;
    if (publishAt && publishAt.getTime() > now.getTime()) return false;
    if (unpublishAt && unpublishAt.getTime() <= now.getTime()) return false;
    return true;
  }
  if (state === 'preview') return row.status === 'draft' || row.status === 'published';
  return true;
}

/** Order-insensitive deep equality for item data (detects no-op saves). */
export function sameItemData(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Publish stamps for a set-based UPDATE that does not hold the previous row
 * (editorial transition, scheduler sweep). `firstPublishedAt` keeps its
 * existing value through `coalesce`, so a re-publish never moves it.
 */
export function publishStampsSql(now: Date = new Date()): {
  publishedAt: Date;
  firstPublishedAt: SQL;
  hasUnpublishedChanges: boolean;
} {
  return {
    publishedAt: now,
    firstPublishedAt: sql`coalesce(${items.firstPublishedAt}, ${now.toISOString()}::timestamp)`,
    hasUnpublishedChanges: false,
  };
}
