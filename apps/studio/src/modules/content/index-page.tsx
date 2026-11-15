import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, FileText } from 'lucide-react';
import { getApiClient } from '@/lib/api';

/**
 * Content module landing page. Lists the collections available in the active
 * site as cards; clicking one navigates to the items list view.
 */
export function ContentIndexPage() {
  const client = getApiClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Content</h1>
        <p className="text-sm text-muted-foreground">
          Pick a collection to browse, filter, and edit items. Bundles of items that publish
          together live under <Link to="/releases" className="text-primary hover:underline">Releases</Link>.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading collections…</p>}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load collections.
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-base font-medium">No collections yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Define one in <Link to="/data-model" className="text-primary hover:underline">Data model</Link>.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((c) => (
            <li key={c.id}>
              <Link
                to="/content/$collection"
                params={{ collection: c.name }}
                className="block rounded-lg border p-4 transition hover:border-primary hover:shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{c.name}</span>
                </div>
                {c.singleton && (
                  <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    singleton
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
