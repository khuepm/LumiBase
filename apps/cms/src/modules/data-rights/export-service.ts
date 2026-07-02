/**
 * Personal-data export ("download my data") — GDPR Art. 15/20.
 *
 * Assembles the requesting user's own data on a site into a single structured
 * object. Secrets (`passwordHash`, `tfa`) are never included. Bounded per
 * collection so a pathological account can't exhaust memory; `truncated` flags
 * any list that hit its cap.
 */

import type { Database } from '@lumibase/database';
import {
  activity,
  notifications,
  revisions,
  userConsents,
  users,
} from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';

/** Max rows per list section. */
const SECTION_LIMIT = 5000;

export interface DataExport {
  exportedAt: string;
  siteId: string;
  userId: string;
  profile: Record<string, unknown> | null;
  consents: unknown[];
  activity: unknown[];
  revisionsAuthored: unknown[];
  notifications: unknown[];
  truncated: Record<string, boolean>;
}

export interface DataExportServiceDeps {
  db: Database;
  now?: () => Date;
}

export class DataExportService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: DataExportServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  async export(params: { siteId: string; userId: string }): Promise<DataExport> {
    const { siteId, userId } = params;

    const [profileRow] = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        avatar: users.avatar,
        status: users.status,
        preferences: users.preferences,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const consents = await this.db
      .select()
      .from(userConsents)
      .where(and(eq(userConsents.siteId, siteId), eq(userConsents.userId, userId)))
      .limit(SECTION_LIMIT + 1);

    const activityRows = await this.db
      .select({
        action: activity.action,
        collection: activity.collection,
        itemId: activity.itemId,
        ip: activity.ip,
        userAgent: activity.userAgent,
        comment: activity.comment,
        payload: activity.payload,
        createdAt: activity.createdAt,
      })
      .from(activity)
      .where(and(eq(activity.siteId, siteId), eq(activity.userId, userId)))
      .orderBy(desc(activity.createdAt))
      .limit(SECTION_LIMIT + 1);

    const revisionRows = await this.db
      .select({
        id: revisions.id,
        itemId: revisions.itemId,
        collectionId: revisions.collectionId,
        delta: revisions.delta,
        authorType: revisions.authorType,
        model: revisions.model,
        createdAt: revisions.createdAt,
      })
      .from(revisions)
      .where(and(eq(revisions.siteId, siteId), eq(revisions.userId, userId)))
      .orderBy(desc(revisions.createdAt))
      .limit(SECTION_LIMIT + 1);

    const notificationRows = await this.db
      .select({
        subject: notifications.subject,
        message: notifications.message,
        collection: notifications.collection,
        item: notifications.item,
        status: notifications.status,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(eq(notifications.siteId, siteId), eq(notifications.recipient, userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(SECTION_LIMIT + 1);

    const cap = <T>(rows: T[]): { rows: T[]; truncated: boolean } =>
      rows.length > SECTION_LIMIT
        ? { rows: rows.slice(0, SECTION_LIMIT), truncated: true }
        : { rows, truncated: false };

    const c = cap(consents);
    const a = cap(activityRows);
    const r = cap(revisionRows);
    const n = cap(notificationRows);

    return {
      exportedAt: this.now().toISOString(),
      siteId,
      userId,
      profile: profileRow ?? null,
      consents: c.rows,
      activity: a.rows,
      revisionsAuthored: r.rows,
      notifications: n.rows,
      truncated: {
        consents: c.truncated,
        activity: a.truncated,
        revisionsAuthored: r.truncated,
        notifications: n.truncated,
      },
    };
  }
}
