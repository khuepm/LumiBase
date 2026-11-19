import type { VideoAssetGuard, VideoAssetPatch, VideoAssetRecord, VideoAssetRepository, QueueInput } from '../video-repo';
import type {
  PlaybackTarget,
  PlaybackUrls,
  ProviderAssetStatus,
  SubmitInput,
  SubmitResult,
  VideoProvider,
  VideoWebhookEvent,
} from '../provider';
import { VideoProviderError } from '../provider';

/** In-memory twin of `DrizzleVideoAssetRepository` (compare-and-set semantics included). */
export class MemoryVideoAssetRepository implements VideoAssetRepository {
  rows = new Map<string, VideoAssetRecord>();
  private seq = 0;

  constructor(readonly siteId: string) {}

  async get(fileId: string) {
    const r = this.rows.get(fileId);
    return r ? { ...r } : null;
  }

  async queue(input: QueueInput) {
    const previous = this.rows.get(input.fileId);
    const now = new Date();
    const asset: VideoAssetRecord = {
      id: previous?.id ?? `va_${++this.seq}`,
      siteId: this.siteId,
      fileId: input.fileId,
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
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(input.fileId, asset);
    return { asset: { ...asset }, previousProviderAssetId: previous?.providerAssetId ?? null };
  }

  async update(fileId: string, patch: VideoAssetPatch, guard: VideoAssetGuard = {}) {
    const r = this.rows.get(fileId);
    if (!r) return null;
    if (guard.status !== undefined && r.status !== guard.status) return null;
    if (guard.fileVersion !== undefined && r.fileVersion !== guard.fileVersion) return null;
    if (guard.attempts !== undefined && r.attempts !== guard.attempts) return null;
    const next = { ...r, ...patch, updatedAt: new Date() } as VideoAssetRecord;
    this.rows.set(fileId, next);
    return { ...next };
  }
}

/** Scriptable provider double. */
export class FakeVideoProvider implements VideoProvider {
  readonly name: string;
  submitted: SubmitInput[] = [];
  removed: string[] = [];
  failSubmits = 0;
  statusById = new Map<string, ProviderAssetStatus>();
  webhookEvent: VideoWebhookEvent | null = null;
  rejectWebhook = false;
  private seq = 0;

  constructor(name = 'fake') {
    this.name = name;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    if (this.failSubmits > 0) {
      this.failSubmits--;
      throw new VideoProviderError('provider down', 503);
    }
    this.submitted.push(input);
    const id = `pa_${++this.seq}`;
    return { providerAssetId: id, playbackId: `pb_${this.seq}` };
  }

  async status(id: string): Promise<ProviderAssetStatus> {
    return this.statusById.get(id) ?? { state: 'processing' };
  }

  async verifyWebhook(): Promise<VideoWebhookEvent | null> {
    if (this.rejectWebhook) {
      const { VideoWebhookError } = await import('../provider');
      throw new VideoWebhookError('bad signature');
    }
    return this.webhookEvent;
  }

  async playback(target: PlaybackTarget, expiresAt: Date): Promise<PlaybackUrls> {
    const suffix = target.signed ? `?token=signed-${expiresAt.getTime()}` : '';
    return {
      hls: `https://play.example/${target.playbackId ?? target.providerAssetId}.m3u8${suffix}`,
      poster: `https://play.example/${target.playbackId ?? target.providerAssetId}.jpg${suffix}`,
      expiresAt: target.signed ? expiresAt : null,
    };
  }

  async remove(id: string): Promise<void> {
    this.removed.push(id);
  }
}
