import { useMutation, useQueries } from '@tanstack/react-query';
import { buildPreviewUrl } from '@lumibase/contracts';
import { ExternalLink, Eye } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { useSiteLocales } from '@/modules/content/use-site-locales';

/**
 * "Preview release" (epic #667, V04 #682).
 *
 * Mints ONE release-scoped preview token (`POST /preview/token { releaseId,
 * locale? }`) and lists a preview link per release member, built from that
 * member's collection `meta.previewUrl`. With a release token the frontend
 * sees every member as it will publish and everything else as live
 * (`/api/v1/deliver/preview/:site_id/...`), so any member link shows the
 * whole release in context.
 */

export interface ReleasePreviewMember {
  collection: string;
  itemId: string;
  targetStatus: string;
}

interface MintedReleaseToken {
  token: string;
  expiresAt: string;
  locale: string | null;
}

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Request failed.';
}

export function ReleasePreview({ releaseId, items }: { releaseId: string; items: ReleasePreviewMember[] }) {
  const client = getApiClient();
  const locales = useSiteLocales();
  const [locale, setLocale] = useState('');

  const collections = [...new Set(items.map((i) => i.collection))];
  const metas = useQueries({
    queries: collections.map((name) => ({
      queryKey: ['collection', name],
      queryFn: async () => (await client.schema.getCollection(name)).data,
    })),
  });
  const templateFor = (collection: string): string | null => {
    const index = collections.indexOf(collection);
    const template = metas[index]?.data?.meta?.previewUrl;
    return typeof template === 'string' ? template : null;
  };

  const mint = useMutation({
    mutationFn: async (): Promise<MintedReleaseToken> => {
      const res = await client.preview.mintToken({ releaseId, ...(locale ? { locale } : {}) });
      return { token: res.data.token, expiresAt: res.data.expiresAt, locale: res.data.locale };
    },
  });

  const links = mint.data
    ? items.map((member) => {
        const template = templateFor(member.collection);
        const url = template
          ? buildPreviewUrl(template, {
              id: member.itemId,
              collection: member.collection,
              token: mint.data.token,
              release: releaseId,
              locale: mint.data.locale,
            })
          : null;
        return { member, url };
      })
    : [];
  const anyTemplate = collections.some((c) => templateFor(c) !== null);

  return (
    <section className="space-y-2 rounded-md border p-3" aria-label="Release preview">
      <div className="flex flex-wrap items-center gap-2">
        {locales.length > 1 && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Locale
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              className="rounded-md border bg-background px-1.5 py-1 text-xs"
            >
              <option value="">Default</option>
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => mint.mutate()}
          disabled={mint.isPending || items.length === 0}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          <Eye className="h-3.5 w-3.5" />
          {mint.isPending ? 'Preparing…' : mint.data ? 'New preview link' : 'Create preview link'}
        </button>
        {mint.data && (
          <span className="text-xs text-muted-foreground">
            Expires {new Date(mint.data.expiresAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Every item in the release appears as it will publish; everything else appears as it is live now.
      </p>
      {mint.error && (
        <p role="alert" className="text-xs text-destructive">
          Could not create a preview link: {errorMessage(mint.error)}
        </p>
      )}
      {mint.data && !anyTemplate && (
        <p role="alert" className="text-xs text-muted-foreground">
          None of these collections has a Preview URL. Set one in Data model → Display.
        </p>
      )}
      {mint.data && anyTemplate && (
        <ul className="space-y-1 text-xs">
          {links.map(({ member, url }) => (
            <li key={`${member.collection}:${member.itemId}`} className="flex items-center justify-between gap-2">
              <span className="font-mono">
                {member.collection}/{member.itemId}
                <span className="ms-1 text-muted-foreground">→ {member.targetStatus}</span>
              </span>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Open preview <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">No Preview URL</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
