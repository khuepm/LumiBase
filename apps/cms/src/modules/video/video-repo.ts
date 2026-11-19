/**
 * Persistence for video processing state (#871). The site-scoped port is
 * what the job and routes use (tested against an in-memory double); the
 * Drizzle implementation is a thin mapping in which every query carries
 * `site_id`. The cross-site helpers at the bottom are for the sweeper only.
 */
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { videoAssets, type Database } from '@lumibase/database';
import type { VideoStatus } from './provider';

export type VideoAssetRecord = typeof videoAssets.$inferSelect;

export type VideoAssetPatch = Partial<
  Pick<
    VideoAssetRecord,
    | 'providerAssetId'
    | 'playbackId'
    | 'status'
    | 'error'
    | 'attempts'
    | 'durationMs'
    | 'width'
    | 'height'
    | 'renditions'
    | 'submittedAt'
    | 'readyAt'
  >
>;

/** Conditions a conditional update must still meet (compare-and-set). */
export interface VideoAssetGuard {
  status?: VideoStatus;
  fileVersion?: number;
  attempts?: number;
}

export interface QueueInput {
  fileId: string;
  fileVersion: number;
  provider: string;
  signedPlayback: boolean;
}

export interface VideoAssetRepository {
  readonly siteId: string;
  get(fileId: string): Promise<VideoAssetRecord | null>;
  /**
   * Create or reset the row to `uploaded` for `fileVersion`. Returns the new
   * row and the provider asset the previous row pointed at (to delete).
   */
  queue(input: QueueInput): Promise<{ asset: VideoAssetRecord; previousProviderAssetId: string | null }>;
  update(fileId: string, patch: VideoAssetPatch, guard?: VideoAssetGuard): Promise<VideoAssetRecord | null>;
}

export class DrizzleVideoAssetRepository implements VideoAssetRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  async get(fileId: string): Promise<VideoAssetRecord | null> {
    const [row] = await this.db
      .select()
      .from(videoAssets)
      .where(and(eq(videoAssets.siteId, this.siteId), eq(videoAssets.fileId, fileId)))
      .limit(1);
    return row ?? null;
  }

  async queue(input: QueueInput): Promise<{ asset: VideoAssetRecord; previousProviderAssetId: string | null }> {
    const previous = await this.get(input.fileId);
    const reset = {
      fileVersion: input.fileVersion,
      provider: input.provider,
      providerAssetId: null,
      playbackId: null,
      status: 'uploaded',
      error: null,
      attempts: 0,
      durationMs: null,
      width: null,
      height: null,
      renditions: [],
      signedPlayback: input.signedPlayback,
      submittedAt: null,
      readyAt: null,
      updatedAt: new Date(),
    };
    const [asset] = await this.db
      .insert(videoAssets)
      .values({ siteId: this.siteId, fileId: input.fileId, ...reset })
      .onConflictDoUpdate({ target: [videoAssets.siteId, videoAssets.fileId], set: reset })
      .returning();
    return { asset: asset!, previousProviderAssetId: previous?.providerAssetId ?? null };
  }

  async update(fileId: string, patch: VideoAssetPatch, guard: VideoAssetGuard = {}): Promise<VideoAssetRecord | null> {
    const conds = [eq(videoAssets.siteId, this.siteId), eq(videoAssets.fileId, fileId)];
    if (guard.status !== undefined) conds.push(eq(videoAssets.status, guard.status));
    if (guard.fileVersion !== undefined) conds.push(eq(videoAssets.fileVersion, guard.fileVersion));
    if (guard.attempts !== undefined) conds.push(eq(videoAssets.attempts, guard.attempts));
    const [row] = await this.db
      .update(videoAssets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conds))
      .returning();
    return row ?? null;
  }
}

/** Rows the sweeper should look at: queued or processing, untouched since `before`. */
export async function staleVideoAssetsAcrossSites(
  db: Database,
  before: Date,
  limit: number,
): Promise<VideoAssetRecord[]> {
  return db
    .select()
    .from(videoAssets)
    .where(
and(inArray(videoAssets.status, ['uploaded', 'processing']), lt(videoAssets.updatedAt, before)),
    )
    .orderBy(asc(videoAssets.updatedAt))
    .limit(limit);
}

