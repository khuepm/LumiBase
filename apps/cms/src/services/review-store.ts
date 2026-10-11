/**
 * Persistence for draft review (Jev J05, #512). Every method takes the site id
 * and every query is scoped by it. The service depends on the
 * {@link ReviewStore} interface so its rules are tested without a database;
 * the Drizzle implementation is covered by `review-runs.db.integration.test.ts`.
 */

import {
  reviewFeedback,
  reviewProfiles,
  reviewRuns,
  type Database,
} from '@lumibase/database';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

export type ReviewProfileRecord = typeof reviewProfiles.$inferSelect;
export type ReviewProfileInsert = Omit<typeof reviewProfiles.$inferInsert, 'id' | 'createdAt' | 'status'> & {
  id: string;
};
export type ReviewRunRecord = typeof reviewRuns.$inferSelect;
export type ReviewRunInsert = Omit<typeof reviewRuns.$inferInsert, 'createdAt' | 'completedAt'>;
export type ReviewRunCompletion = Pick<
  ReviewRunRecord,
  'status' | 'provider' | 'model' | 'calibrated' | 'answers' | 'usage' | 'latencyMs' | 'errorCode'
>;
export type ReviewFeedbackRecord = typeof reviewFeedback.$inferSelect;
export type ReviewFeedbackInsert = Omit<typeof reviewFeedback.$inferInsert, 'createdAt'>;

export interface ReviewStore {
  /** The active version of every key, optionally limited to profiles usable on `collection`. */
  listActiveProfiles(siteId: string, collection?: string): Promise<ReviewProfileRecord[]>;
  /** A specific version, or the active one when `version` is omitted. */
  getProfile(siteId: string, key: string, version?: number): Promise<ReviewProfileRecord | null>;
  getProfileById(siteId: string, id: string): Promise<ReviewProfileRecord | null>;
  /** Version 1 of a new key. `null` when the key already exists. */
  insertFirstProfile(row: ReviewProfileInsert): Promise<ReviewProfileRecord | null>;
  /**
   * Inserts the next version and archives the active one atomically. `build`
   * receives the next version number. `'not_found'` when the key has no
   * active version; `'conflict'` when another writer won the same version.
   */
  insertNextProfileVersion(
    siteId: string,
    key: string,
    build: (version: number) => ReviewProfileInsert,
  ): Promise<ReviewProfileRecord | 'not_found' | 'conflict'>;
  /**
   * Inserts a `running` run unless `(siteId, idempotencyKey)` exists. An
   * existing run that ended in `error` is reclaimed (set back to `running`)
   * so a retry can try again without a second row. `created` is true when the
   * caller owns the run and must call the provider.
   */
  claimRun(row: ReviewRunInsert): Promise<{ run: ReviewRunRecord; created: boolean }>;
  completeRun(siteId: string, id: string, completion: ReviewRunCompletion): Promise<ReviewRunRecord | null>;
  getRun(siteId: string, id: string): Promise<ReviewRunRecord | null>;
  listRuns(siteId: string, filter: { collection: string; itemId: string; limit: number }): Promise<ReviewRunRecord[]>;
  /** ON CONFLICT DO NOTHING; then returns the stored rows for the run, principal and question keys. */
  insertFeedback(
    siteId: string,
    runId: string,
    principalId: string,
    rows: ReviewFeedbackInsert[],
  ): Promise<ReviewFeedbackRecord[]>;
}

/** Postgres `unique_violation` (23505), possibly wrapped by drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/** The store routes use. A function (not `new`) so route tests can swap in an in-memory store. */
export function reviewStoreFor(db: Database): ReviewStore {
  return new DrizzleReviewStore(db);
}

export class DrizzleReviewStore implements ReviewStore {
  constructor(private readonly db: Database) {}

  async listActiveProfiles(siteId: string, collection?: string): Promise<ReviewProfileRecord[]> {
    const rows = await this.db
      .select()
      .from(reviewProfiles)
      .where(and(eq(reviewProfiles.siteId, siteId), eq(reviewProfiles.status, 'active')))
      .orderBy(reviewProfiles.key)
      .limit(500);
    return collection === undefined
      ? rows
      : rows.filter((row) => row.collection === null || row.collection === collection);
  }

  async getProfile(siteId: string, key: string, version?: number): Promise<ReviewProfileRecord | null> {
    const [row] = await this.db
      .select()
      .from(reviewProfiles)
      .where(
        and(
          eq(reviewProfiles.siteId, siteId),
          eq(reviewProfiles.key, key),
          version === undefined ? eq(reviewProfiles.status, 'active') : eq(reviewProfiles.version, version),
        ),
      )
      .orderBy(desc(reviewProfiles.version))
      .limit(1);
    return row ?? null;
  }

  async getProfileById(siteId: string, id: string): Promise<ReviewProfileRecord | null> {
    const [row] = await this.db
      .select()
      .from(reviewProfiles)
      .where(and(eq(reviewProfiles.siteId, siteId), eq(reviewProfiles.id, id)))
      .limit(1);
    return row ?? null;
  }

  async insertFirstProfile(row: ReviewProfileInsert): Promise<ReviewProfileRecord | null> {
    const [existing] = await this.db
      .select({ id: reviewProfiles.id })
      .from(reviewProfiles)
      .where(and(eq(reviewProfiles.siteId, row.siteId), eq(reviewProfiles.key, row.key)))
      .limit(1);
    if (existing) return null;
    const [inserted] = await this.db
      .insert(reviewProfiles)
      .values({ ...row, status: 'active' })
      .onConflictDoNothing()
      .returning();
    return inserted ?? null;
  }

  async insertNextProfileVersion(
    siteId: string,
    key: string,
    build: (version: number) => ReviewProfileInsert,
  ): Promise<ReviewProfileRecord | 'not_found' | 'conflict'> {
    try {
      return await this.db.transaction(async (tx) => {
        const [active] = await tx
          .select()
          .from(reviewProfiles)
          .where(and(eq(reviewProfiles.siteId, siteId), eq(reviewProfiles.key, key), eq(reviewProfiles.status, 'active')))
          .orderBy(desc(reviewProfiles.version))
          .limit(1)
          .for('update');
        if (!active) return 'not_found' as const;
        const [latest] = await tx
          .select({ version: sql<number>`max(${reviewProfiles.version})::int` })
          .from(reviewProfiles)
          .where(and(eq(reviewProfiles.siteId, siteId), eq(reviewProfiles.key, key)));
        const next = (latest?.version ?? active.version) + 1;
        await tx
          .update(reviewProfiles)
          .set({ status: 'archived' })
          .where(and(eq(reviewProfiles.siteId, siteId), eq(reviewProfiles.key, key), eq(reviewProfiles.status, 'active')));
        const [inserted] = await tx
          .insert(reviewProfiles)
          .values({ ...build(next), status: 'active' })
          .returning();
        return inserted!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'conflict';
      throw error;
    }
  }

  async claimRun(row: ReviewRunInsert): Promise<{ run: ReviewRunRecord; created: boolean }> {
    const [inserted] = await this.db.insert(reviewRuns).values(row).onConflictDoNothing().returning();
    if (inserted) return { run: inserted, created: true };

    const scope = and(eq(reviewRuns.siteId, row.siteId), eq(reviewRuns.idempotencyKey, row.idempotencyKey));
    // A previous attempt that failed may be retried in place; the conditional
    // update lets exactly one concurrent retry win it.
    const [reclaimed] = await this.db
      .update(reviewRuns)
      .set({ status: 'running', errorCode: null, completedAt: null })
      .where(and(scope, eq(reviewRuns.status, 'error')))
      .returning();
    if (reclaimed) return { run: reclaimed, created: true };

    const [existing] = await this.db.select().from(reviewRuns).where(scope).limit(1);
    if (!existing) throw new Error('review run vanished between insert and read');
    return { run: existing, created: false };
  }

  async completeRun(siteId: string, id: string, completion: ReviewRunCompletion): Promise<ReviewRunRecord | null> {
    const [row] = await this.db
      .update(reviewRuns)
      .set({ ...completion, completedAt: new Date() })
      .where(and(eq(reviewRuns.siteId, siteId), eq(reviewRuns.id, id)))
      .returning();
    return row ?? null;
  }

  async getRun(siteId: string, id: string): Promise<ReviewRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(reviewRuns)
      .where(and(eq(reviewRuns.siteId, siteId), eq(reviewRuns.id, id)))
      .limit(1);
    return row ?? null;
  }

  async listRuns(
    siteId: string,
    filter: { collection: string; itemId: string; limit: number },
  ): Promise<ReviewRunRecord[]> {
    return this.db
      .select()
      .from(reviewRuns)
      .where(
        and(
          eq(reviewRuns.siteId, siteId),
          eq(reviewRuns.collection, filter.collection),
          eq(reviewRuns.itemId, filter.itemId),
        ),
      )
      .orderBy(desc(reviewRuns.createdAt))
      .limit(filter.limit);
  }

  async insertFeedback(
    siteId: string,
    runId: string,
    principalId: string,
    rows: ReviewFeedbackInsert[],
  ): Promise<ReviewFeedbackRecord[]> {
    if (rows.length === 0) return [];
    await this.db.insert(reviewFeedback).values(rows).onConflictDoNothing();
    return this.db
      .select()
      .from(reviewFeedback)
      .where(
        and(
          eq(reviewFeedback.siteId, siteId),
          eq(reviewFeedback.runId, runId),
          eq(reviewFeedback.principalId, principalId),
          inArray(
            reviewFeedback.questionKey,
            rows.map((row) => row.questionKey),
          ),
        ),
      );
  }
}

