import Editor from '@/components/lazy-monaco-editor';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { generateTypes, type TypegenManifest } from '@lumibase/sdk';
import { getApiClient, getActiveSite } from '@/lib/api';

/**
 * Settings → Developer → Types page.
 * Fetches the typegen manifest from the API and previews the generated
 * `lumibase-types.ts` file in a Monaco editor with a download button.
 */
export function DeveloperTypesPage() {
  const client = getApiClient();
  const site = getActiveSite();

  const manifestQuery = useQuery({
    queryKey: ['typegen', site],
    queryFn: async () => {
      const res = await client.schema.typegen();
      return res.data as TypegenManifest;
    },
  });

  const code = manifestQuery.data ? generateTypes(manifestQuery.data) : '';
  const curlSnippet = `curl -H "X-Lumi-Site: ${site}" \\
  -H "Authorization: Bearer $LUMI_TOKEN" \\
  ${window.location.origin}/api/v1/typegen/schema`;
  const cliSnippet = `pnpm lumibase typegen --site ${site} --out ./lumibase-types.ts`;

  const downloadFile = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lumibase-types.ts';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Developer · Types</h1>
        <p className="text-sm text-muted-foreground">
          Generate TypeScript types for the current site schema.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">CLI</h2>
        <pre className="rounded-md bg-muted p-3 text-xs">{cliSnippet}</pre>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">curl</h2>
        <pre className="rounded-md bg-muted p-3 text-xs">{curlSnippet}</pre>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Preview</h2>
          <button
            type="button"
            onClick={downloadFile}
            disabled={!code}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
          >
            <Download className="h-3 w-3" /> Download lumibase-types.ts
          </button>
        </div>
        {manifestQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading manifest…</p>
        )}
        {manifestQuery.error && (
          <p className="text-sm text-destructive">
            Failed to fetch manifest. Make sure your dev token has access to
            this site.
          </p>
        )}
        {code && (
          <div className="overflow-hidden rounded-md border" dir="ltr">
            <Editor
              height="500px"
              defaultLanguage="typescript"
              value={code}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
