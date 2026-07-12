/**
 * Change Feed outbox writer (spec: cdc-extension-integration, Req 1.2–1.6).
 *
 * Appends one immutable Change_Event row per committed item mutation. Two
 * contracts matter more than anything else here:
 *
 * 1. **Never break the mutation.** `write()` never throws — a failed outbox
 *    insert emits a `cdc_event_write_failed` audit warning (Req 1.3) and the
 *    caller's response proceeds. ItemService's writes (revision, activity,
 *    index, realtime) are sequential best-effort, not one transaction; the
 *    outbox follows the same convention. Same-transaction capture (Req 1.2)
 *    activates if/when ItemService gains a transactional pipeline — the
 *    sweep-based dispatcher plus consumer reconcile covers the gap (design
 *    §14.1–.2).
 * 2. **Sites that don't use the feed pay ~nothing** (Req 1.5). A per-site
 *    enabled flag (any active subscription OR `cdc_feed.enabled`) is cached
 *    for `flagTtlSeconds`; when off, `write()` returns before touching the
 *    payload. Subscription CRUD / settings writes call
 *    `invalidateFeedFlagCache` to flip promptly.
 *
 * Masking (Req 1.4) happens BEFORE the insert: any field whose
 * classification is `pii`/`phi` is replaced by `[masked]` in the stored
 * snapshot, so sensitive values never exist in the outbox at rest.
 */

import { and, eq } from 'drizzle-orm';
import {
  cdcChangeEvents,
  cdcSubscriptions,
  settings,
  type Database,
} from '@lumibase/database';
import { CdcFeedSettingsSchema } from '@lumibase/shared/schemas';
import type {
  CdcActorType,
  CdcOperation,
  CdcSource,
} from '@lumibase/shared/schemas';
import type { CacheProvider } from '@lumibase/runtime';

export const MASKED_VALUE = '[masked]';
/** Feed-flag cache TTL — subscription CRUD invalidates eagerly (Req 1.5). */
export const FLAG_TTL_SECONDS = 60;

export interface OutboxActor {
  type: CdcActorType;
  id?: string | null;
}

export interface OutboxMutationInput {
  collection: string;
  itemId: string;
  operation: CdcOperation;
  /** Post-mutation snapshot (already decrypted for the caller); null on delete. */
  payload?: Record<string, unknown> | null;
  /** Field names touched by an update. */
  changedFields?: string[] | null;
}

export interface OutboxWriteResult {
  /** false when the feed is disabled for the site (nothing inserted). */
  written: boolean;
  /** Set when the insert failed and the audit-warning fallback ran (Req 1.3). */
  failed?: boolean;
  eventId?: string;
}

export interface OutboxAuditWarning {
  event: 'cdc_event_write_failed';
  siteId: string;
  collection: string;
  itemId: string;
  operation: CdcOperation;
  reason: string;
}

export interface OutboxWriterDeps {
  db: Database;
  siteId: string;
  /** Runtime cache for the per-site enabled flag; absent → flag queried per write. */
  cache?: CacheProvider;
  /**
   * Returns the set of field names classified `pii`/`phi` for a collection
   * (from SchemaService's compiled manifest). Injected so tests never need a
   * schema service and masking stays a pure seam.
   */
  getSensitiveFields: (collection: string) => Promise<Set<string>>;
  /**
   * Fallback sink for Req 1.3 — must itself never throw (AuditLogger's
   * contract). Defaults to a structured console.error so a lost event is
   * still visible to log aggregators.
   */
  auditWarn?: (warning: OutboxAuditWarning) => Promise<void> | void;
}

/** Tenant-prefixed cache key (DoD §2b — no cross-site flag bleed). */
export function feedFlagCacheKey(siteId: string): string {
  return `cdc:feed:${siteId}:enabled`;
}

export async function invalidateFeedFlagCache(
  cache: CacheProvider | undefined,
  siteId: string,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(feedFlagCacheKey(siteId));
  } catch {
    // Cache loss only delays the flag by one TTL — never surface it.
  }
}

/**
 * Pure masking step (property P4): replaces the VALUE of every sensitive
 * field present in the payload with `[masked]`, preserves every other entry
 * untouched, and never mutates its input. Field names stay visible — Req 1.1
 * keeps `changedFields` as names only, which are not classified data.
 */
export function maskChangeEventPayload(
  payload: Record<string, unknown>,
  sensitiveFields: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = sensitiveFields.has(key) ? MASKED_VALUE : value;
  }
  return out;
}

function defaultAuditWarn(warning: OutboxAuditWarning): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(warning));
}

export class OutboxWriter {
  constructor(private readonly deps: OutboxWriterDeps) {}

  /**
   * Site-flag check (Req 1.5): enabled iff the site has at least one active
   * subscription OR `settings.cdc_feed.enabled` is true. Cached under a
   * tenant-prefixed key; a cache failure degrades to querying, never to a
   * wrong answer.
   */
  async isFeedEnabled(): Promise<boolean> {
    const key = feedFlagCacheKey(this.deps.siteId);
    if (this.deps.cache) {
      try {
        const cached = await this.deps.cache.get(key);
        if (cached === 'true') return true;
        if (cached === 'false') return false;
      } catch {
        // fall through to the query
      }
    }
    const enabled = await this.queryFeedEnabled();
    if (this.deps.cache) {
      try {
        await this.deps.cache.set(key, String(enabled), { ttl: FLAG_TTL_SECONDS });
      } catch {
        // cache write is best-effort
      }
    }
    return enabled;
  }

  private async queryFeedEnabled(): Promise<boolean> {
    const [activeSub] = await this.deps.db
      .select({ id: cdcSubscriptions.id })
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, this.deps.siteId),
          eq(cdcSubscriptions.status, 'active'),
        ),
      )
      .limit(1);
    if (activeSub) return true;

    const [row] = await this.deps.db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'cdc_feed')),
      )
      .limit(1);
    if (!row) return false;
    const parsed = CdcFeedSettingsSchema.safeParse(row.value);
    return parsed.success ? parsed.data.enabled : false;
  }

  /**
   * Append one Change_Event for a committed mutation. Masks pii/phi before
   * the insert; never throws (Req 1.3). `occurred_at` is intentionally left
   * to the column's Postgres `now()` default — one DB clock feeds the keyset.
   */
  async write(
    mutation: OutboxMutationInput,
    actor: OutboxActor,
    source: CdcSource,
  ): Promise<OutboxWriteResult> {
    try {
      if (!(await this.isFeedEnabled())) return { written: false };

      let payload: Record<string, unknown> | null = null;
      if (mutation.payload && mutation.operation !== 'delete') {
        const sensitive = await this.deps.getSensitiveFields(mutation.collection);
        payload = maskChangeEventPayload(mutation.payload, sensitive);
      }

      const [row] = await this.deps.db
        .insert(cdcChangeEvents)
        .values({
          siteId: this.deps.siteId,
          collection: mutation.collection,
          itemId: mutation.itemId,
          operation: mutation.operation,
          payload,
          changedFields: mutation.changedFields ?? null,
          actorType: actor.type,
          actorId: actor.id ?? null,
          source,
        })
        .returning({ id: cdcChangeEvents.id });
      return { written: true, eventId: row?.id };
    } catch (err) {
      const warn = this.deps.auditWarn ?? defaultAuditWarn;
      try {
        await warn({
          event: 'cdc_event_write_failed',
          siteId: this.deps.siteId,
          collection: mutation.collection,
          itemId: mutation.itemId,
          operation: mutation.operation,
          reason: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // the warning sink must never take the mutation down either
      }
      return { written: false, failed: true };
    }
  }
}
