import { useQuery } from '@tanstack/react-query';
import { buildPreviewUrl } from '@lumibase/contracts';
import { Monitor, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { decideFrame, DEVICE_PRESETS, type DevicePresetId } from '@/modules/content/preview-pane-state';

/**
 * Page preview for the composer (V06 #684, preview via V02). Frames the
 * site's frontend at `preview.pageUrl` (`{slug}`) with the same rules as the
 * item preview pane (ADR-014): the frame origin must be the template's origin
 * or allowlisted and never the Studio's own; sandboxed; no referrer. The
 * frame reloads after each save. Pages are public, so no preview token.
 */

const ICONS: Record<DevicePresetId, typeof Monitor> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

/**
 * `buildPreviewUrl` encodes every value as one URL component, which turns a
 * nested slug (`about/team`) into `about%2Fteam`. A page slug is a path, so
 * `{slug}` is filled in segment by segment and keeps its `/` separators; the
 * result still goes through `buildPreviewUrl` for the http(s) check.
 */
export function buildPageUrl(template: string, slug: string): string | null {
  const path = slug.split('/').map(encodeURIComponent).join('/');
  return buildPreviewUrl(template.split('{slug}').join(path), {});
}

export function PagePreview({ slug, savedMarker, onClose }: { slug: string; savedMarker: string; onClose: () => void }) {
  const client = getApiClient();
  const [device, setDevice] = useState<DevicePresetId>('desktop');
  const [frameKey, setFrameKey] = useState(0);
  const settings = useQuery({
    queryKey: ['preview-settings'],
    queryFn: async () => (await client.preview.getSettings()).data,
    staleTime: 60_000,
  });

  useEffect(() => {
    setFrameKey((k) => k + 1);
  }, [savedMarker]);

  const template = settings.data?.pageUrl ?? null;
  const url = template ? buildPageUrl(template, slug) : null;
  const decision =
    template && url
      ? decideFrame({ url, template, allowedOrigins: settings.data?.allowedOrigins ?? [], studioOrigin: window.location.origin })
      : null;
  const width = DEVICE_PRESETS.find((d) => d.id === device)?.width ?? null;

  return (
    <section className="flex h-full flex-col rounded-lg border bg-background" aria-label="Page preview">
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
                className={cn('rounded p-1 text-muted-foreground hover:bg-muted', device === preset.id && 'bg-muted text-foreground')}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="sr-only">{preset.label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Reload preview"
            onClick={() => setFrameKey((k) => k + 1)}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Close preview" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 justify-center overflow-auto bg-muted/30 p-2">
        {settings.isSuccess && !template && (
          <p role="alert" className="max-w-sm text-xs text-muted-foreground">
            Set a page URL under Settings → Preview to preview pages here.
          </p>
        )}
        {decision && !decision.ok && (
          <p role="alert" className="max-w-sm text-xs text-destructive">
            {decision.reason === 'same_origin'
              ? 'The page URL points at the Studio itself. Serve your frontend from another origin.'
              : decision.reason === 'not_allowed'
                ? 'The page URL origin is not allowed. Add it under Settings → Preview → Allowed origins.'
                : 'The page URL is not valid.'}
          </p>
        )}
        {decision?.ok && url && (
          <iframe
            key={`${frameKey}:${url}`}
            title={`Preview of page ${slug}`}
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
