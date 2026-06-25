/**
 * Account erasure — "right to be forgotten" (GDPR Art. 17, CCPA delete, PDPD).
 *
 * Model: a request opens a grace period; when it elapses (or an admin forces
 * it) the account is **anonymized in place** rather than hard-deleted, so
 * content provenance (`items.userCreated`, `revisions.userId`, …) stays
 * referentially intact while all PII and credentials are removed. The user can
 * no longer authenticate and carries no personal data.
 *
 * Erasure is account-wide for identity/credentials (the global `users` row is
 * anonymized and all memberships/credentials dropped) and is recorded against
 * the requesting site.
 */

import type { Database } from '@lumibase/database';
import {
  adminBackupCodes,
  emailSuppressions,
  erasureRequests,
  loginBaselines,
  userPolicies,
  userRoles,
  userSites,
  users,
} from '@lumibase/database';
import { and, eq, lte } from 'drizzle-orm';
import { normalizeEmail } from '../login-guard/email-normalize';

export interface ErasureServiceDeps {
  db: Database;
  now?: () => Date;
}

export interface ErasureRequestInput {
  siteId: string;
  userId: string;
  graceDays?: number;
  requestedByType?: 'self' | 'admin';
}

type ErasureRow = typeof erasureRequests.$inferSelect;

/** Default grace period before automatic anonymization. */
export const DEFAULT_ERASURE_GRACE_DAYS = 30;

export class ErasureService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: ErasureServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  /** Open (or reopen) an erasure request with a grace-period deadline. */
  async request(input: ErasureRequestInput): Promise<ErasureRow> {
    const now = this.now();
    const graceDays = input.graceDays ?? DEFAULT_ERASURE_GRACE_DAYS;
    const scheduledAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);

    const [profile] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    const [row] = await this.db
      .insert(erasureRequests)
      .values({
        siteId: input.siteId,
        userId: input.userId,
        emailSnapshot: profile?.email ?? null,
        status: 'pending',
        requestedByType: input.requestedByType ?? 'self',
        scheduledAt,
      })
      .onConflictDoUpdate({
        target: [erasureRequests.siteId, erasureRequests.userId],
        set: {
          status: 'pending',
          requestedByType: input.requestedByType ?? 'self',
          emailSnapshot: profile?.email ?? null,
          scheduledAt,
          completedAt: null,
          updatedAt: now,
        },
      })
      .returning();
    return row!;
  }

  /** Cancel a pending request (re-subscribe to existence). */
  async cancel(params: { siteId: string; userId: string }): Promise<boolean> {
    const now = this.now();
    const updated = await this.db
      .update(erasureRequests)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          eq(erasureRequests.siteId, params.siteId),
          eq(erasureRequests.userId, params.userId),
          eq(erasureRequests.status, 'pending'),
        ),
      )
      .returning({ id: erasureRequests.id });
    return updated.length > 0;
  }

  /** Current request for a user on a site, if any. */
  async getStatus(params: { siteId: string; userId: string }): Promise<ErasureRow | null> {
    const [row] = await this.db
      .select()
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.siteId, params.siteId),
          eq(erasureRequests.userId, params.userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Anonymize the account now: drop memberships + credentials, null out PII,
   * suppress the email, and mark the request completed. Runs in a transaction.
   */
  async eraseNow(params: { siteId: string; userId: string }): Promise<{ anonymizedEmail: string }> {
    const now = this.now();
    const { siteId, userId } = params;

    const [profile] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const originalEmail = normalizeEmail(profile?.email);
    const anonymizedEmail = `erased-${userId}@erased.invalid`;

    await this.db.transaction(async (tx) => {
      // Memberships + credentials (account-wide).
      await tx.delete(userSites).where(eq(userSites.userId, userId));
      await tx.delete(userRoles).where(eq(userRoles.userId, userId));
      await tx.delete(userPolicies).where(eq(userPolicies.userId, userId));
      await tx.delete(adminBackupCodes).where(eq(adminBackupCodes.userId, userId));
      await tx.delete(loginBaselines).where(eq(loginBaselines.userId, userId));

      // Anonymize the identity in place (keeps content provenance intact).
      await tx
        .update(users)
        .set({
          email: anonymizedEmail,
          firstName: null,
          lastName: null,
          avatar: null,
          externalId: null,
          passwordHash: null,
          preferences: {},
          tfa: {},
          status: 'suspended',
          updatedAt: now,
        })
        .where(eq(users.id, userId));

      // Belt-and-suspenders: suppress the original address so nothing reaches it.
      if (originalEmail) {
        await tx
          .insert(emailSuppressions)
          .values({ siteId, emailLower: originalEmail, reason: 'manual', source: 'erasure' })
          .onConflictDoNothing({
            target: [emailSuppressions.siteId, emailSuppressions.emailLower],
          });
      }

      await tx
        .update(erasureRequests)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(
          and(eq(erasureRequests.siteId, siteId), eq(erasureRequests.userId, userId)),
        );
    });

    return { anonymizedEmail };
  }

  /**
   * Process all pending requests whose grace period has elapsed. Intended for a
   * scheduled job. Returns the userIds that were erased.
   */
  async processDue(params?: { limit?: number }): Promise<string[]> {
    const now = this.now();
    const due = await this.db
      .select({ siteId: erasureRequests.siteId, userId: erasureRequests.userId })
      .from(erasureRequests)
      .where(and(eq(erasureRequests.status, 'pending'), lte(erasureRequests.scheduledAt, now)))
      .limit(params?.limit ?? 100);

    const erased: string[] = [];
    for (const r of due) {
      await this.eraseNow({ siteId: r.siteId, userId: r.userId });
      erased.push(r.userId);
    }
    return erased;
  }
}
