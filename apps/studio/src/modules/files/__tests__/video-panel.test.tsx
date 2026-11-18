// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptionTrackResource, FileResource, VideoAssetResource } from '@lumibase/sdk';

/**
 * Studio video section (#871 part 3): status + retry, an hls.js player whose
 * poster and tracks are `blob:` URLs (CSP: no provider origins in media-src /
 * img-src), the native-HLS fallback, and the caption editor.
 */

const api = vi.hoisted(() => ({
  asset: null as unknown,
  meta: { enabled: true, providerConfigured: true } as Record<string, unknown>,
  tracks: [] as unknown[],
  get: vi.fn(),
  retry: vi.fn(),
  playback: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  rawFetch: vi.fn(),
  pick: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    files: {
      video: { get: api.get, retry: api.retry, playback: api.playback },
      captions: { list: api.list, add: api.add, update: api.update, remove: api.remove },
    },
    rawFetch: api.rawFetch,
  }),
}));
vi.mock('@/modules/content/use-site-locales', () => ({ useSiteLocales: () => ['en', 'vi'] }));
vi.mock('../media-picker', () => ({ useMediaPicker: () => api.pick }));

import { hlsLoader, VideoPanel } from '../video-panel';

class FakeHls {
  static supported = true;
  static instances: FakeHls[] = [];
  static Events = { ERROR: 'hlsError' };
  static isSupported() {
    return FakeHls.supported;
  }
  source: string | null = null;
  media: HTMLMediaElement | null = null;
  destroyed = false;
  handlers: Record<string, (e: unknown, d: { fatal: boolean }) => void> = {};
  constructor() {
    FakeHls.instances.push(this);
  }
  loadSource(s: string) {
    this.source = s;
  }
  attachMedia(m: HTMLMediaElement) {
    this.media = m;
  }
  on(ev: string, fn: (e: unknown, d: { fatal: boolean }) => void) {
    this.handlers[ev] = fn;
  }
  destroy() {
    this.destroyed = true;
  }
}

const video: FileResource = {
  id: 'vid',
  siteId: 's',
  storage: 'r2',
  filenameDisk: 'k/clip.mp4',
  filenameDownload: 'clip.mp4',
  mime: 'video/mp4',
  filesize: 10,
  width: null,
  height: null,
  duration: null,
  folder: null,
  metadata: {},
  uploadedBy: null,
  createdAt: '2026-01-01',
  version: 2,
} as FileResource;

const asset = (over: Partial<VideoAssetResource> = {}): VideoAssetResource => ({
  fileId: 'vid',
  fileVersion: 2,
  provider: 'mux',
  status: 'ready',
  error: null,
  attempts: 1,
  durationMs: 61_000,
  width: 1920,
  height: 1080,
  renditions: [],
  signedPlayback: true,
  submittedAt: null,
  readyAt: null,
  updatedAt: '2026-11-18T00:00:00Z',
  ...over,
});

const track = (over: Partial<CaptionTrackResource> = {}): CaptionTrackResource => ({
  id: 't_en',
  fileId: 'vid',
  captionFileId: 'en_vtt',
  locale: 'en',
  kind: 'subtitles',
  label: 'English',
  isDefault: true,
  src: 'https://cms.example/api/v1/files/en_vtt/content?v=3',
  captionVersion: 3,
  createdAt: '',
  updatedAt: '',
  ...over,
});

function withClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

let blobCount = 0;
beforeEach(() => {
  FakeHls.supported = true;
  FakeHls.instances = [];
  blobCount = 0;
  api.asset = asset();
  api.meta = { enabled: true, providerConfigured: true };
  api.tracks = [track()];
  api.get.mockImplementation(async () => ({ data: api.asset, meta: api.meta }));
  api.playback.mockResolvedValue({
    data: { hls: 'https://stream.example/pb.m3u8?token=t', poster: 'https://image.example/pb.jpg?token=t', expiresAt: '2026-11-18T12:00:00Z', durationMs: 61000, width: 1920, height: 1080 },
  });
  api.list.mockImplementation(async () => ({ data: api.tracks }));
  api.rawFetch.mockResolvedValue(new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n'));
  api.retry.mockResolvedValue({ data: asset({ status: 'processing' }) });
  api.add.mockResolvedValue({ data: track({ id: 't_vi', locale: 'vi' }) });
  api.update.mockResolvedValue({ data: track() });
  api.remove.mockResolvedValue({ data: null });
  api.pick.mockResolvedValue([{ id: 'vi_vtt' }]);
  vi.spyOn(hlsLoader, 'load').mockResolvedValue(FakeHls as never);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('jpg-bytes')));
  URL.createObjectURL = vi.fn(() => `blob:test/${++blobCount}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VideoPanel', () => {
  it('plays a ready video through hls.js with a blob poster and blob caption tracks', async () => {
    withClient(<VideoPanel file={video} />);
    expect((await screen.findByTestId('video-status')).textContent).toBe('Ready');
    await waitFor(() => expect(FakeHls.instances[0]?.source).toBe('https://stream.example/pb.m3u8?token=t'));
    const el = screen.getByTestId('video-player') as HTMLVideoElement;
    expect(FakeHls.instances[0]!.media).toBe(el);
    await waitFor(() => expect(el.querySelector('track')).not.toBeNull());
    const t = el.querySelector('track')!;
    expect(t.getAttribute('src')).toMatch(/^blob:/);
    expect(t.getAttribute('srclang')).toBe('en');
    expect(t.hasAttribute('default')).toBe(true);
    expect(el.getAttribute('poster')).toMatch(/^blob:/);
    // Tracks are read through the SDK (bearer + site headers), by path.
    expect(api.rawFetch).toHaveBeenCalledWith('/api/v1/files/en_vtt/content?v=3');
  });

  it('falls back to native HLS when Media Source is missing', async () => {
    FakeHls.supported = false;
    const canPlay = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    withClient(<VideoPanel file={video} />);
    const el = (await screen.findByTestId('video-player')) as HTMLVideoElement;
    await waitFor(() => expect(el.getAttribute('src')).toBe('https://stream.example/pb.m3u8?token=t'));
    expect(canPlay).toHaveBeenCalledWith('application/vnd.apple.mpegurl');
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('shows a failed video with its error and retries it', async () => {
    api.asset = asset({ status: 'failed', error: 'codec not supported' });
    withClient(<VideoPanel file={video} />);
    expect((await screen.findByTestId('video-status')).textContent).toBe('Failed');
    expect(screen.getByText('codec not supported')).toBeTruthy();
    expect(api.playback).not.toHaveBeenCalled();
    api.asset = asset({ status: 'processing' });
    fireEvent.click(screen.getByText('Retry processing'));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith('vid'));
    await waitFor(() => expect(screen.getByTestId('video-status').textContent).toBe('Processing'));
  });

  it('explains why a video is not processed', async () => {
    api.asset = null;
    api.meta = { enabled: false, providerConfigured: true };
    withClient(<VideoPanel file={video} />);
    expect(await screen.findByText(/Video processing is off for this site/)).toBeTruthy();
    cleanup();
    api.meta = { enabled: true, providerConfigured: false };
    withClient(<VideoPanel file={video} />);
    expect(await screen.findByText(/No video provider is configured/)).toBeTruthy();
  });

  it('adds a WebVTT track from the library with the chosen language, kind and label', async () => {
    api.tracks = [];
    withClient(<VideoPanel file={video} />);
    expect(await screen.findByText('No caption or subtitle tracks.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Track language'), { target: { value: 'vi' } });
    fireEvent.change(screen.getByLabelText('Track kind'), { target: { value: 'captions' } });
    fireEvent.change(screen.getByLabelText('Track label'), { target: { value: 'Tiếng Việt' } });
    fireEvent.click(screen.getByText('Add WebVTT file from library…'));
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith('vid', { captionFileId: 'vi_vtt', locale: 'vi', kind: 'captions', label: 'Tiếng Việt', isDefault: false }),
    );
    expect(api.pick).toHaveBeenCalledWith({ allowedMimeTypes: ['text/vtt'] });
  });

  it('toggles the default and removes a track', async () => {
    withClient(<VideoPanel file={video} />);
    fireEvent.click(await screen.findByLabelText('English is the default'));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('vid', 't_en', { isDefault: false }));
    fireEvent.click(screen.getByLabelText('Remove English'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('vid', 't_en'));
  });
});
