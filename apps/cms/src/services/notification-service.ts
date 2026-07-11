/**
 * NotificationService — the per-user notification inbox.
 *
 * Persists a durable `notifications` row AND fans it out over realtime to the
 * recipient's live sessions. The recipient may be an admin (studio plane, keyed
 * by `users.id`) or a frontend end-user (public plane, keyed by a `subjectId`
 * such as a citizenID). Delivery is targeted — only the recipient's sessions
 * receive it — which is exactly what a per-collection broadcast cannot do.
 *
 * Offline recipients still get the row (with `pushed = false`); `pushed` flips
 * to true once realtime delivery has been attempted, and `listUndelivered()` /
 * `markPushed()` let a client replay missed notifications on (re)connect.
 */

import { and, desc, eq } from 'drizzle-orm';
import { notifications, type Database } from '@lumibase/database';
import type { RealtimeProvider, RealtimeEventLike } from '@lumibase/runtime';

export type NotificationPlane = 'studio' | 'public';

export interface CreateNotificationInput {
  /** users.id (studio) or subjectId (public). */
  recipient: string;
  /** Which plane the recipient lives on. Defaults to `studio`. */
  plane?: NotificationPlane;
  sender?: string | null;
  subject: string;
  message?: string | null;
  collection?: string | null;
  item?: string | null;
}

export interface NotificationServiceDeps {
  db: Database;
  siteId: string;
  /** Runtime realtime provider for fan-out. Omit to persist only. */
  realtime?: RealtimeProvider;
}

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /**
   * Create a notification: persist it, then attempt realtime delivery to the
   * recipient. Returns the stored row. Realtime failure never fails the write.
   */
  async create(input: CreateNotificationInput): Promise<typeof notifications.$inferSelect> {
    const plane = input.plane ?? 'studio';

    const [row] = await this.deps.db
      .insert(notifications)
      .values({
        siteId: this.deps.siteId,
        recipient: input.recipient,
        sender: input.sender ?? null,
        subject: input.subject,
        message: input.message ?? null,
        collection: input.collection ?? null,
        item: input.item ?? null,
        // `pushed` starts false; realtime delivery flips it below.
      })
      .returning();

    if (!row) throw new Error('Failed to persist notification');

    const delivered = await this.publish(plane, input.recipient, row);
    if (delivered) {
      await this.markPushed([row.id]);
      return { ...row, pushed: true };
    }
    return row;
  }

  /** Fan-out a stored notification row to the recipient's realtime sessions. */
  private async publish(
    plane: NotificationPlane,
    recipient: string,
    row: typeof notifications.$inferSelect,
  ): Promise<boolean> {
    if (!this.deps.realtime) return false;
    const event: RealtimeEventLike = {
      type: 'notification',
      plane,
      target: plane === 'studio' ? { userId: recipient } : { subjectId: recipient },
      payload: row as unknown as Record<string, unknown>,
    };
    try {
      await this.deps.realtime.publish(this.deps.siteId, event);
      // The provider does not report per-session delivery counts, so we treat a
      // successful publish attempt as "pushed" when realtime is available.
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Notifications not yet delivered over realtime for a recipient — used to
   * replay missed items when a session (re)connects. Scoped to the site.
   */
  async listUndelivered(recipient: string, limit = 50): Promise<Array<typeof notifications.$inferSelect>> {
    return this.deps.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.siteId, this.deps.siteId),
          eq(notifications.recipient, recipient),
          eq(notifications.pushed, false),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  /** Mark notifications as delivered over realtime. Scoped to the site. */
  async markPushed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) {
      await this.deps.db
        .update(notifications)
        .set({ pushed: true })
        .where(and(eq(notifications.siteId, this.deps.siteId), eq(notifications.id, id)));
    }
  }
}
