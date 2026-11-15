/**
 * API explorer (#745): renders a site's live OpenAPI document
 * (`GET /api/v1/openapi.json`) with a bundled Swagger UI.
 *
 * - No hard-coded host: the reader supplies the document URL.
 * - No CDN `<script>`: Swagger UI comes from the `swagger-ui-dist` package and
 *   is code-split behind a dynamic import, loaded only after the reader
 *   presses Load (so SSR/prerender never touches it and other pages never
 *   download it).
 * - Credentials live in component state only — never in storage or the URL.
 */
import { useRef, useState, type FormEvent } from 'react';
import { useT } from '../hooks/useT';
import { buildRequestInterceptor, parseSpecUrl } from '../lib/api-explorer';

type Status = 'idle' | 'loading' | 'ready' | 'invalid' | 'failed';

export function ApiExplorerPage() {
  const t = useT();
  const mountRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [site, setSite] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const specUrl = parseSpecUrl(url);
    if (!specUrl || !mountRef.current) {
      setStatus('invalid');
      return;
    }
    setStatus('loading');
    try {
      const [{ default: SwaggerUIBundle }] = await Promise.all([
        import('swagger-ui-dist/swagger-ui-es-bundle.js'),
        import('swagger-ui-dist/swagger-ui.css'),
      ]);
      mountRef.current.replaceChildren();
      SwaggerUIBundle({
        url: specUrl.toString(),
        domNode: mountRef.current,
        deepLinking: false,
        // Never let `?url=` / `?configUrl=` on the page reconfigure the viewer.
        queryConfigEnabled: false,
        requestInterceptor: buildRequestInterceptor(specUrl, { site, token }),
      });
      setStatus('ready');
    } catch {
      setStatus('failed');
    }
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold text-foreground">{t('explorer.title')}</h1>
        <p className="text-muted-foreground">{t('explorer.intro')}</p>
      </header>

      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" aria-label={t('explorer.title')}>
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">{t('explorer.url')}</span>
          <input
            className={inputClass}
            type="url"
            inputMode="url"
            placeholder="https://<your-cms>/api/v1/openapi.json"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('explorer.site')}</span>
          <input className={inputClass} value={site} onChange={(event) => setSite(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('explorer.token')}</span>
          <input
            className={inputClass}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={status === 'loading'}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('explorer.load')}
          </button>
          {status === 'invalid' && <span className="text-sm text-destructive">{t('explorer.invalid-url')}</span>}
          {status === 'failed' && <span className="text-sm text-destructive">{t('explorer.load-failed')}</span>}
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">{t('explorer.cors-hint')}</p>
      </form>

      <div ref={mountRef} data-testid="api-explorer-mount" className="rounded-md bg-white" />
    </main>
  );
}
