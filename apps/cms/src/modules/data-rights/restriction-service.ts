/**
 * Restriction of processing (GDPR Art. 18).
 *
 * Records whether a user has asked that processing of their data be limited to
 * mere storage. Other services consult {@link RestrictionService.isRestricted}
 * before processing the user's data (e.g. marketing sends, agent runs).
 */

import type { Database } from '@lumibase/database';
import { processingRestrictions } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

export interface RestrictionServiceDeps {
  db: Database;
  now?: () => Date;
}

type RestrictionRow = typeof processingRestrictions.$inferSelect;

export class RestrictionService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: RestrictionServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  /** Current restriction record for a user, or null if none. */
  async get(params: { siteId: string; userId: string }): Promise<RestrictionRow | null> {
    const [row] = await this.db
      .select()
      .from(processingRestrictions)
      .where(
        and(
          eq(processingRestrictions.siteId, params.siteId),
          eq(processingRestrictions.userId, params.userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** True when processing is currently restricted for the user. */
  async isRestricted(params: { siteId: string; userId: string }): Promise<boolean> {
    const row = await this.get(params);
    return row?.restricted ?? false;
  }

  /** Set (upsert) the restriction state. */
  async set(params: {
    siteId: string;
    userId: string;
    restricted: boolean;
    reason?: string;
  }): Promise<RestrictionRow> {
    const now = this.now();
    const [row] = await this.db
      .insert(processingRestrictions)
      .values({
        siteId: params.siteId,
        userId: params.userId,
        restricted: params.restricted,
        reason: params.reason ?? null,
      })
      .onConflictDoUpdate({
        target: [processingRestrictions.siteId, processingRestrictions.userId],
        set: { restricted: params.restricted, reason: params.reason ?? null, updatedAt: now },
      })
      .returning();
    return row!;
  }
}
