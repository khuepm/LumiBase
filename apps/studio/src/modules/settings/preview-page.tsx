import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PreviewTokenResource } from '@lumibase/sdk';
import {
  PreviewOriginSchema,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PREVIEW_TOKEN_MIN_TTL_SECONDS,
  validatePreviewUrlTemplate,
} from '@lumibase/contracts';
import { Eye, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Settings → Preview (epic #667, V01 #679).
 *
 * - Allowed origins: exact `scheme://host[:port]` origins the Studio may frame
 *   besides each collection's own preview URL origin (ADR-014).
 * - Token lifetime for Studio-minted preview links.
 * - Live tokens: revoke one, or rotate (revoke every live token of the site).
 *   Admins see the whole site; other editors see their own tokens.
 */
export function PreviewSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['preview-settings'],
    queryFn: async () => (await client.preview.getSettings()).data,
  });
  const tokensQuery = useQuery({
    queryKey: ['preview-tokens'],
    queryFn: async () => (await client.preview.listTokens()).data,
  });

  const [origins, setOrigins] = useState<string[]>([]);
  const [ttl, setTtl] = useState(900);
  const [pageUrl, setPageUrl] = useState('');
  const [draftOrigin, setDraftOrigin] = useState('');
  const [originError, setOriginError] = useState<string | null>(null);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setOrigins(settingsQuery.data.allowedOrigins);
    setTtl(settingsQuery.data.ttlSeconds);
    setPageUrl(settingsQuery.data.pageUrl ?? '');
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: async () =>
      (
        await client.preview.updateSettings({
          allowedOrigins: origins,
          ttlSeconds: ttl,
          pageUrl: pageUrl.trim() || null,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-settings'] }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.preview.revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-tokens'] }),
  });
  const rotate = useMutation({
    mutationFn: async () => (await client.preview.revokeAll()).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-tokens'] }),
  });

  const addOrigin = () => {
    const value = draftOrigin.trim().replace(/\/$/, '');
    if (!PreviewOriginSchema.safeParse(value).success) {
      setOriginError('Enter an exact origin like https://www.example.com (no path, no wildcard).');
      return;
    }
    setOriginError(null);
    setOrigins((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setDraftOrigin('');
  };

  const tokens: PreviewTokenResource[] = tokensQuery.data ?? [];
  const pageUrlIssue = pageUrl.trim() ? validatePreviewUrlTemplate(pageUrl.trim())?.message ?? null : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <Eye className="h-6 w-6" /> Preview
        </h1>
        <p className="text-sm text-muted-foreground">
          Live preview opens your frontend beside the item form with a short-lived, site-scoped preview token. Set a
          collection&apos;s Preview URL in Data model to enable it.
        </p>
      </header>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Allowed origins</h2>
        <p className="text-xs text-muted-foreground">
          The Studio frames a collection&apos;s own preview URL origin. Add other origins here only if your preview
          redirects to them. Exact origins only.
        </p>
        <ul className="space-y-1">
          {origins.map((origin) => (
            <li key={origin} className="flex items-center justify-between rounded border px-2 py-1 font-mono text-xs">
              {origin}
              <button
                type="button"
                aria-label={`Remove ${origin}`}
                onClick={() => setOrigins((prev) => prev.filter((o) => o !== origin))}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {origins.length === 0 && <li className="text-xs text-muted-foreground">No extra origins.</li>}
        </ul>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="preview-origin">
            Origin
          </label>
          <input
            id="preview-origin"
            value={draftOrigin}
            onChange={(e) => setDraftOrigin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addOrigin();
              }
            }}
            placeholder="https://www.example.com"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
          />
          <button type="button" onClick={addOrigin} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {originError && (
          <p role="alert" className="text-xs text-destructive">
            {originError}
          </p>
        )}
        <label className="block text-xs font-medium text-muted-foreground">
          Token lifetime (seconds)
          <input
            type="number"
            min={PREVIEW_TOKEN_MIN_TTL_SECONDS}
            max={PREVIEW_TOKEN_MAX_TTL_SECONDS}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            className="mt-1 w-40 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">
          Page URL (page composer preview)
          <input
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            placeholder="https://www.example.com/{slug}"
            aria-invalid={pageUrlIssue ? true : undefined}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
          />
        </label>
        {pageUrlIssue && (
          <p role="alert" className="text-xs text-destructive">
            {pageUrlIssue}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || Boolean(pageUrlIssue)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.error && <span role="alert" className="text-xs text-destructive">Save failed (site admins only).</span>}
          {save.isSuccess && <span className="text-xs text-emerald-600">Saved.</span>}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Live preview tokens</h2>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Revoke every live preview token of this site? Open previews stop working.')) rotate.mutate();
            }}
            disabled={rotate.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Rotate (revoke all)
          </button>
        </div>
        {rotate.error && <p role="alert" className="text-xs text-destructive">Rotation failed (site admins only).</p>}
        {rotate.data && <p className="text-xs text-muted-foreground">Revoked {rotate.data.revoked} token(s).</p>}
        <table className="w-full text-start text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1">Target</th>
              <th className="py-1">Locale</th>
              <th className="py-1">Expires</th>
              <th className="py-1">Uses</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-1 font-mono">
                  {t.releaseId ? `release ${t.releaseId}` : `${t.collection}/${t.itemId}${t.versionKey ? `@${t.versionKey}` : ''}`}
                </td>
                <td className="py-1">{t.locale ?? '—'}</td>
                <td className="py-1">{new Date(t.expiresAt).toLocaleString()}</td>
                <td className="py-1">{t.useCount}</td>
                <td className="py-1 text-end">
                  <button
                    type="button"
                    aria-label={`Revoke token ${t.id}`}
                    onClick={() => revoke.mutate(t.id)}
                    className="rounded p-1 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-muted-foreground">
                  {tokensQuery.isLoading ? 'Loading…' : 'No live preview tokens.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
