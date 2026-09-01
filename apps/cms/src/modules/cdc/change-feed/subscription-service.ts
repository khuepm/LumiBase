/**
 * Change Feed subscription service (Req 3.1–3.5, 6.2, 6.3).
 *
 * CRUD + checkpoint lifecycle for feed consumers. Ordering/transition rules
 * are delegated to the pure helpers in `subscription-state.ts`; storage goes
 * through Drizzle; lag reads go through the `CdcEventStore` port so tests
 * stay DB-free. Route handlers translate the typed errors below into the
 * platform's `{ errors: [...] }` responses (409/403/404/400).
 */

import { and, count, desc, eq } from 'drizzle-orm';
import {
  cdcDeliveries,
  cdcSubscriptions,
  webhooks,
  type Database,
} from '@lumibase/database';
import {
  decodeCdcCursor,
  encodeCdcCursor,
  type CdcCursor,
  type CdcSubscriptionCreateInput,
  type CdcSubscriptionPatchInput,
  type CdcSubscriptionStatus,
} from '@lumibase/contracts/schemas';
import type { CdcEventStore } from './feed-reader';
import { eventKeyset } from './feed-reader';
import {
  canTransitionSubscription,
  compareKeyset,
  isAckAllowed,
} from './subscription-state';
import { invalidateFeedFlagCache } from './outbox-writer';
import type { CacheProvider } from '@lumibase/runtime';

export const MAX_SUBSCRIPTIONS_PER_SITE = 50;

export class SubscriptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Subscription "${id}" not found`);
    this.name = 'SubscriptionNotFoundError';
  }
}
export class SubscriptionNameConflictError extends Error {
  constructor(name: string) {
    super(`A subscription named "${name}" already exists for this site`);
    this.name = 'SubscriptionNameConflictError';
  }
}
export class SubscriptionLimitExceededError extends Error {
  constructor() {
    super(`Site reached the maximum of ${MAX_SUBSCRIPTIONS_PER_SITE} subscriptions`);
    this.name = 'SubscriptionLimitExceededError';
  }
}
export class WebhookSecretRequiredError extends Error {
  constructor() {
    super('kind=webhook requires a webhook with a signing secret (Req 4.2)');
    this.name = 'WebhookSecretRequiredError';
  }
}
export class AckRegressionError extends Error {
  constructor() {
    super('Ack cursor may not move backwards — use replay to rewind (Req 3.3)');
    this.name = 'AckRegressionError';
  }
}
export class InvalidTransitionError extends Error {
  constructor(from: CdcSubscriptionStatus, to: CdcSubscriptionStatus) {
    super(`Invalid status transition ${from} → ${to} — dead/stale resume only via replay`);
    this.name = 'InvalidTransitionError';
  }
}
export class ReplayOutOfRetentionError extends Error {
  constructor() {
    super('Replay target predates the retention window (Req 6.2)');
    this.name = 'ReplayOutOfRetentionError';
  }
}

export interface SubscriptionRecord {
  id: string;
  siteId: string;
  name: string;
  kind: string;
  collections: string[];
  operations: string[];
  payloadMode: string;
  cursor: string | null;
  status: CdcSubscriptionStatus;
  webhookId: string | null;
  extensionName: string | null;
  consecutiveFailures: number;
  lastDeliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Req 3.5 — events (and ms) between the checkpoint and the feed head. */
  lag: { events: number; behindMs: number | null };
}

export interface SubscriptionServiceDeps {
  db: Database;
  siteId: string;
  eventStore: CdcEventStore;
  cache?: CacheProvider;
  retentionDays: number;
  now?: () => Date;
  /** Audit sink for replay (Req 6.2); wired to AuditLogger by the routes. */
  audit?: (event: string, metadata: Record<string, unknown>) => Promise<void> | void;
}

type SubscriptionRow = typeof cdcSubscriptions.$inferSelect;

function rowCursor(row: SubscriptionRow): CdcCursor | null {
  if (!row.cursorOccurredAt || !row.cursorId) return null;
  return { occurredAtMs: row.cursorOccurredAt.getTime(), eventId: row.cursorId };
}

export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async toRecord(row: SubscriptionRow): Promise<SubscriptionRecord> {
    const cursor = rowCursor(row);
    const [events, head] = await Promise.all([
      this.deps.eventStore.countAfter(this.deps.siteId, cursor),
      this.deps.eventStore.latest(this.deps.siteId),
    ]);
    // behindMs is only meaningful once a checkpoint exists; before the first
    // ack/delivery the backlog is conveyed by `events` alone (Req 3.5).
    const behindMs =
      head && cursor ? Math.max(0, head.occurredAt.getTime() - cursor.occurredAtMs) : null;
    return {
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      kind: row.kind,
      collections: (row.collections as string[]) ?? [],
      operations: (row.operations as string[]) ?? [],
      payloadMode: row.payloadMode,
      cursor: cursor ? encodeCdcCursor(cursor) : null,
      status: row.status as CdcSubscriptionStatus,
      webhookId: row.webhookId,
      extensionName: row.extensionName,
      consecutiveFailures: row.consecutiveFailures,
      lastDeliveredAt: row.lastDeliveredAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lag: { events, behindMs },
    };
  }

  private async getRow(id: string): Promise<SubscriptionRow> {
    const [row] = await this.deps.db
      .select()
      .from(cdcSubscriptions)
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .limit(1);
    if (!row) throw new SubscriptionNotFoundError(id);
    return row;
  }

  async create(input: CdcSubscriptionCreateInput): Promise<SubscriptionRecord> {
    const [countRow] = await this.deps.db
      .select({ n: count() })
      .from(cdcSubscriptions)
      .where(eq(cdcSubscriptions.siteId, this.deps.siteId));
    if (Number(countRow?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_SITE) {
      throw new SubscriptionLimitExceededError();
    }

    const [existing] = await this.deps.db
      .select({ id: cdcSubscriptions.id })
      .from(cdcSubscriptions)
      .where(
        and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.name, input.name)),
      )
      .limit(1);
    if (existing) throw new SubscriptionNameConflictError(input.name);

    if (input.kind === 'webhook') {
      const [hook] = await this.deps.db
        .select({ secret: webhooks.secret })
        .from(webhooks)
        .where(and(eq(webhooks.siteId, this.deps.siteId), eq(webhooks.id, input.webhook_id!)))
        .limit(1);
      if (!hook?.secret) throw new WebhookSecretRequiredError();
    }

    const [row] = await this.deps.db
      .insert(cdcSubscriptions)
      .values({
        siteId: this.deps.siteId,
        name: input.name,
        kind: input.kind,
        collections: input.collections,
        operations: input.operations,
        payloadMode: input.payload_mode,
        webhookId: input.webhook_id ?? null,
        extensionName: input.extension_name ?? null,
      })
      .returning();
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    await this.deps.audit?.('cdc_subscription_created', {
      subscriptionId: row!.id,
      name: input.name,
      kind: input.kind,
    });
    return this.toRecord(row!);
  }

  async list(): Promise<SubscriptionRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(cdcSubscriptions)
      .where(eq(cdcSubscriptions.siteId, this.deps.siteId))
      .orderBy(desc(cdcSubscriptions.createdAt));
    return Promise.all(rows.map((r) => this.toRecord(r)));
  }

  async get(id: string): Promise<SubscriptionRecord> {
    return this.toRecord(await this.getRow(id));
  }

  async patch(id: string, input: CdcSubscriptionPatchInput): Promise<SubscriptionRecord> {
    const row = await this.getRow(id);
    if (input.status && input.status !== row.status) {
      if (
        !canTransitionSubscription(row.status as CdcSubscriptionStatus, input.status, 'admin')
      ) {
        throw new InvalidTransitionError(row.status as CdcSubscriptionStatus, input.status);
      }
    }
    if (input.name && input.name !== row.name) {
      const [existing] = await this.deps.db
        .select({ id: cdcSubscriptions.id })
        .from(cdcSubscriptions)
        .where(
          and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.name, input.name)),
        )
        .limit(1);
      if (existing && existing.id !== id) throw new SubscriptionNameConflictError(input.name);
    }
    const [updated] = await this.deps.db
      .update(cdcSubscriptions)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.collections !== undefined ? { collections: input.collections } : {}),
        ...(input.operations !== undefined ? { operations: input.operations } : {}),
        ...(input.payload_mode !== undefined ? { payloadMode: input.payload_mode } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: this.now(),
      })
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .returning();
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    if (input.status && input.status !== row.status) {
      await this.deps.audit?.('cdc_subscription_status_changed', {
        subscriptionId: id,
        name: row.name,
        from: row.status,
        to: input.status,
      });
    }
    return this.toRecord(updated!);
  }

  async remove(id: string): Promise<void> {
    const row = await this.getRow(id);
    await this.deps.db
      .delete(cdcSubscriptions)
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)));
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    await this.deps.audit?.('cdc_subscription_deleted', {
      subscriptionId: id,
      name: row.name,
      kind: row.kind,
    });
  }

  /** Pull-consumer checkpoint commit — forward-only (Req 3.3, property P11). */
  async ack(id: string, cursorToken: string): Promise<SubscriptionRecord> {
    const next = decodeCdcCursor(cursorToken);
    if (!next) throw new AckRegressionError(); // routes map decode failure to 400 earlier
    const row = await this.getRow(id);
    const current = rowCursor(row);
    if (!isAckAllowed(current, next)) throw new AckRegressionError();
    const [updated] = await this.deps.db
      .update(cdcSubscriptions)
      .set({
        cursorOccurredAt: new Date(next.occurredAtMs),
        cursorId: next.eventId,
        lastDeliveredAt: this.now(),
        updatedAt: this.now(),
      })
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .returning();
    return this.toRecord(updated!);
  }

  /**
   * Rewind the checkpoint inside the retention window and reset the
   * subscription to `active` (the only path out of dead/stale — Req 6.2).
   */
  async replay(
    id: string,
    target: { cursor?: string; occurredAfter?: string },
    actor: { type: string; id?: string | null },
  ): Promise<SubscriptionRecord> {
    const row = await this.getRow(id);
    let next: CdcCursor;
    if (target.cursor) {
      const decoded = decodeCdcCursor(target.cursor);
      if (!decoded) throw new ReplayOutOfRetentionError();
      next = decoded;
    } else {
      // occurred_after: empty eventId sorts before every real id at that ms.
      next = { occurredAtMs: new Date(target.occurredAfter!).getTime(), eventId: '' };
    }
    const floorMs = this.now().getTime() - this.deps.retentionDays * 86_400_000;
    if (next.occurredAtMs < floorMs) throw new ReplayOutOfRetentionError();

    const current = rowCursor(row);
    const [updated] = await this.deps.db
      .update(cdcSubscriptions)
      .set({
        cursorOccurredAt: new Date(next.occurredAtMs),
        cursorId: next.eventId,
        status: 'active',
        consecutiveFailures: 0,
        updatedAt: this.now(),
      })
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .returning();
    await this.deps.audit?.('cdc_subscription_replayed', {
      subscriptionId: id,
      name: row.name,
      from: current ? encodeCdcCursor(current) : null,
      to: encodeCdcCursor(next),
      previousStatus: row.status,
      actorType: actor.type,
      actorId: actor.id ?? null,
    });
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    return this.toRecord(updated!);
  }

  /** Delivery-attempt history, newest first (Req 8.1). */
  async listDeliveries(
    id: string,
    opts: { limit?: number; page?: number } = {},
  ): Promise<{ data: (typeof cdcDeliveries.$inferSelect)[]; total: number }> {
    await this.getRow(id);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const where = and(
      eq(cdcDeliveries.siteId, this.deps.siteId),
      eq(cdcDeliveries.subscriptionId, id),
    );
    const [rows, countRows] = await Promise.all([
      this.deps.db
        .select()
        .from(cdcDeliveries)
        .where(where)
        .orderBy(desc(cdcDeliveries.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.deps.db.select({ n: count() }).from(cdcDeliveries).where(where),
    ]);
    return { data: rows, total: Number(countRows[0]?.n ?? 0) };
  }
}

/** Re-exported for route/service tests. */
export { compareKeyset };
