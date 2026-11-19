import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Monitor, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildPreviewUrl } from '@lumibase/contracts';
import {
  acceptPreviewMessage,
  MAX_MESSAGE_BYTES,
  MAX_PATCH_FIELDS,
  messageSize,
  previewMessage,
  type StudioToFrontendMessage,
} from '@lumibase/visual-editing/protocol';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  changedFields,
  clampSplit,
  decideFrame,
  DEVICE_PRESETS,
  PATCH_DEBOUNCE_MS,
  RELOAD_DEBOUNCE_MS,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  splitFromKey,
  splitFromPointer,
  TOKEN_REFRESH_MARGIN_MS,
  topLevelField,
  type DevicePresetId,
} from './preview-pane-state';

/**
 * Live preview pane (epic #667 — V02 #680, V05 #683).
 *
 * Renders the site's frontend beside the item form in a sandboxed iframe,
 * using a short-lived, site-scoped preview token (V01). Field edits stream to
 * the frame as debounced field-level patches; a save triggers a reload; a
 * click on an outlined element in the frame focuses that field here.
 *
 * Security (ADR-014): the frame origin must be the collection template's
 * origin or on the site's `preview.allowedOrigins` and never the Studio's own
 * origin; inbound messages pass the shared origin/source/size/schema gate;
 * outbound messages always name the frame origin.
 */

const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

const ICONS: Record<DevicePresetId, typeof Monitor> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

export interface PreviewSplitProps {
  editor: ReactNode;
  preview: ReactNode;
}

/** Resizable, keyboard-accessible split between the form and the preview. */
export function PreviewSplit({ editor, preview }: PreviewSplitProps) {
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const rtl = getComputedStyle(containerRef.current).direction === 'rtl';
      setSplit(splitFromPointer(event.clientX, rect.left, rect.width, rtl));
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-[70vh] w-full items-stretch gap-0" data-testid="preview-split">
      <div className="min-w-0 overflow-auto pe-2" style={{ width: `${split}%` }}>
        {editor}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview"
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={split}
        tabIndex={0}
        onPointerDown={(event) => {
          dragging.current = true;
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          const rtl = containerRef.current ? getComputedStyle(containerRef.current).direction === 'rtl' : false;
          const next = splitFromKey(event.key, split, rtl);
          if (next === null) return;
          event.preventDefault();
          setSplit(next);
        }}
        className="w-1.5 shrink-0 cursor-col-resize rounded bg-border hover:bg-primary/40 focus:bg-primary focus:outline-none"
      />
      <div className="min-w-0 flex-1 ps-2" style={{ width: `${clampSplit(100 - split)}%` }}>
        {preview}
      </div>
    </div>
  );
}

export interface PreviewPaneProps {
  collection: string;
  itemId: string;
  /** The collection's `meta.previewUrl` template. */
  template: string;
  /** Current (possibly unsaved) form values. */
  draft: Record<string, unknown>;
  /** Changes whenever the item is saved (e.g. `updatedAt`). */
  savedMarker: string;
  locale?: string | null;
  versionKey?: string | null;
  onFocusField: (field: string) => void;
  onClose: () => void;
}

type MintedPreview = { url: string; expiresAt: number };

export function PreviewPane(props: PreviewPaneProps) {
  const { collection, itemId, template, draft, savedMarker, locale, onFocusField, onClose } = props;
  const client = getApiClient();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<DevicePresetId>('desktop');
  const [frameKey, setFrameKey] = useState(0);
  const [connected, setConnected] = useState(false);
  const [mintNonce, setMintNonce] = useState(0);
  // Content version to preview (V04 #682); '' = the item's current state.
  const [versionKey, setVersionKey] = useState(props.versionKey ?? '');
  // Last values the frame has seen, and the patch sequence number.
  const lastSent = useRef<Record<string, unknown> | null>(null);
  const seq = useRef(0);

  const versionsQuery = useQuery({
    queryKey: ['versions', collection, itemId],
    queryFn: async () =>
      (
        await client.rawRequest<Array<{ key: string; name: string }>>(
          `/api/v1/items/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}/versions`,
        )
      ).data,
    retry: false,
  });

  const settingsQuery = useQuery({
    queryKey: ['preview-settings'],
    queryFn: async () => (await client.preview.getSettings()).data,
    staleTime: 60_000,
  });

  const mintQuery = useQuery({
    queryKey: ['preview-token', collection, itemId, locale ?? null, versionKey ?? null, mintNonce],
    queryFn: async (): Promise<MintedPreview> => {
      const res = await client.preview.mintToken({
        collection,
        itemId,
        ...(locale ? { locale } : {}),
        ...(versionKey ? { versionKey } : {}),
      });
      const minted = res.data;
      const url =
        minted.url ??
        buildPreviewUrl(template, {
          id: itemId,
          collection,
          token: minted.token,
          locale: minted.locale,
          version: minted.versionKey,
        });
      if (!url) throw new Error('The collection preview URL is not valid.');
      return { url, expiresAt: new Date(minted.expiresAt).getTime() };
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

  // Re-mint shortly before expiry so a long editing session keeps previewing.
  useEffect(() => {
    const expiresAt = mintQuery.data?.expiresAt;
    if (!expiresAt) return;
    const delay = Math.max(expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS, 5_000);
    const timer = window.setTimeout(() => setMintNonce((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [mintQuery.data?.expiresAt]);

  const decision = useMemo(() => {
    if (!mintQuery.data) return null;
    return decideFrame({
      url: mintQuery.data.url,
      template,
      allowedOrigins: settingsQuery.data?.allowedOrigins ?? [],
      studioOrigin: window.location.origin,
    });
  }, [mintQuery.data, template, settingsQuery.data?.allowedOrigins]);

  const frameOrigin = decision?.ok ? decision.origin : null;

  const post = useCallback(
    (message: StudioToFrontendMessage) => {
      const target = iframeRef.current?.contentWindow;
      if (!target || !frameOrigin) return;
      target.postMessage(message, frameOrigin);
    },
    [frameOrigin],
  );

  // Inbound: only the frame's window, only its origin, only valid messages.
  useEffect(() => {
    if (!frameOrigin) return;
    setConnected(false);
    void frameKey;
    const onMessage = (event: MessageEvent) => {
      const result = acceptPreviewMessage('to-studio', event, {
        allowedOrigins: [frameOrigin],
        expectedSource: iframeRef.current?.contentWindow ?? null,
      });
      if (!result.ok) {
        if (event.source === iframeRef.current?.contentWindow) {
          console.warn(`[preview] dropped message from frame (${result.reason}) origin=${event.origin}`);
        }
        return;
      }
      const message = result.message;
      if (message.type === 'ready') {
        setConnected(true);
        post(previewMessage({ type: 'hello' as const }));
        lastSent.current = null;
      } else if (message.type === 'focus') {
        if (message.target.collection === collection && message.target.itemId === itemId) {
          onFocusField(topLevelField(message.target.field));
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameOrigin, frameKey, collection, itemId, onFocusField, post]);

  // Field edits → debounced, chunked field-level patches.
  useEffect(() => {
    // A version preview shows the version's data; the form edits the item
    // itself, so its unsaved values must not be streamed over the version.
    if (!connected || versionKey) return;
    const timer = window.setTimeout(() => {
      const changed = changedFields(lastSent.current, draft);
      lastSent.current = { ...draft };
      const entries = Object.entries(changed);
      for (let i = 0; i < entries.length; i += MAX_PATCH_FIELDS) {
        seq.current += 1;
        const message = previewMessage({
          type: 'patch' as const,
          seq: seq.current,
          collection,
          itemId,
          fields: Object.fromEntries(entries.slice(i, i + MAX_PATCH_FIELDS)),
        });
        // Oversized values (e.g. a huge rich-text body) are not streamed; the
        // frame catches up on the next save.
        if (messageSize(message) <= MAX_MESSAGE_BYTES) post(message);
      }
    }, PATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, connected, collection, itemId, post, versionKey]);

  // Save → debounced reload (message when connected, else reload the frame).
  const firstSave = useRef(savedMarker);
  useEffect(() => {
    if (savedMarker === firstSave.current) return;
    firstSave.current = savedMarker;
    const timer = window.setTimeout(() => {
      if (connected) post(previewMessage({ type: 'reload' as const }));
      else setFrameKey((k) => k + 1);
    }, RELOAD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [savedMarker, connected, post]);

  const width = DEVICE_PRESETS.find((d) => d.id === device)?.width ?? null;

  return (
    <section className="flex h-full flex-col rounded-lg border bg-background" aria-label="Live preview">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
        <div className="flex items-center gap-1" role="group" aria-label="Device width">
          {DEVICE_PRESETS.map((preset) => {
            const Icon = ICONS[preset.id];
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={device === preset.id}
                title={preset.width ? `${preset.label} (${preset.width}px)` : preset.label}
                onClick={() => setDevice(preset.id)}
                className={cn(
                  'rounded p-1 text-muted-foreground hover:bg-muted',
                  device === preset.id && 'bg-muted text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="sr-only">{preset.label}</span>
              </button>
            );
          })}
          <span className={cn('ms-2 text-[10px]', connected ? 'text-emerald-600' : 'text-muted-foreground')}>
            {connected ? 'Live' : 'Static'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(versionsQuery.data?.length ?? 0) > 0 && (
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
              Version
              <select
                aria-label="Preview version"
                value={versionKey}
                onChange={(e) => {
                  setVersionKey(e.target.value);
                  lastSent.current = null;
                }}
                className="rounded border bg-background px-1 py-0.5 text-[10px]"
              >
                <option value="">Current</option>
                {versionsQuery.data?.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            title="Reload preview"
            aria-label="Reload preview"
            onClick={() => setFrameKey((k) => k + 1)}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {decision?.ok && mintQuery.data && (
            <a
              href={mintQuery.data.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in a new tab"
              aria-label="Open preview in a new tab"
              className="rounded p-1 text-muted-foreground hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 justify-center overflow-auto bg-muted/30 p-2">
        {mintQuery.isLoading && <p className="text-xs text-muted-foreground">Preparing preview…</p>}
        {mintQuery.error && (
          <p role="alert" className="text-xs text-destructive">
            Could not create a preview link: {(mintQuery.error as Error).message}
          </p>
        )}
        {decision && !decision.ok && (
          <p role="alert" className="max-w-sm text-xs text-destructive">
            {decision.reason === 'same_origin'
              ? 'The preview URL points at the Studio itself. Serve your frontend from another origin.'
              : decision.reason === 'not_allowed'
                ? 'The preview URL origin is not allowed. Add it under Settings → Preview → Allowed origins.'
                : 'The preview URL is not valid.'}
          </p>
        )}
        {decision?.ok && mintQuery.data && (
          <iframe
            key={`${frameKey}:${mintQuery.data.url}`}
            ref={iframeRef}
            title={`Preview of ${collection} ${itemId}`}
            src={mintQuery.data.url}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            className="h-full min-h-[60vh] rounded border bg-white"
            style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}
          />
        )}
      </div>
    </section>
  );
}
