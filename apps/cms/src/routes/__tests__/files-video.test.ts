/**
 * Video pipeline over HTTP (#871): a registered video is queued and submitted
 * after the response; state, retry and signed playback endpoints; provider
 * webhooks (signature, tenant from the verified payload); and the signed
 * source the provider pulls from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { DEFAULT_DAM_SETTINGS, type DamSettings } from '../../services/files/dam-settings';
import type { FilesAccess } from '../../services/files/file-access';
import type { FilesContext } from '../../services/files/files-context';
import { MemoryFileRepository, MemoryStorage } from '../../services/files/__tests__/memory-repo';
import { FakeVideoProvider, MemoryVideoAssetRepository } from '../../modules/video/__tests__/helpers';
import { signSourceToken } from '../../modules/video/source-token';

const state = vi.hoisted(() => ({
  access: null as unknown,
  repo: null as unknown,
  storage: null as unknown,
  videos: null as unknown,
  provider: null as unknown,
  settings: null as unknown,
}));

vi.mock('../../services/files/files-context', () => ({
  filesContext: async () =>
    ({
      siteId: 'site_a',
      repo: state.repo,
      storage: state.storage,
      settings: state.settings,
      usage: { find: async () => [] },
      scanner: null,
      audit: async () => undefined,
      video: {
        assets: state.videos,
        provider: state.provider,
        sourceUrl: async (id: string, v: number) => `https://cms.example/src/${id}@${v}`,
      },
    }) as unknown as FilesContext,
  resolveFilesAccess: async () => state.access as FilesAccess | null,
}));
vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => false,
}));
// Public router: the site comes from the verified payload / token.
vi.mock('../../middleware/db', () => ({ scopedDbFor: (_c: unknown, siteId: string) => ({ siteId }) }));
vi.mock('../../services/files/file-repository', () => ({
  DrizzleFileRepository: class {
    constructor(_db: unknown, siteId: string) {
      const repo = state.repo as MemoryFileRepository;
      return siteId === repo.siteId ? repo : new MemoryFileRepository(siteId);
    }
  },
}));
vi.mock('../../modules/video/video-repo', () => ({
  DrizzleVideoAssetRepository: class {
    constructor(_db: unknown, siteId: string) {
      const v = state.videos as MemoryVideoAssetRepository;
      return siteId === v.siteId ? v : new MemoryVideoAssetRepository(siteId);
    }
  },
}));
vi.mock('../../modules/audit/logger', () => ({ AuditLogger: class { async write() {} } }));

const damSettings = await import('../../services/files/dam-settings');
vi.spyOn(damSettings, 'loadDamSettings').mockImplementation(async () => state.settings as DamSettings);

const { filesRouter } = await import('../files');
const { videoPublicRouter, videoPublicDeps } = await import('../video-public');

const ctx = { userId: 'u1', siteId: 'site_a', roleId: 'editor', ip: null, headers: {} };
const member = (): FilesAccess => ({ admin: false, rule: null, ctx });
const SECRET = 'jwt_secret_for_tests';

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site_a');
    c.set('auth', { userId: 'u1', roles: ['editor'], raw: {} } as AppEnv['Variables']['auth']);
    c.set('runtime', { storage: state.storage } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  a.route('/api/v1/files', filesRouter);
  a.route('/api/v1/video', videoPublicRouter);
  return a;
}

const env = { JWT_SECRET: SECRET } as unknown as AppEnv['Bindings'];

let repo: MemoryFileRepository;
let videos: MemoryVideoAssetRepository;
let provider: FakeVideoProvider;
let storage: MemoryStorage;
const enabled: DamSettings = { ...DEFAULT_DAM_SETTINGS, video: { enabled: true, signedPlayback: true, playbackTtlSeconds: 600 } };

beforeEach(() => {
  repo = new MemoryFileRepository('site_a');
  videos = new MemoryVideoAssetRepository('site_a');
  provider = new FakeVideoProvider('mux');
  storage = new MemoryStorage();
  Object.assign(state, { access: member(), repo, storage, videos, provider, settings: enabled });
  videoPublicDeps.provider = () => provider;
  videoPublicDeps.now = () => new Date('2026-11-18T10:00:00Z');
});

const register = (a: Hono<AppEnv>, mime = 'video/mp4') =>
  a.request('/api/v1/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenameDisk: 'sites/site_a/clip.mp4', filenameDownload: 'clip.mp4', mime, filesize: 1000 }),
  });

describe('files → video pipeline', () => {
  it('a registered video is queued and submitted after the response', async () => {
    const a = app();
    const res = await register(a);
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    await vi.waitFor(async () => expect((await videos.get(id))?.status).toBe('processing'));
    expect(provider.submitted[0]).toMatchObject({ passthrough: `site_a:${id}:1`, sourceUrl: `https://cms.example/src/${id}@1`, signedPlayback: true });

    const view = await a.request(`/api/v1/files/${id}/video`);
    expect(await view.json()).toMatchObject({ data: { status: 'processing', provider: 'mux' }, meta: { enabled: true, providerConfigured: true } });
  });

  it('images and sites with the pipeline off are left alone', async () => {
    await register(app(), 'image/png');
    state.settings = DEFAULT_DAM_SETTINGS;
    await register(app());
    await new Promise((r) => setTimeout(r, 10));
    expect(videos.rows.size).toBe(0);
    expect(provider.submitted).toHaveLength(0);
  });

  it('playback is 409 until ready, then signed, expiring and never cached', async () => {
    const a = app();
    const f = repo.seed({ id: 'v1', filenameDisk: 'k', mime: 'video/mp4' });
    expect((await a.request(`/api/v1/files/${f.id}/video/playback`)).status).toBe(409);
    await videos.queue({ fileId: f.id, fileVersion: 1, provider: 'mux', signedPlayback: true });
    await videos.update(f.id, { status: 'ready', providerAssetId: 'pa', playbackId: 'pb', durationMs: 5000, width: 1280, height: 720 });
    const res = await a.request(`/api/v1/files/${f.id}/video/playback`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as { data: { hls: string; expiresAt: string } };
    expect(body.data).toMatchObject({ hls: expect.stringMatching(/^https:\/\/play\.example\/pb\.m3u8\?token=signed-/), durationMs: 5000, width: 1280, height: 720 });
    expect(Date.parse(body.data.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    // A replaced file must be re-processed before it plays again.
    await repo.update(f.id, { version: 2 });
    expect(((await (await a.request(`/api/v1/files/${f.id}/video/playback`)).json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VIDEO_NOT_READY');
  });

  it('retry: refused while processing, allowed when failed; 503 without a provider', async () => {
    const a = app();
    const f = repo.seed({ id: 'v2', filenameDisk: 'k', mime: 'video/mp4' });
    await videos.queue({ fileId: f.id, fileVersion: 1, provider: 'mux', signedPlayback: true });
    await videos.update(f.id, { status: 'processing', providerAssetId: 'old' });
    expect((await a.request(`/api/v1/files/${f.id}/video/retry`, { method: 'POST' })).status).toBe(409);
    await videos.update(f.id, { status: 'failed', error: 'codec' });
    const res = await a.request(`/api/v1/files/${f.id}/video/retry`, { method: 'POST' });
    expect(await res.json()).toMatchObject({ data: { status: 'processing' }, meta: { outcome: 'submitted' } });
    expect(provider.removed).toEqual(['old']);
    state.provider = null;
    expect((await a.request(`/api/v1/files/${f.id}/video/retry`, { method: 'POST' })).status).toBe(503);
  });

  it('deleting a video removes its provider asset', async () => {
    const a = app();
    const f = repo.seed({ id: 'v3', filenameDisk: 'k', mime: 'video/mp4' });
    await videos.queue({ fileId: f.id, fileVersion: 1, provider: 'mux', signedPlayback: true });
    await videos.update(f.id, { status: 'ready', providerAssetId: 'pa_del' });
    expect((await a.request(`/api/v1/files/${f.id}`, { method: 'DELETE' })).status).toBe(200);
    await vi.waitFor(() => expect(provider.removed).toEqual(['pa_del']));
  });
});

describe('provider webhook', () => {
  it('401 on a bad signature, 404 for another provider, applied for a verified event', async () => {
    const a = app();
    const f = repo.seed({ id: 'v4', filenameDisk: 'k', mime: 'video/mp4' });
    await videos.queue({ fileId: f.id, fileVersion: 1, provider: 'mux', signedPlayback: true });
    await videos.update(f.id, { status: 'processing', providerAssetId: 'pa9' });

    provider.rejectWebhook = true;
    expect((await a.request('/api/v1/video/webhook/mux', { method: 'POST', body: '{}' }, env)).status).toBe(401);
    provider.rejectWebhook = false;
    expect((await a.request('/api/v1/video/webhook/cloudflare-stream', { method: 'POST', body: '{}' }, env)).status).toBe(404);

    provider.webhookEvent = { providerAssetId: 'pa9', passthrough: 'site_a:v4:1', status: { state: 'ready', width: 640, height: 360, renditions: [] } };
    const res = await a.request('/api/v1/video/webhook/mux', { method: 'POST', body: '{}' }, env);
    expect(await res.json()).toEqual({ data: { outcome: 'applied' } });
    expect((await videos.get(f.id))!.status).toBe('ready');
    expect((await repo.get(f.id))!.width).toBe(640);
  });

  it('an event naming another site never touches this one', async () => {
    const a = app();
    const f = repo.seed({ id: 'v5', filenameDisk: 'k', mime: 'video/mp4' });
    await videos.queue({ fileId: f.id, fileVersion: 1, provider: 'mux', signedPlayback: true });
    await videos.update(f.id, { status: 'processing', providerAssetId: 'pa5' });
    provider.webhookEvent = { providerAssetId: 'pa5', passthrough: 'site_b:v5:1', status: { state: 'ready', renditions: [] } };
    expect(await (await a.request('/api/v1/video/webhook/mux', { method: 'POST', body: '{}' }, env)).json()).toEqual({ data: { outcome: 'ignored' } });
    expect((await videos.get(f.id))!.status).toBe('processing');
  });
});

describe('signed source', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');

  it('serves exactly the signed version of a servable video, and one 404 for everything else', async () => {
    const a = app();
    const f = repo.seed({ id: 'v6', filenameDisk: 'sites/site_a/v6.mp4', mime: 'video/mp4', version: 2 });
    await storage.put(f.filenameDisk, Buffer.from('MP4BYTES'));
    const token = await signSourceToken(SECRET, { siteId: 'site_a', fileId: f.id, version: 2, exp: now + 60_000 });
    const ok = await a.request(`/api/v1/video/source/${token}`, {}, env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('MP4BYTES');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');

    const stale = await signSourceToken(SECRET, { siteId: 'site_a', fileId: f.id, version: 1, exp: now + 60_000 });
    const expired = await signSourceToken(SECRET, { siteId: 'site_a', fileId: f.id, version: 2, exp: now - 1 });
    const otherSite = await signSourceToken(SECRET, { siteId: 'site_b', fileId: f.id, version: 2, exp: now + 60_000 });
    const forged = await signSourceToken('not-the-secret', { siteId: 'site_a', fileId: f.id, version: 2, exp: now + 60_000 });
    for (const t of [stale, expired, otherSite, forged, 'garbage']) {
      expect((await a.request(`/api/v1/video/source/${t}`, {}, env)).status).toBe(404);
    }
    await repo.update(f.id, { scanStatus: 'pending' });
    expect((await a.request(`/api/v1/video/source/${token}`, {}, env)).status).toBe(404);
  });
});
