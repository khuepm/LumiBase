import { useMutation, useQuery } from '@tanstack/react-query';
import { Captions, Film, Plus, RotateCcw, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CaptionKind, CaptionTrackResource, FileResource, VideoAssetResource, VideoPlaybackResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { useSiteLocales } from '@/modules/content/use-site-locales';
import { useMediaPicker } from './media-picker';

/**
 * Video section of the asset drawer (#871 part 3): processing status with
 * retry, a preview player, and the caption / subtitle tracks.
 *
 * CSP and shell (DoD §2d): the Studio page allows `media-src 'self' blob:` and
 * `img-src 'self' data: blob:`, so nothing is loaded straight from the
 * provider's domain. HLS plays through hls.js (Media Source → `blob:`),
 * segments are fetched under `connect-src https:`, and the poster and the
 * WebVTT tracks are fetched (tracks through the SDK, with the bearer the
 * shell manages) and handed to the element as `blob:` URLs. Where Media
 * Source is missing (older iOS webviews) the element falls back to native HLS.
 */

const KINDS: CaptionKind[] = ['subtitles', 'captions', 'descriptions', 'chapters'];
const ACTIVE: ReadonlySet<string> = new Set(['uploaded', 'processing']);

export const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

/** Seam for tests: load hls.js lazily so it never weighs on the initial bundle. */
export const hlsLoader = {
  load: async () => (await import('hls.js')).default,
};

function toPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** `blob:` URLs for the poster and every track; revoked when the inputs change. */
function useBlobUrls(playback: VideoPlaybackResource | undefined, tracks: CaptionTrackResource[]) {
  const client = getApiClient();
  const [urls, setUrls] = useState<{ poster: string | null; tracks: Record<string, string> }>({ poster: null, tracks: {} });
  const key = `${playback?.poster ?? ''}|${tracks.map((t) => `${t.id}:${t.src}`).join(',')}`;
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    const toBlobUrl = (blob: Blob) => {
      const u = URL.createObjectURL(blob);
      made.push(u);
      return u;
    };
    void (async () => {
      let poster: string | null = null;
      if (playback?.poster) {
        try {
          const res = await fetch(playback.poster);
          if (res.ok) poster = toBlobUrl(await res.blob());
        } catch {
          /* no poster */
        }
      }
      const out: Record<string, string> = {};
      for (const t of tracks) {
        if (!t.src) continue;
        try {
          const res = await client.rawFetch(toPath(t.src));
          out[t.id] = toBlobUrl(new Blob([await res.text()], { type: 'text/vtt' }));
        } catch {
          /* skip an unreadable track */
        }
      }
      if (!cancelled) setUrls({ poster, tracks: out });
    })();
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

function Player({ playback, tracks }: { playback: VideoPlaybackResource; tracks: CaptionTrackResource[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const blobs = useBlobUrls(playback, tracks);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let destroy: (() => void) | undefined;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const Hls = await hlsLoader.load();
        if (cancelled) return;
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(playback.hls);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError('The video could not be played. The playback link may have expired; reopen the file.');
          });
          destroy = () => hls.destroy();
          return;
        }
      } catch {
        /* fall through to native HLS */
      }
      if (cancelled) return;
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = playback.hls;
      else setError('This browser cannot play HLS video.');
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [playback.hls]);

  return (
    <div className="space-y-1">
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        poster={blobs.poster ?? undefined}
        className="aspect-video w-full rounded-md bg-black"
        data-testid="video-player"
      >
        {tracks.map((t) =>
          blobs.tracks[t.id] ? (
            <track key={t.id} kind={t.kind} srcLang={t.locale} label={t.label} src={blobs.tracks[t.id]} default={t.isDefault} />
          ) : null,
        )}
      </video>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {playback.expiresAt && (
        <p className="text-xs text-muted-foreground">Signed link, valid until {new Date(playback.expiresAt).toLocaleTimeString()}.</p>
      )}
    </div>
  );
}

function CaptionEditor({ file, tracks, onChanged }: { file: FileResource; tracks: CaptionTrackResource[]; onChanged: () => void }) {
  const client = getApiClient();
  const locales = useSiteLocales();
  const openPicker = useMediaPicker();
  const [draft, setDraft] = useState<{ locale: string; kind: CaptionKind; label: string; isDefault: boolean }>({
    locale: '',
    kind: 'subtitles',
    label: '',
    isDefault: false,
  });
  const fail = (err: Error) => alert(err.message);
  const add = useMutation({
    mutationFn: (captionFileId: string) =>
      client.files.captions.add(file.id, {
        captionFileId,
        locale: draft.locale || locales[0]!,
        kind: draft.kind,
        label: draft.label.trim() || null,
        isDefault: draft.isDefault,
      }),
    onSuccess: () => {
      setDraft((d) => ({ ...d, label: '', isDefault: false }));
      onChanged();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: { isDefault: boolean } }) => client.files.captions.update(file.id, v.id, v.patch),
    onSuccess: onChanged,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.files.captions.remove(file.id, id),
    onSuccess: onChanged,
    onError: fail,
  });

  const chooseFile = async () => {
    if (!openPicker) return;
    const picked = await openPicker({ allowedMimeTypes: ['text/vtt'] });
    if (picked?.[0]) add.mutate(picked[0].id);
  };

  return (
    <div className="space-y-2">
      {tracks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No caption or subtitle tracks.</p>
      ) : (
        <ul className="space-y-1 text-xs" aria-label="Caption tracks">
          {tracks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{t.locale}</span>
              <span>{t.label}</span>
              <span className="text-muted-foreground">{t.kind}</span>
              {!t.src && <span className="text-muted-foreground">(file not visible to you)</span>}
              <button
                type="button"
                className="ms-auto rounded p-1 hover:bg-muted"
                aria-label={t.isDefault ? `${t.label} is the default` : `Make ${t.label} the default`}
                aria-pressed={t.isDefault}
                onClick={() => update.mutate({ id: t.id, patch: { isDefault: !t.isDefault } })}
              >
                <Star className={`h-3.5 w-3.5 ${t.isDefault ? 'fill-current' : ''}`} />
              </button>
              <button
                type="button"
                className="rounded p-1 text-destructive hover:bg-muted"
                aria-label={`Remove ${t.label}`}
                onClick={() => remove.mutate(t.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="text-muted-foreground">Language</span>
          <select
            aria-label="Track language"
            className="mt-1 w-full rounded-md border px-2 py-1"
            value={draft.locale || locales[0]}
            onChange={(e) => setDraft((d) => ({ ...d, locale: e.target.value }))}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-muted-foreground">Kind</span>
          <select
            aria-label="Track kind"
            className="mt-1 w-full rounded-md border px-2 py-1"
            value={draft.kind}
            onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as CaptionKind }))}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 block">
          <span className="text-muted-foreground">Label (optional)</span>
          <input
            aria-label="Track label"
            className="mt-1 w-full rounded-md border px-2 py-1"
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
        </label>
        <label className="col-span-2 flex items-center gap-2">
          <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft((d) => ({ ...d, isDefault: e.target.checked }))} />
          <span>Default track</span>
        </label>
      </div>
      <button
        type="button"
        disabled={!openPicker || add.isPending}
        onClick={() => void chooseFile()}
        className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 hover:bg-muted"
      >
        <Plus className="h-4 w-4" /> {add.isPending ? 'Adding…' : 'Add WebVTT file from library…'}
      </button>
    </div>
  );
}

export function VideoPanel({ file }: { file: FileResource }) {
  const client = getApiClient();
  const videoQuery = useQuery({
    queryKey: ['files', 'video', file.id, file.version],
    queryFn: async () => {
      const res = await client.files.video.get(file.id);
      return { asset: res.data as VideoAssetResource | null, meta: (res.meta ?? {}) as { enabled?: boolean; providerConfigured?: boolean } };
    },
    // Poll while the provider works; stop once ready or failed.
    refetchInterval: (q) => (q.state.data?.asset && ACTIVE.has(q.state.data.asset.status) ? 5000 : false),
  });
  const asset = videoQuery.data?.asset ?? null;
  const ready = asset?.status === 'ready' && asset.fileVersion === file.version;
  const playbackQuery = useQuery({
    queryKey: ['files', 'video', 'playback', file.id, file.version],
    queryFn: async () => (await client.files.video.playback(file.id)).data,
    enabled: ready,
    staleTime: 60_000,
  });
  const captionsQuery = useQuery({
    queryKey: ['files', 'captions', file.id],
    queryFn: async () => (await client.files.captions.list(file.id)).data,
  });
  const retry = useMutation({
    mutationFn: () => client.files.video.retry(file.id),
    onSuccess: () => void videoQuery.refetch(),
    onError: (err: Error) => alert(err.message),
  });
  const tracks = captionsQuery.data ?? [];
  const meta = videoQuery.data?.meta;

  return (
    <>
      <section aria-label="Video">
        <h3 className="mb-1 flex items-center gap-1 font-medium">
          <Film className="h-4 w-4" /> Video
        </h3>
        {videoQuery.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !asset ? (
          <p className="text-xs text-muted-foreground">
            {!meta?.providerConfigured
              ? 'No video provider is configured for this deployment; the original is served as uploaded.'
              : !meta.enabled
                ? 'Video processing is off for this site (`video.enabled` in the files settings, PUT /api/v1/files/settings).'
                : 'Not processed.'}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium" data-testid="video-status">
                {STATUS_LABEL[asset.status] ?? asset.status}
              </span>
              {asset.durationMs ? <span>{Math.round(asset.durationMs / 1000)} s</span> : null}
              {asset.width ? (
                <span>
                  {asset.width}×{asset.height}
                </span>
              ) : null}
            </p>
            {asset.error && <p className="text-xs text-destructive">{asset.error}</p>}
            {(asset.status === 'failed' || (asset.status === 'uploaded' && asset.error)) && (
              <button
                type="button"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 hover:bg-muted"
              >
                <RotateCcw className="h-4 w-4" /> {retry.isPending ? 'Retrying…' : 'Retry processing'}
              </button>
            )}
            {ready && playbackQuery.data && <Player playback={playbackQuery.data} tracks={tracks} />}
            {ready && playbackQuery.isError && <p className="text-xs text-destructive">{(playbackQuery.error as Error).message}</p>}
          </div>
        )}
      </section>
      <section aria-label="Captions and subtitles">
        <h3 className="mb-1 flex items-center gap-1 font-medium">
          <Captions className="h-4 w-4" /> Captions & subtitles
        </h3>
        <CaptionEditor file={file} tracks={tracks} onChanged={() => void captionsQuery.refetch()} />
      </section>
    </>
  );
}
