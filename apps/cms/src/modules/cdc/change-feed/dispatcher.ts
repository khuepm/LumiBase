/**
 * Change Feed dispatcher — the outbox relay (Req 4.1, 4.4, 4.5, 4.7).
 *
 * One subscription is one strictly-sequential lane: batches of up to
 * `batchSize` events are read after the checkpoint (with the same 2s safety
 * lag as the pull API), delivered through the kind's sender, and the cursor
 * advances ONLY on success — a failed batch never skips events (P6). A batch
 * retries with exponential backoff (30s·2^n, `MAX_DELIVERY_ATTEMPTS` total);
 * exhausting retries bumps `consecutive_failures`, and at
 * `DEAD_FAILURE_THRESHOLD` the subscription flips to `dead` with exactly one
 * notification (P7 / design §3.2).
 *
 * Correctness never depends on the queue: the queue trigger is a latency
 * optimization, the 30s sweep is the backstop, and `POST .../dispatch` is
 * the no-queue fallback (Req 4.7). Everything DB-shaped sits behind small
 * ports so P6/P7 run in-memory.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  cdcDeliveries,
  cdcSubscriptions,
  webhooks,
  type Database,
} from '@lumibase/database';
import {
  CDC_FEED_SCHEMA_VERSION,
  encodeCdcCursor,
  type CdcActorType,
  type CdcCursor,
  type CdcEventEnvelope,
  type CdcOperation,
  type CdcSource,
} from '@lumibase/shared/schemas';
import type { CacheProvider, QueueProvider } from '@lumibase/runtime';
import {
  eventKeyset,
  SAFETY_LAG_MS,
  type CdcEventStore,
  type StoredChangeEvent,
} from './feed-reader';
import { WebhookSender, type WebhookSendOutcome } from './webhook-sender';

export const CDC_DISPATCH_QUEUE = 'cdc-dispatch';
export const DISPATCH_BATCH_SIZE = 100;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 30_000;
export const DEAD_FAILURE_THRESHOLD = 10;
export const SWEEP_INTERVAL_MS = 30_000;

/** Delay before retry attempt `attempt` (attempt 2 → 30s, 3 → 60s, …). Pure — P7. */
export function retryDelayMs(attempt: number, baseMs = RETRY_BASE_DELAY_MS): number {
  return baseMs * 2 ** (attempt - 2);
}

export interface DispatchableSubscription {
  id: string;
  siteId: string;
  name: string;
  kind: 'webhook' | 'extension';
  collections: string[];
  operations: CdcOperation[];
  payloadMode: 'reference' | 'snapshot';
  cursor: CdcCursor | null;
  consecutiveFailures: number;
  webhookId: string | null;
  extensionName: string | null;
}

/** Mutation port over the subscription rows the dispatcher touches. */
export interface SubscriptionDispatchStore {
  listDispatchable(siteId: string): Promise<DispatchableSubscription[]>;
  getDispatchable(siteId: string, id: string): Promise<DispatchableSubscription | null>;
  /** Success path: checkpoint forward, failures reset (Req 4.4). */
  advanceCursor(siteId: string, id: string, keyset: CdcCursor): Promise<void>;
  /** Failure path: returns the NEW consecutive-failure count. */
  recordFailure(siteId: string, id: string): Promise<number>;
  markDead(siteId: string, id: string): Promise<void>;
  /** Sites with at least one active webhook/extension subscription (sweep). */
  listActiveSiteIds(): Promise<string[]>;
}

export interface DeliveryLogEntry {
  siteId: string;
  subscriptionId: string;
  eventIdFrom: string;
  eventIdTo: string;
  eventCount: number;
  attempt: number;
  status: 'success' | 'failed';
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface DeliveryLogStore {
  record(entry: DeliveryLogEntry): Promise<void>;
}

/** A kind-specific transport (webhook now; extension lands in Phase E). */
export interface EnvelopeSender {
  deliver(
    subscription: DispatchableSubscription,
    envelopes: CdcEventEnvelope[],
  ): Promise<WebhookSendOutcome>;
}

export interface DeadSubscriptionNotice {
  siteId: string;
  subscriptionId: string;
  name: string;
  consecutiveFailures: number;
}

export interface DispatcherDeps {
  eventStore: CdcEventStore;
  subscriptions: SubscriptionDispatchStore;
  deliveryLog: DeliveryLogStore;
  senders: Partial<Record<'webhook' | 'extension', EnvelopeSender>>;
  /** Exactly-once-per-transition dead alert (Req 8.2). Default: stderr JSON. */
  notifyDead?: (notice: DeadSubscriptionNotice) => Promise<void> | void;
  /** Best-effort per-subscription lock (overlap is harmless, just wasteful). */
  cache?: CacheProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  batchSize?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  safetyLagMs?: number;
}

export function buildEnvelope(
  event: StoredChangeEvent,
  payloadMode: 'reference' | 'snapshot',
): CdcEventEnvelope {
  return {
    id: event.id,
    type: `items.${event.operation}`,
    schemaVersion: event.schemaVersion ?? CDC_FEED_SCHEMA_VERSION,
    siteId: event.siteId,
    collection: event.collection,
    itemId: event.itemId,
    operation: event.operation,
    occurredAt: event.occurredAt.toISOString(),
    actor: {
      type: event.actorType as CdcActorType,
      ...(event.actorId ? { id: event.actorId } : {}),
    },
    source: event.source as CdcSource,
    ...(event.changedFields?.length ? { changedFields: event.changedFields } : {}),
    ...(payloadMode === 'snapshot' && event.payload ? { data: event.payload } : {}),
    cursor: encodeCdcCursor(eventKeyset(event)),
  };
}

export class CdcDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async sleep(ms: number): Promise<void> {
    await (this.deps.sleep ?? ((m: number) => new Promise((r) => setTimeout(r, m))))(ms);
  }

  async dispatchSite(siteId: string): Promise<void> {
    const subs = await this.deps.subscriptions.listDispatchable(siteId);
    for (const sub of subs) {
      await this.dispatchSubscription(sub);
    }
  }

  async dispatchSubscriptionById(siteId: string, id: string): Promise<boolean> {
    const sub = await this.deps.subscriptions.getDispatchable(siteId, id);
    if (!sub) return false;
    await this.dispatchSubscription(sub);
    return true;
  }

  /** One sequential lane; never throws — failures land in the delivery log. */
  async dispatchSubscription(sub: DispatchableSubscription): Promise<void> {
    const sender = this.deps.senders[sub.kind];
    if (!sender) return;
    if (!(await this.acquireLock(sub))) return;
    try {
      let cursor = sub.cursor;
      // Bounded loop: a lane drains at most 1000 batches per run.
      for (let round = 0; round < 1000; round++) {
        const notAfter = new Date(
          this.now().getTime() - (this.deps.safetyLagMs ?? SAFETY_LAG_MS),
        );
        const events = await this.deps.eventStore.listAfter(
          sub.siteId,
          cursor,
          { collections: sub.collections, operations: sub.operations },
          this.deps.batchSize ?? DISPATCH_BATCH_SIZE,
          notAfter,
        );
        if (events.length === 0) return;

        const envelopes = events.map((e) => buildEnvelope(e, sub.payloadMode));
        const delivered = await this.deliverWithRetry(sender, sub, events, envelopes);
        if (!delivered) {
          const failures = await this.deps.subscriptions.recordFailure(sub.siteId, sub.id);
          if (failures >= DEAD_FAILURE_THRESHOLD) {
            await this.deps.subscriptions.markDead(sub.siteId, sub.id);
            const notify =
              this.deps.notifyDead ??
              ((notice: DeadSubscriptionNotice) => {
                // eslint-disable-next-line no-console
                console.error(JSON.stringify({ event: 'cdc_subscription_dead', ...notice }));
              });
            await notify({
              siteId: sub.siteId,
              subscriptionId: sub.id,
              name: sub.name,
              consecutiveFailures: failures,
            });
          }
          return; // never advance past a failed batch (P6)
        }

        const last = events[events.length - 1]!;
        const keyset = eventKeyset(last);
        await this.deps.subscriptions.advanceCursor(sub.siteId, sub.id, keyset);
        cursor = keyset;
      }
    } finally {
      await this.releaseLock(sub);
    }
  }

  private async deliverWithRetry(
    sender: EnvelopeSender,
    sub: DispatchableSubscription,
    events: StoredChangeEvent[],
    envelopes: CdcEventEnvelope[],
  ): Promise<boolean> {
    const maxAttempts = this.deps.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    const first = events[0]!;
    const last = events[events.length - 1]!;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await this.sleep(retryDelayMs(attempt, this.deps.retryBaseMs ?? RETRY_BASE_DELAY_MS));
      }
      const started = this.now().getTime();
      let outcome: WebhookSendOutcome;
      try {
        outcome = await sender.deliver(sub, envelopes);
      } catch (err) {
        outcome = {
          ok: false,
          httpStatus: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      await this.deps.deliveryLog.record({
        siteId: sub.siteId,
        subscriptionId: sub.id,
        eventIdFrom: first.id,
        eventIdTo: last.id,
        eventCount: events.length,
        attempt,
        status: outcome.ok ? 'success' : 'failed',
        httpStatus: outcome.httpStatus,
        errorMessage: outcome.errorMessage,
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      if (outcome.ok) return true;
    }
    return false;
  }

  private lockKey(sub: DispatchableSubscription): string {
    return `cdc:dispatch:${sub.siteId}:${sub.id}`; // tenant-prefixed (DoD §2b)
  }

  private async acquireLock(sub: DispatchableSubscription): Promise<boolean> {
    if (!this.deps.cache) return true;
    try {
      const key = this.lockKey(sub);
      if ((await this.deps.cache.get(key)) === 'locked') return false;
      await this.deps.cache.set(key, 'locked', { ttl: 60 });
      return true;
    } catch {
      return true; // lock is an optimization, never a correctness gate
    }
  }

  private async releaseLock(sub: DispatchableSubscription): Promise<void> {
    if (!this.deps.cache) return;
    try {
      await this.deps.cache.delete(this.lockKey(sub));
    } catch {
      /* TTL expires it */
    }
  }
}

// ── In-memory ports (repo `InMemory*` convention — P6/P7 tests) ──────────

export class InMemorySubscriptionDispatchStore implements SubscriptionDispatchStore {
  dead: string[] = [];
  constructor(public subs: DispatchableSubscription[]) {}

  async listDispatchable(siteId: string): Promise<DispatchableSubscription[]> {
    return this.subs.filter((s) => s.siteId === siteId);
  }
  async getDispatchable(siteId: string, id: string) {
    return this.subs.find((s) => s.siteId === siteId && s.id === id) ?? null;
  }
  async advanceCursor(siteId: string, id: string, keyset: CdcCursor): Promise<void> {
    const sub = this.subs.find((s) => s.siteId === siteId && s.id === id);
    if (sub) {
      sub.cursor = keyset;
      sub.consecutiveFailures = 0;
    }
  }
  async recordFailure(siteId: string, id: string): Promise<number> {
    const sub = this.subs.find((s) => s.siteId === siteId && s.id === id);
    if (!sub) return 0;
    sub.consecutiveFailures += 1;
    return sub.consecutiveFailures;
  }
  async markDead(siteId: string, id: string): Promise<void> {
    this.dead.push(id);
    this.subs = this.subs.filter((s) => !(s.siteId === siteId && s.id === id));
  }
  async listActiveSiteIds(): Promise<string[]> {
    return [...new Set(this.subs.map((s) => s.siteId))];
  }
}

export class InMemoryDeliveryLog implements DeliveryLogStore {
  entries: DeliveryLogEntry[] = [];
  async record(entry: DeliveryLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

// ── Drizzle ports (production) ────────────────────────────────────────────

export class DrizzleSubscriptionDispatchStore implements SubscriptionDispatchStore {
  constructor(private readonly db: Database) {}

  private toDispatchable(
    row: typeof cdcSubscriptions.$inferSelect,
  ): DispatchableSubscription {
    return {
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      kind: row.kind as 'webhook' | 'extension',
      collections: (row.collections as string[]) ?? [],
      operations: (row.operations as CdcOperation[]) ?? [],
      payloadMode: row.payloadMode as 'reference' | 'snapshot',
      cursor:
        row.cursorOccurredAt && row.cursorId
          ? { occurredAtMs: row.cursorOccurredAt.getTime(), eventId: row.cursorId }
          : null,
      consecutiveFailures: row.consecutiveFailures,
      webhookId: row.webhookId,
      extensionName: row.extensionName,
    };
  }

  async listDispatchable(siteId: string): Promise<DispatchableSubscription[]> {
    const rows = await this.db
      .select()
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, siteId),
          eq(cdcSubscriptions.status, 'active'),
          inArray(cdcSubscriptions.kind, ['webhook', 'extension']),
        ),
      );
    return rows.map((r) => this.toDispatchable(r));
  }

  async getDispatchable(siteId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, siteId),
          eq(cdcSubscriptions.id, id),
          eq(cdcSubscriptions.status, 'active'),
          inArray(cdcSubscriptions.kind, ['webhook', 'extension']),
        ),
      )
      .limit(1);
    return row ? this.toDispatchable(row) : null;
  }

  async advanceCursor(siteId: string, id: string, keyset: CdcCursor): Promise<void> {
    await this.db
      .update(cdcSubscriptions)
      .set({
        cursorOccurredAt: new Date(keyset.occurredAtMs),
        cursorId: keyset.eventId,
        consecutiveFailures: 0,
        lastDeliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)));
  }

  async recordFailure(siteId: string, id: string): Promise<number> {
    const [row] = await this.db
      .update(cdcSubscriptions)
      .set({
        consecutiveFailures: sql`${cdcSubscriptions.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)))
      .returning({ n: cdcSubscriptions.consecutiveFailures });
    return row?.n ?? 0;
  }

  async markDead(siteId: string, id: string): Promise<void> {
    await this.db
      .update(cdcSubscriptions)
      .set({ status: 'dead', updatedAt: new Date() })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)));
  }

  async listActiveSiteIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ siteId: cdcSubscriptions.siteId })
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.status, 'active'),
          ne(cdcSubscriptions.kind, 'pull'),
        ),
      );
    return rows.map((r) => r.siteId);
  }
}

export class DrizzleDeliveryLog implements DeliveryLogStore {
  constructor(private readonly db: Database) {}
  async record(entry: DeliveryLogEntry): Promise<void> {
    await this.db.insert(cdcDeliveries).values({
      ...entry,
      // Sender outcomes never include response bodies or headers, so there is
      // no secret to mask — just bound the size (Req 7.5).
      errorMessage: entry.errorMessage ? entry.errorMessage.slice(0, 500) : null,
    });
  }
}

/** Resolve a webhook subscription's target (url/secret/headers) per site. */
export async function loadWebhookTarget(
  db: Database,
  siteId: string,
  webhookId: string,
): Promise<{ url: string; secret: string; headers: Record<string, string> } | null> {
  const [row] = await db
    .select({ url: webhooks.url, secret: webhooks.secret, headers: webhooks.headers })
    .from(webhooks)
    .where(and(eq(webhooks.siteId, siteId), eq(webhooks.id, webhookId)))
    .limit(1);
  if (!row?.secret) return null; // unsigned delivery is never allowed (Req 4.2)
  return {
    url: row.url,
    secret: row.secret,
    headers: (row.headers as Record<string, string>) ?? {},
  };
}

/**
 * Production webhook transport: resolves the subscription's webhook target
 * (url/secret/headers) per delivery, refusing unsigned targets (Req 4.2).
 */
export function createWebhookEnvelopeSender(db: Database): EnvelopeSender {
  const sender = new WebhookSender();
  return {
    async deliver(sub, envelopes) {
      if (!sub.webhookId) {
        return { ok: false, httpStatus: null, errorMessage: 'Subscription has no webhook' };
      }
      const target = await loadWebhookTarget(db, sub.siteId, sub.webhookId);
      if (!target) {
        return { ok: false, httpStatus: null, errorMessage: 'Webhook missing or has no secret' };
      }
      return sender.deliver(target, envelopes, { id: sub.id, name: sub.name });
    },
  };
}

// ── Worker registration (Docker/Node long-lived runtime — Req 4.7) ────────

export interface CdcDispatchWorkerDeps {
  queue: QueueProvider;
  buildDispatcher: () => CdcDispatcher;
  subscriptions: SubscriptionDispatchStore;
  /** Retention prune, run per site on each sweep tick (Req 6.1). */
  prune?: (siteId: string) => Promise<void>;
  sweepIntervalMs?: number;
}

/**
 * Consumes `cdc-dispatch` jobs (latency path) and runs the 30s sweep
 * (correctness backstop) — the `content-indexing` worker pattern. Returns a
 * stop handle for graceful shutdown/tests.
 */
export function registerCdcDispatchWorker(deps: CdcDispatchWorkerDeps): () => void {
  deps.queue.process<{ siteId: string }>(CDC_DISPATCH_QUEUE, async (job) => {
    const siteId = (job.data as { siteId?: string })?.siteId;
    if (!siteId) return;
    await deps.buildDispatcher().dispatchSite(siteId);
  });

  const interval = setInterval(async () => {
    try {
      const sites = await deps.subscriptions.listActiveSiteIds();
      const dispatcher = deps.buildDispatcher();
      for (const siteId of sites) {
        await dispatcher.dispatchSite(siteId);
        await deps.prune?.(siteId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cdc-dispatch] sweep failed:', err instanceof Error ? err.message : err);
    }
  }, deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  // Don't hold the process open just for the sweep.
  (interval as unknown as { unref?: () => void }).unref?.();

  return () => clearInterval(interval);
}
