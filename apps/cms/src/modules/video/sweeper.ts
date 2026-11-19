/**
 * Video pipeline backstop (#871). Submissions and webhooks drive the happy
 * path; this sweep catches everything else, every five minutes:
 *
 * - `uploaded` rows: submit (waited on a scan, a retryable provider error, a
 *   lost background task, or a missing public URL that is now set);
 * - `processing` rows with a provider asset: poll its status (lost webhook);
 * - `processing` rows without one: the submit died between claim and
 *   response, so after a grace period they are queued again;
 * - `processing` for longer than a day: failed (timed out).
 *
 * It reads across sites on purpose (a system job, like the retention sweeps)
 * and then works per site with that site's repositories and settings. Every
 * write is a compare-and-set, so an overlapping Workers invocation is safe.
 */
import { formatSafeError } from '@lumibase/contracts/utils';
import type { Database } from '@lumibase/database';
import { AuditLogger } from '../audit/logger';
import { loadDamSettings } from '../../services/files/dam-settings';
import { DrizzleFileRepository } from '../../services/files/file-repository';
import { publicOriginFromEnv, sourceSecretFromEnv, videoProviderFromEnv } from './config';
import type { VideoProvider } from './provider';
import { sourceUrlBuilder } from './source-url';
import { pollVideo, submitVideo, type VideoJobDeps } from './video-job';
import { DrizzleVideoAssetRepository, staleVideoAssetsAcrossSites, type VideoAssetRecord } from './video-repo';

export const SUBMIT_GRACE_MS = 2 * 60 * 1000;
export const POLL_AFTER_MS = 10 * 60 * 1000;
export const ORPHANED_SUBMIT_MS = 30 * 60 * 1000;
export const PROCESSING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const SWEEP_LIMIT = 50;

export interface VideoSweepDeps {
  db: Database;
  env?: Record<string, unknown>;
  /** Override the env-built provider (tests). */
  provider?: VideoProvider | null;
  now?: () => Date;
  limit?: number;
}

export interface VideoSweepSummary {
  submitted: number;
  polled: number;
  requeued: number;
  timedOut: number;
  errors: number;
}

export async function sweepVideos(deps: VideoSweepDeps): Promise<VideoSweepSummary> {
  const summary: VideoSweepSummary = { submitted: 0, polled: 0, requeued: 0, timedOut: 0, errors: 0 };
  const provider = deps.provider !== undefined ? deps.provider : videoProviderFromEnv(deps.env);
  if (!provider) return summary;
  const now = deps.now?.() ?? new Date();
  const rows = await staleVideoAssetsAcrossSites(deps.db, new Date(now.getTime() - SUBMIT_GRACE_MS), deps.limit ?? SWEEP_LIMIT);
  const bySite = new Map<string, VideoAssetRecord[]>();
  for (const row of rows) bySite.set(row.siteId, [...(bySite.get(row.siteId) ?? []), row]);

  const secret = sourceSecretFromEnv(deps.env);
  const origin = publicOriginFromEnv(deps.env);

  for (const [siteId, assets] of bySite) {
    const settings = await loadDamSettings(deps.db, siteId);
    if (!settings.video.enabled) continue;
    const videos = new DrizzleVideoAssetRepository(deps.db, siteId);
    const job: VideoJobDeps = {
      repo: new DrizzleFileRepository(deps.db, siteId),
      videos,
      provider,
      settings,
      sourceUrl: sourceUrlBuilder({ secret, origin, siteId, now: () => now.getTime() }),
      now: () => now,
      audit: async (entry) => {
        await new AuditLogger({ db: deps.db, siteId }).write({ event: entry.event, metadata: { ...entry } });
      },
    };
    for (const asset of assets) {
      try {
        if (asset.provider !== provider.name) continue;
        if (asset.status === 'uploaded') {
          const { outcome } = await submitVideo(job, asset.fileId);
          if (outcome === 'submitted') summary.submitted++;
          continue;
        }
        const submittedAt = asset.submittedAt?.getTime() ?? asset.updatedAt.getTime();
        if (now.getTime() - submittedAt > PROCESSING_TIMEOUT_MS) {
          const failed = await videos.update(
            asset.fileId,
            { status: 'failed', error: 'Timed out: the provider did not finish within 24 hours.' },
            { status: 'processing', fileVersion: asset.fileVersion },
          );
          if (failed) summary.timedOut++;
          continue;
        }
        if (!asset.providerAssetId) {
          if (now.getTime() - submittedAt > ORPHANED_SUBMIT_MS) {
            const requeued = await videos.update(
              asset.fileId,
              { status: 'uploaded', error: 'The submission was interrupted; queued again.' },
              { status: 'processing', fileVersion: asset.fileVersion, attempts: asset.attempts },
            );
            if (requeued) summary.requeued++;
          }
          continue;
        }
        if (now.getTime() - submittedAt > POLL_AFTER_MS) {
          await pollVideo(job, asset);
          summary.polled++;
        }
      } catch (err) {
        summary.errors++;
        console.warn('[video-sweep] asset failed', siteId, asset.fileId, formatSafeError(err));
      }
    }
  }
  return summary;
}
