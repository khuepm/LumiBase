/**
 * The video pipeline's state machine (#871):
 *
 *   uploaded ──submit──▶ processing ──webhook / poll──▶ ready
 *       ▲                    │                              │
 *       └──retryable error───┘──provider error──▶ failed ◀──┘ (never)
 *
 * A row is tied to the file `version` it was queued for. A replace re-queues
 * it (dropping the old provider asset), and every write is a compare-and-set
 * on (status, version), so a late webhook for an older version can never
 * overwrite the current one. Nothing is submitted until the malware scan
 * (#707) says the file is servable.
 */
import { isServable } from '../malware-scan';
import type { DamSettings } from '../../services/files/dam-settings';
import type { FileRecord, FileRepository } from '../../services/files/file-repository';
import type { ProviderAssetStatus, VideoProvider, VideoWebhookEvent } from './provider';
import { passthroughFor, parsePassthrough } from './source-token';
import type { VideoAssetRecord, VideoAssetRepository } from './video-repo';

/** A submit that keeps failing is given up on after this many attempts. */
export const MAX_SUBMIT_ATTEMPTS = 5;

export interface VideoAuditEntry {
  event: 'video_ready' | 'video_failed';
  fileId: string;
  version: number;
  provider: string;
  providerAssetId?: string | null;
  error?: string;
}

export interface VideoJobDeps {
  repo: FileRepository;
  videos: VideoAssetRepository;
  provider: VideoProvider | null;
  settings: DamSettings;
  /** Signed URL the provider pulls `fileId@version` from; null when it cannot be built. */
  sourceUrl: (fileId: string, version: number) => Promise<string | null>;
  now?: () => Date;
  audit?: (entry: VideoAuditEntry) => Promise<void>;
}

export function isVideoMime(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('video/');
}

/** Whether `file` goes through the pipeline for this site + deployment. */
export function isVideoEligible(deps: Pick<VideoJobDeps, 'provider' | 'settings'>, file: Pick<FileRecord, 'mime'>): boolean {
  return Boolean(deps.settings.video.enabled && deps.provider && isVideoMime(file.mime));
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

/**
 * Queue (or re-queue after a replace) a video file. Deletes the provider
 * asset of the previous version, best effort. Null when the file is not
 * eligible.
 */
export async function queueVideo(deps: VideoJobDeps, file: FileRecord): Promise<VideoAssetRecord | null> {
  if (!isVideoEligible(deps, file)) return null;
  const { asset, previousProviderAssetId } = await deps.videos.queue({
    fileId: file.id,
    fileVersion: file.version,
    provider: deps.provider!.name,
    signedPlayback: deps.settings.video.signedPlayback,
  });
  if (previousProviderAssetId) await deps.provider!.remove(previousProviderAssetId).catch(() => undefined);
  return asset;
}

export type SubmitOutcome =
  | 'submitted'
  | 'waiting_scan'
  | 'not_queued'
  | 'stale'
  | 'no_source_url'
  | 'retry'
  | 'failed'
  | 'disabled';

/** Send a queued file to the provider. Safe to call concurrently: one caller wins the claim. */
export async function submitVideo(deps: VideoJobDeps, fileId: string): Promise<{ outcome: SubmitOutcome; asset: VideoAssetRecord | null }> {
  const now = deps.now?.() ?? new Date();
  if (!deps.provider || !deps.settings.video.enabled) return { outcome: 'disabled', asset: null };
  const asset = await deps.videos.get(fileId);
  if (!asset || asset.status !== 'uploaded') return { outcome: 'not_queued', asset };
  const file = await deps.repo.get(fileId);
  if (!file) return { outcome: 'not_queued', asset };
  if (file.version !== asset.fileVersion) return { outcome: 'stale', asset };

  if (!isServable(file.scanStatus)) {
    if (file.scanStatus === 'infected' || file.scanStatus === 'error') {
      const failed = await deps.videos.update(
        fileId,
        { status: 'failed', error: `Not processed: the malware scan marked the file ${file.scanStatus}.` },
        { status: 'uploaded', fileVersion: asset.fileVersion },
      );
      return { outcome: 'failed', asset: failed ?? asset };
    }
    return { outcome: 'waiting_scan', asset };
  }

  const sourceUrl = await deps.sourceUrl(fileId, file.version);
  if (!sourceUrl) {
    const updated = await deps.videos.update(
      fileId,
      { error: 'No public URL to give the video provider: set LUMIBASE_PUBLIC_URL.' },
      { status: 'uploaded', fileVersion: asset.fileVersion },
    );
    return { outcome: 'no_source_url', asset: updated ?? asset };
  }

  const claimed = await deps.videos.update(
    fileId,
    { status: 'processing', attempts: asset.attempts + 1, submittedAt: now, error: null },
    { status: 'uploaded', fileVersion: asset.fileVersion, attempts: asset.attempts },
  );
  if (!claimed) return { outcome: 'not_queued', asset };

  try {
    const result = await deps.provider.submit({
      sourceUrl,
      passthrough: passthroughFor(deps.videos.siteId, fileId, file.version),
      signedPlayback: claimed.signedPlayback,
      name: file.filenameDownload,
    });
    const updated = await deps.videos.update(
      fileId,
      { providerAssetId: result.providerAssetId, playbackId: result.playbackId ?? null },
      { fileVersion: claimed.fileVersion },
    );
    return { outcome: 'submitted', asset: updated ?? claimed };
  } catch (err) {
    const giveUp = claimed.attempts >= MAX_SUBMIT_ATTEMPTS;
    const error = errText(err);
    const updated = await deps.videos.update(
      fileId,
      { status: giveUp ? 'failed' : 'uploaded', error },
      { status: 'processing', fileVersion: claimed.fileVersion },
    );
    if (giveUp) {
      await deps.audit?.({ event: 'video_failed', fileId, version: file.version, provider: deps.provider.name, error }).catch(() => undefined);
    }
    return { outcome: giveUp ? 'failed' : 'retry', asset: updated ?? claimed };
  }
}

/** Record what the provider reported for `asset` (webhook or poll). */
export async function applyProviderStatus(
  deps: VideoJobDeps,
  asset: VideoAssetRecord,
  status: ProviderAssetStatus,
): Promise<VideoAssetRecord | null> {
  if (status.state === 'processing') return asset;
  const guard = { status: 'processing' as const, fileVersion: asset.fileVersion };
  if (status.state === 'failed') {
    const updated = await deps.videos.update(asset.fileId, { status: 'failed', error: status.error.slice(0, 1000) }, guard);
    if (updated) {
      await deps
        .audit?.({ event: 'video_failed', fileId: asset.fileId, version: asset.fileVersion, provider: asset.provider, providerAssetId: asset.providerAssetId, error: status.error })
        .catch(() => undefined);
    }
    return updated;
  }
  const now = deps.now?.() ?? new Date();
  const updated = await deps.videos.update(
    asset.fileId,
    {
      status: 'ready',
      error: null,
      playbackId: status.playbackId ?? asset.playbackId,
      durationMs: status.durationMs ?? null,
      width: status.width ?? null,
      height: status.height ?? null,
      renditions: status.renditions,
      readyAt: now,
    },
    guard,
  );
  if (!updated) return null;
  // Mirror the technical metadata onto the file, only for the version processed.
  const filePatch: { width?: number; height?: number; duration?: number } = {};
  if (status.width) filePatch.width = status.width;
  if (status.height) filePatch.height = status.height;
  if (status.durationMs) filePatch.duration = Math.round(status.durationMs / 1000);
  if (Object.keys(filePatch).length > 0) await deps.repo.update(asset.fileId, filePatch, asset.fileVersion);
  await deps
    .audit?.({ event: 'video_ready', fileId: asset.fileId, version: asset.fileVersion, provider: asset.provider, providerAssetId: updated.providerAssetId })
    .catch(() => undefined);
  return updated;
}

export type WebhookOutcome = 'applied' | 'ignored';

/**
 * Apply a verified webhook to this site's row. The passthrough names the
 * file and version; an event for another version, another provider asset or
 * a row that is not processing is ignored (late or duplicate delivery).
 */
export async function applyWebhookEvent(deps: VideoJobDeps, event: VideoWebhookEvent): Promise<WebhookOutcome> {
  const target = parsePassthrough(event.passthrough);
  if (!target || target.siteId !== deps.videos.siteId || !deps.provider) return 'ignored';
  let asset = await deps.videos.get(target.fileId);
  if (!asset || asset.provider !== deps.provider.name || asset.fileVersion !== target.version || asset.status !== 'processing') {
    return 'ignored';
  }
  if (asset.providerAssetId && asset.providerAssetId !== event.providerAssetId) return 'ignored';
  if (!asset.providerAssetId) {
    // The webhook beat the write of the submit response.
    asset = await deps.videos.update(asset.fileId, { providerAssetId: event.providerAssetId }, { status: 'processing', fileVersion: asset.fileVersion });
    if (!asset) return 'ignored';
  }
  return (await applyProviderStatus(deps, asset, event.status)) ? 'applied' : 'ignored';
}

/** Ask the provider for the status of a processing row (lost-webhook fallback). */
export async function pollVideo(deps: VideoJobDeps, asset: VideoAssetRecord): Promise<VideoAssetRecord | null> {
  if (!deps.provider || asset.status !== 'processing' || !asset.providerAssetId) return asset;
  return applyProviderStatus(deps, asset, await deps.provider.status(asset.providerAssetId));
}

/** Re-queue and submit again (Studio "Retry"). */
export async function retryVideo(deps: VideoJobDeps, file: FileRecord): Promise<{ outcome: SubmitOutcome; asset: VideoAssetRecord | null }> {
  const queued = await queueVideo(deps, file);
  if (!queued) return { outcome: 'disabled', asset: null };
  return submitVideo(deps, file.id);
}

/** Public shape of a row (no internal ids beyond what clients need). */
export function presentVideoAsset(asset: VideoAssetRecord) {
  return {
    fileId: asset.fileId,
    fileVersion: asset.fileVersion,
    provider: asset.provider,
    status: asset.status,
    error: asset.error,
    attempts: asset.attempts,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    renditions: asset.renditions,
    signedPlayback: asset.signedPlayback,
    submittedAt: asset.submittedAt,
    readyAt: asset.readyAt,
    updatedAt: asset.updatedAt,
  };
}
