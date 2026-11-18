import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LayoutTemplate, Plus } from 'lucide-react';
import { useState } from 'react';
import { PAGE_LAYOUT_VERSION } from '@lumibase/contracts';
import { getApiClient } from '@/lib/api';

/** Pages (delivery page-builder rows) with a link to the composer (V06 #684). */

interface PageRow {
  id: string;
  slug: string;
  title: string;
  updatedAt: string;
}

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Request failed.';
}

export function PagesListPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');

  const pages = useQuery({
    queryKey: ['pages'],
    queryFn: async () => (await client.rawRequest<PageRow[]>('/api/v1/pages')).data,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.rawRequest<PageRow>('/api/v1/pages', {
          method: 'POST',
          body: JSON.stringify({
            title: title.trim(),
            slug: slug.trim(),
            layoutConfig: { version: PAGE_LAYOUT_VERSION, regions: [{ key: 'main' }], sections: [] },
          }),
        })
      ).data,
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      setTitle('');
      setSlug('');
      void navigate({ to: '/pages/$id', params: { id: row.id } });
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <LayoutTemplate className="h-6 w-6" /> Pages
        </h1>
        <p className="text-sm text-muted-foreground">
          Delivery pages composed from page blocks, served by <code>/api/v1/deliver/page/:site/:slug</code>.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="text-xs text-muted-foreground">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="mt-1 block rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            placeholder="about/team"
            className="mt-1 block rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={create.isPending || !title.trim() || !slug.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> New page
        </button>
        {create.error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {errorMessage(create.error)}
          </p>
        )}
      </form>

      {pages.isLoading && <p className="text-sm text-muted-foreground">Loading pages…</p>}
      {pages.error && <p className="text-sm text-destructive">{errorMessage(pages.error)}</p>}
      <ul className="divide-y rounded-lg border">
        {pages.data?.map((p) => (
          <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <Link to="/pages/$id" params={{ id: p.id }} className="text-primary hover:underline">
              {p.title}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">/{p.slug}</span>
          </li>
        ))}
        {pages.data?.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No pages yet.</li>}
      </ul>
    </div>
  );
}
