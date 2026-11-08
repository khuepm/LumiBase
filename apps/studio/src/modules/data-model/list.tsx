import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus, Sparkles } from 'lucide-react';
import { getApiClient } from '@/lib/api';

/**
 * Settings → Data Model: list all collections in the active site.
 * Phase A FE entry point. Wires to GET /api/v1/collections via the SDK.
 */
export function CollectionsListPage() {
  const client = getApiClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['collections'],
    queryFn: async () => {
      const res = await client.schema.listCollections();
      return res.data;
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Data model</h1>
          <p className="text-sm text-muted-foreground">
            Manage collections, fields, and relations for the active site.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/data-model/mcp-setup" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
            <Sparkles className="h-4 w-4" /> Set up MCP for AI
          </Link>
          <Link
            to="/data-model/new"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New collection
          </Link>
        </div>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading collections…</p>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load collections. Make sure the CMS Worker is running and
          your dev site has been seeded.
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-base font-medium">No collections yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start by creating your first collection.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Singleton</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="border-t hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <Link
                      to="/data-model/$name"
                      params={{ name: c.name }}
                      className="font-medium text-primary hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.singleton ? 'yes' : 'no'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.updatedAt
                      ? new Date(c.updatedAt).toLocaleString()
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
