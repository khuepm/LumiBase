/**
 * Persistence for resumable upload sessions (#704). Site-scoped, except
 * `expiredAcrossSites`, which the system sweeper uses.
 */
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { uploadSessions, type Database } from '@lumibase/database';
import type { MultipartPart } from '@lumibase/runtime';

export type UploadSession = typeof uploadSessions.$inferSelect;
export type UploadSessionInsert = Omit<
  UploadSession,
  'siteId' | 'createdAt' | 'updatedAt' | 'offset' | 'parts' | 'tailSize' | 'status' | 'lockToken' | 'lockedUntil' | 'fileId'
>;

/** Fields a committed PATCH advances. */
export interface ProgressPatch {
  offset: number;
  parts: MultipartPart[];
  tailSize: number;
  expiresAt: Date;
}

export interface UploadSessionRepository {
  readonly siteId: string;
  create(row: UploadSessionInsert): Promise<UploadSession>;
  get(id: string): Promise<UploadSession | null>;
  /**
   * Take the single-writer lease, only while the session is active, still at
   * `expectedOffset` and not leased by someone else (or the lease expired).
   * Atomic: the conditional UPDATE is the lock.
   */
  claim(id: string, expectedOffset: number, token: string, until: Date, now: Date): Promise<UploadSession | null>;
  /** Advance progress and release the lease, only if the caller still holds it. */
  commit(id: string, token: string, patch: ProgressPatch): Promise<UploadSession | null>;
  release(id: string, token: string): Promise<void>;
  finish(id: string, patch: { status: 'completed' | 'aborted'; fileId?: string | null }): Promise<UploadSession | null>;
}

export class DrizzleUploadSessionRepository implements UploadSessionRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  private scope(id: string) {
    return and(eq(uploadSessions.siteId, this.siteId), eq(uploadSessions.id, id));
  }

  async create(row: UploadSessionInsert): Promise<UploadSession> {
    const [inserted] = await this.db.insert(uploadSessions).values({ ...row, siteId: this.siteId }).returning();
    if (!inserted) throw new Error('upload session insert returned no row');
    return inserted;
  }

  async get(id: string): Promise<UploadSession | null> {
    const [row] = await this.db.select().from(uploadSessions).where(this.scope(id)).limit(1);
    return row ?? null;
  }

  async claim(id: string, expectedOffset: number, token: string, until: Date, now: Date): Promise<UploadSession | null> {
    const [row] = await this.db
      .update(uploadSessions)
      .set({ lockToken: token, lockedUntil: until })
      .where(
        and(
          this.scope(id),
          eq(uploadSessions.status, 'active'),
          eq(uploadSessions.offset, expectedOffset),
          or(isNull(uploadSessions.lockedUntil), lt(uploadSessions.lockedUntil, now)),
        ),
      )
      .returning();
    return row ?? null;
  }

  async commit(id: string, token: string, patch: ProgressPatch): Promise<UploadSession | null> {
    const [row] = await this.db
      .update(uploadSessions)
      .set({ ...patch, lockToken: null, lockedUntil: null, updatedAt: new Date() })
      .where(and(this.scope(id), eq(uploadSessions.lockToken, token)))
      .returning();
    return row ?? null;
  }

  async release(id: string, token: string): Promise<void> {
    await this.db
      .update(uploadSessions)
      .set({ lockToken: null, lockedUntil: null })
      .where(and(this.scope(id), eq(uploadSessions.lockToken, token)));
  }

  async finish(id: string, patch: { status: 'completed' | 'aborted'; fileId?: string | null }): Promise<UploadSession | null> {
    const [row] = await this.db
      .update(uploadSessions)
      .set({ status: patch.status, fileId: patch.fileId ?? null, lockToken: null, lockedUntil: null, updatedAt: new Date() })
      .where(this.scope(id))
      .returning();
    return row ?? null;
  }
}

/** System sweeper: active sessions past expiry, across every site (oldest first). */
export async function expiredSessionsAcrossSites(db: Database, now: Date, limit: number): Promise<UploadSession[]> {
  return db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.status, 'active'), lt(uploadSessions.expiresAt, now)))
    .orderBy(asc(uploadSessions.expiresAt))
    .limit(limit);
}

/** Mark one expired session aborted (system sweeper; guarded on still being active). */
export async function abortExpiredSession(db: Database, siteId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(uploadSessions)
    .set({ status: 'aborted', lockToken: null, lockedUntil: null, updatedAt: sql`now()` })
    .where(and(eq(uploadSessions.siteId, siteId), eq(uploadSessions.id, id), eq(uploadSessions.status, 'active')))
    .returning({ id: uploadSessions.id });
  return rows.length > 0;
}
