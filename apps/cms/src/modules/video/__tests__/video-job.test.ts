/**
 * Video pipeline state machine (#871): queue → wait for the scan → submit →
 * webhook/poll → ready (metadata mirrored onto the file) or failed; retries
 * with a cap; replace re-queues and drops the old provider asset; a late
 * event for an older version or another asset never overwrites the current
 * one; signed source tokens.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DAM_SETTINGS, type DamSettings } from '../../../services/files/dam-settings';
import { MemoryFileRepository } from '../../../services/files/__tests__/memory-repo';
import { parsePassthrough, passthroughFor, signSourceToken, verifySourceToken } from '../source-token';
import { sourceUrlBuilder } from '../source-url';
import {
  applyWebhookEvent,
  isVideoEligible,
  MAX_SUBMIT_ATTEMPTS,
  pollVideo,
  queueVideo,
  retryVideo,
  submitVideo,
  type VideoAuditEntry,
  type VideoJobDeps,
} from '../video-job';
import { FakeVideoProvider, MemoryVideoAssetRepository } from './helpers';

const SITE = 'site_v';
const on: DamSettings = { ...DEFAULT_DAM_SETTINGS, video: { enabled: true, signedPlayback: true, playbackTtlSeconds: 3600 } };

function setup(settings: DamSettings = on) {
  const repo = new MemoryFileRepository(SITE);
  const videos = new MemoryVideoAssetRepository(SITE);
  const provider = new FakeVideoProvider();
  const audits: VideoAuditEntry[] = [];
  const deps: VideoJobDeps = {
    repo,
    videos,
    provider,
    settings,
    sourceUrl: async (id, v) => `https://cms.example/api/v1/video/source/${id}@${v}`,
    audit: async (e) => void audits.push(e),
  };
  const file = repo.seed({ id: 'f1', filenameDisk: 'sites/site_v/clip.mp4', filenameDownload: 'clip.mp4', mime: 'video/mp4', version: 1 });
  return { repo, videos, provider, audits, deps, file };
}

describe('eligibility', () => {
  it('needs the site switch, a provider and a video/* MIME', () => {
    const { deps } = setup();
    expect(isVideoEligible(deps, { mime: 'video/quicktime' })).toBe(true);
    expect(isVideoEligible(deps, { mime: 'image/png' })).toBe(false);
    expect(isVideoEligible({ ...deps, provider: null }, { mime: 'video/mp4' })).toBe(false);
    expect(isVideoEligible({ ...deps, settings: DEFAULT_DAM_SETTINGS }, { mime: 'video/mp4' })).toBe(false);
  });
});

describe('uploaded → processing → ready', () => {
  it('submits once servable, then a webhook makes it ready and fills the file metadata', async () => {
    const { deps, file, provider, videos, repo, audits } = setup();
    await repo.update(file.id, { scanStatus: 'pending' });
    expect((await queueVideo(deps, { ...file, scanStatus: 'pending' }))!.status).toBe('uploaded');
    expect((await submitVideo(deps, file.id)).outcome).toBe('waiting_scan');
    expect(provider.submitted).toHaveLength(0);

    await repo.update(file.id, { scanStatus: 'clean' });
    const sub = await submitVideo(deps, file.id);
    expect(sub.outcome).toBe('submitted');
    expect(sub.asset).toMatchObject({ status: 'processing', providerAssetId: 'pa_1', playbackId: 'pb_1', attempts: 1 });
    expect(provider.submitted[0]).toMatchObject({ passthrough: 'site_v:f1:1', signedPlayback: true, name: 'clip.mp4', sourceUrl: 'https://cms.example/api/v1/video/source/f1@1' });

    const outcome = await applyWebhookEvent(deps, {
      providerAssetId: 'pa_1',
      passthrough: 'site_v:f1:1',
      status: { state: 'ready', durationMs: 61_400, width: 1920, height: 1080, renditions: [{ width: 640, height: 360 }] },
    });
    expect(outcome).toBe('applied');
    expect(await videos.get(file.id)).toMatchObject({ status: 'ready', durationMs: 61_400, width: 1920, height: 1080, renditions: [{ width: 640, height: 360 }] });
    expect(await repo.get(file.id)).toMatchObject({ width: 1920, height: 1080, duration: 61 });
    expect(audits.map((a) => a.event)).toEqual(['video_ready']);
  });

  it('an infected or errored scan fails the video without calling the provider', async () => {
    const { deps, file, provider, repo } = setup();
    await queueVideo(deps, file);
    await repo.update(file.id, { scanStatus: 'infected' });
    expect((await submitVideo(deps, file.id)).asset).toMatchObject({ status: 'failed', error: expect.stringMatching(/infected/) });
    expect(provider.submitted).toHaveLength(0);
  });

  it('without a public URL the row stays queued with a reason, then submits once it exists', async () => {
    const { deps, file } = setup();
    await queueVideo(deps, file);
    const res = await submitVideo({ ...deps, sourceUrl: async () => null }, file.id);
    expect(res).toMatchObject({ outcome: 'no_source_url', asset: { status: 'uploaded', error: expect.stringMatching(/LUMIBASE_PUBLIC_URL/) } });
    expect((await submitVideo(deps, file.id)).outcome).toBe('submitted');
  });

  it('a provider failure is reported and recorded', async () => {
    const { deps, file, videos, audits } = setup();
    await queueVideo(deps, file);
    await submitVideo(deps, file.id);
    expect(await applyWebhookEvent(deps, { providerAssetId: 'pa_1', passthrough: 'site_v:f1:1', status: { state: 'failed', error: 'codec' } })).toBe('applied');
    expect(await videos.get(file.id)).toMatchObject({ status: 'failed', error: 'codec' });
    expect(audits).toEqual([expect.objectContaining({ event: 'video_failed', error: 'codec' })]);
  });

  it('polls when the webhook never came', async () => {
    const { deps, file, provider, videos } = setup();
    await queueVideo(deps, file);
    const { asset } = await submitVideo(deps, file.id);
    expect(await pollVideo(deps, asset!)).toMatchObject({ status: 'processing' });
    provider.statusById.set('pa_1', { state: 'ready', renditions: [] });
    await pollVideo(deps, (await videos.get(file.id))!);
    expect((await videos.get(file.id))!.status).toBe('ready');
  });
});

describe('retries', () => {
  it(`retries a failing submit and gives up after ${MAX_SUBMIT_ATTEMPTS} attempts`, async () => {
    const { deps, file, provider, videos, audits } = setup();
    provider.failSubmits = 99;
    await queueVideo(deps, file);
    for (let i = 1; i < MAX_SUBMIT_ATTEMPTS; i++) {
      expect((await submitVideo(deps, file.id)).outcome).toBe('retry');
      expect(await videos.get(file.id)).toMatchObject({ status: 'uploaded', attempts: i, error: expect.stringMatching(/provider down/) });
    }
    expect((await submitVideo(deps, file.id)).outcome).toBe('failed');
    expect((await videos.get(file.id))!.status).toBe('failed');
    expect(audits.map((a) => a.event)).toEqual(['video_failed']);

    // A manual retry starts over.
    provider.failSubmits = 0;
    expect(await retryVideo(deps, (await deps.repo.get(file.id))!)).toMatchObject({ outcome: 'submitted', asset: { status: 'processing', attempts: 1 } });
  });

  it('two concurrent submits claim once', async () => {
    const { deps, file, provider } = setup();
    await queueVideo(deps, file);
    const outcomes = await Promise.all([submitVideo(deps, file.id), submitVideo(deps, file.id)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['not_queued', 'submitted']);
    expect(provider.submitted).toHaveLength(1);
  });
});

describe('versions and late events', () => {
  it('a replace re-queues, removes the old provider asset and ignores the old version’s webhook', async () => {
    const { deps, file, provider, videos, repo } = setup();
    await queueVideo(deps, file);
    await submitVideo(deps, file.id);
    const v2 = (await repo.update(file.id, { version: 2 }))!;
    expect((await queueVideo(deps, v2))!).toMatchObject({ status: 'uploaded', fileVersion: 2, providerAssetId: null });
    expect(provider.removed).toEqual(['pa_1']);

    const late = { providerAssetId: 'pa_1', passthrough: 'site_v:f1:1', status: { state: 'ready' as const, renditions: [] } };
    expect(await applyWebhookEvent(deps, late)).toBe('ignored');
    await submitVideo(deps, file.id);
    expect(await applyWebhookEvent(deps, { ...late, passthrough: 'site_v:f1:2' })).toBe('ignored'); // wrong asset id
    expect(await applyWebhookEvent(deps, { ...late, providerAssetId: 'pa_2', passthrough: 'site_v:f1:2' })).toBe('applied');
    expect(await videos.get(file.id)).toMatchObject({ status: 'ready', fileVersion: 2 });
  });

  it('ignores events for another site, an unknown file, or a row that is not processing', async () => {
    const { deps, file } = setup();
    await queueVideo(deps, file);
    const ev = { providerAssetId: 'pa_1', passthrough: 'other:f1:1', status: { state: 'ready' as const, renditions: [] } };
    expect(await applyWebhookEvent(deps, ev)).toBe('ignored');
    expect(await applyWebhookEvent(deps, { ...ev, passthrough: 'site_v:nope:1' })).toBe('ignored');
    expect(await applyWebhookEvent(deps, { ...ev, passthrough: 'site_v:f1:1' })).toBe('ignored'); // still `uploaded`
    expect(await applyWebhookEvent(deps, { ...ev, passthrough: null })).toBe('ignored');
  });

  it('a webhook that beats the submit response attaches its asset id', async () => {
    const { deps, file, videos } = setup();
    await queueVideo(deps, file);
    await videos.update(file.id, { status: 'processing', attempts: 1 });
    expect(await applyWebhookEvent(deps, { providerAssetId: 'early', passthrough: 'site_v:f1:1', status: { state: 'ready', renditions: [] } })).toBe('applied');
    expect(await videos.get(file.id)).toMatchObject({ providerAssetId: 'early', status: 'ready' });
  });

  it('does not overwrite file metadata when the file moved to a newer version meanwhile', async () => {
    const { deps, file, repo } = setup();
    await queueVideo(deps, file);
    await submitVideo(deps, file.id);
    await repo.update(file.id, { version: 2, width: 10 });
    await applyWebhookEvent(deps, { providerAssetId: 'pa_1', passthrough: 'site_v:f1:1', status: { state: 'ready', width: 1920, height: 1080, renditions: [] } });
    expect((await repo.get(file.id))!.width).toBe(10);
  });
});

describe('source tokens', () => {
  it('round-trips, expires, and rejects tampering or another secret', async () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    const claims = { siteId: 's', fileId: 'f', version: 3, exp: now + 1000 };
    const token = await signSourceToken('secret', claims);
    expect(await verifySourceToken('secret', token, now)).toEqual(claims);
    expect(await verifySourceToken('secret', token, now + 2000)).toBeNull();
    expect(await verifySourceToken('other', token, now)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ s: 's', f: 'g', v: 3, e: now + 1000 })).replace(/=+$/, '');
    expect(await verifySourceToken('secret', `${forged}.${sig}`, now)).toBeNull();
    expect(await verifySourceToken('secret', `${payload}`, now)).toBeNull();
  });

  it('the URL builder yields nothing without a secret or an origin', async () => {
    expect(await sourceUrlBuilder({ secret: null, origin: 'https://cms', siteId: 's' })('f', 1)).toBeNull();
    expect(await sourceUrlBuilder({ secret: 'x', origin: null, siteId: 's' })('f', 1)).toBeNull();
    expect(await sourceUrlBuilder({ secret: 'x', origin: 'https://cms', siteId: 's' })('f', 1)).toMatch(/^https:\/\/cms\/api\/v1\/video\/source\/[^/]+\.[0-9a-f]{64}$/);
  });

  it('passthrough round-trips for any ids without a colon', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
        fc.integer({ min: 1, max: 1_000_000 }),
        (site, file, version) => {
          expect(parsePassthrough(passthroughFor(site, file, version))).toEqual({ siteId: site, fileId: file, version });
        },
      ),
    );
  });
});
