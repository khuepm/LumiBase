/**
 * Change Feed retention (Req 6.1, 6.3, 6.4).
 *
 * Prunes outbox events and delivery logs older than the site's retention
 * window (`cdc_feed.retentionDays`, default 7, clamp [1, 90]) — idempotent,
 * safe to run on every sweep tick. One deliberate ordering rule: an event
 * still awaited by an active/paused subscription is kept while inside the
 * window; once PAST the window it is pruned anyway and the lagging
 * subscription flips to `stale` (never silently skipped — Req 6.3), with a
 * notification exactly once per transition. Storage sits behind a port so
 * P10 runs in-memory (the dispatcher convention).
 */

import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  cdcChangeEvents,
  cdcDeliveries,
  cdcSubscriptions,
  settings,
  type Database,
} from '@lumibase/database';
import { CdcFeedSettingsSchema, type CdcCursor } from '@lumibase/contracts/schemas';

export const DEFAULT_RETENTION_DAYS = 7;

export interface StaleSubscriptionNotice {
  siteId: string;
  subscriptionId: string;
  name: string;
}

export interface RetentionResult {
  prunedEvents: number;
  prunedDeliveries: number;
  staleSubscriptions: string[];
}

export interface RetentionStore {
  /** active/paused subscriptions whose checkpoint predates `cutoff`. */
  listLagging(siteId: string, cutoff: Date): Promise<Array<{ id: string; name: string }>>;
  markStale(siteId: string, ids: string[], now: Date): Promise<void>;
  pruneEvents(siteId: string, cutoff: Date): Promise<number>;
  pruneDeliveries(siteId: string, cutoff: Date): Promise<number>;
}

export interface RetentionDeps {
  store: RetentionStore;
  retentionDays: number;
  now?: () => Date;
  notifyStale?: (notice: StaleSubscriptionNotice) => Promise<void> | void;
}

export async function readRetentionDays(db: Database, siteId: string): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'cdc_feed')))
    .limit(1);
  const parsed = CdcFeedSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data.retentionDays : DEFAULT_RETENTION_DAYS;
}

/** Prune one site. Idempotent — a second run at the same instant is a no-op. */
export async function pruneChangeFeed(
  deps: RetentionDeps,
  siteId: string,
): Promise<RetentionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - deps.retentionDays * 86_400_000);

  // 1) Flip lagging subscriptions to stale BEFORE deleting the events they
  //    still needed, so the transition is observable (Req 6.3, 6.4).
  const lagging = await deps.store.listLagging(siteId, cutoff);
  const staleIds = lagging.map((s) => s.id);
  if (staleIds.length > 0) {
    await deps.store.markStale(siteId, staleIds, now);
    for (const sub of lagging) {
      const notify =
        deps.notifyStale ??
        ((notice: StaleSubscriptionNotice) => {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ event: 'cdc_subscription_stale', ...notice }));
        });
      await notify({ siteId, subscriptionId: sub.id, name: sub.name });
    }
  }

  // 2) Prune the outbox + delivery log past the cutoff.
  const prunedEvents = await deps.store.pruneEvents(siteId, cutoff);
  const prunedDeliveries = await deps.store.pruneDeliveries(siteId, cutoff);

  return { prunedEvents, prunedDeliveries, staleSubscriptions: staleIds };
}

// ── In-memory store (P10) ────────────────────────────────────────────────

export interface InMemoryRetentionSubscription {
  id: string;
  siteId: string;
  name: string;
  status: 'active' | 'paused' | 'dead' | 'stale';
  cursor: CdcCursor | null;
}

export class InMemoryRetentionStore implements RetentionStore {
  constructor(
    public subs: InMemoryRetentionSubscription[],
    public events: Array<{ id: string; siteId: string; occurredAt: Date }>,
    public deliveries: Array<{ id: string; siteId: string; createdAt: Date }> = [],
  ) {}

  async listLagging(siteId: string, cutoff: Date) {
    return this.subs
      .filter(
        (s) =>
          s.siteId === siteId &&
          (s.status === 'active' || s.status === 'paused') &&
          s.cursor !== null &&
          s.cursor.occurredAtMs < cutoff.getTime(),
      )
      .map((s) => ({ id: s.id, name: s.name }));
  }
  async markStale(siteId: string, ids: string[]): Promise<void> {
    for (const s of this.subs) {
      if (s.siteId === siteId && ids.includes(s.id)) s.status = 'stale';
    }
  }
  async pruneEvents(siteId: string, cutoff: Date): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => !(e.siteId === siteId && e.occurredAt.getTime() < cutoff.getTime()),
    );
    return before - this.events.length;
  }
  async pruneDeliveries(siteId: string, cutoff: Date): Promise<number> {
    const before = this.deliveries.length;
    this.deliveries = this.deliveries.filter(
      (d) => !(d.siteId === siteId && d.createdAt.getTime() < cutoff.getTime()),
    );
    return before - this.deliveries.length;
  }
}

// ── Drizzle store (production) ───────────────────────────────────────────

export class DrizzleRetentionStore implements RetentionStore {
  constructor(private readonly db: Database) {}

  async listLagging(siteId: string, cutoff: Date) {
    return this.db
      .select({ id: cdcSubscriptions.id, name: cdcSubscriptions.name })
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, siteId),
          inArray(cdcSubscriptions.status, ['active', 'paused']),
          lt(cdcSubscriptions.cursorOccurredAt, cutoff),
        ),
      );
  }
  async markStale(siteId: string, ids: string[], now: Date): Promise<void> {
    await this.db
      .update(cdcSubscriptions)
      .set({ status: 'stale', updatedAt: now })
      .where(and(eq(cdcSubscriptions.siteId, siteId), inArray(cdcSubscriptions.id, ids)));
  }
  async pruneEvents(siteId: string, cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, siteId), lt(cdcChangeEvents.occurredAt, cutoff)))
      .returning({ id: cdcChangeEvents.id });
    return rows.length;
  }
  async pruneDeliveries(siteId: string, cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(cdcDeliveries)
      .where(and(eq(cdcDeliveries.siteId, siteId), lt(cdcDeliveries.createdAt, cutoff)))
      .returning({ id: cdcDeliveries.id });
    return rows.length;
  }
}
