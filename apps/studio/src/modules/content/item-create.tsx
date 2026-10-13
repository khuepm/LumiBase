import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Lock, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FieldResource, ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { FieldsTab } from './item-detail';

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Create failed.';
}

/** New-item form: creates a draft, then hands off to the regular editor. */
export function ItemCreate({ collection }: { collection: string }) {
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const canCreate = perms.can(collection, 'create');
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const fields: FieldResource[] = useMemo(
    () =>
      (fieldsQuery.data ?? [])
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'create', f.name)),
    [fieldsQuery.data, perms, collection],
  );

  const createMutation = useMutation({
    mutationFn: async () =>
      (await client.items(collection as never).create({ data: draft, status: 'draft' })).data as ItemRow,
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      navigate({ to: '/content/$collection/$id', params: { collection, id: item.id }, replace: true });
    },
  });

  if (!canCreate) {
    return (
      <p className="text-sm text-muted-foreground">You do not have create permission on this collection.</p>
    );
  }
  if (fieldsQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading fields…</p>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            <Link to="/" className="hover:underline">Content</Link>
            <span className="mx-1">/</span>
            <Link to="/content/$collection" params={{ collection }} className="hover:underline">
              {collection}
            </Link>
            <span className="mx-1">/</span>
            <span>new</span>
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Back to list"
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            New item
          </h1>
        </div>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className={cn(
            'inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50',
          )}
        >
          {createMutation.isPending ? <Lock className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {createMutation.isPending ? 'Creating…' : 'Create draft'}
        </button>
      </header>

      {createMutation.error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {errorMessage(createMutation.error)}
        </div>
      )}

      <section className="rounded-lg border bg-background p-4">
        <FieldsTab
          fields={fields}
          value={draft}
          onChange={setDraft}
          collection={collection}
          perms={perms}
          pinnedFields={[]}
          writeAction="create"
        />
      </section>
    </div>
  );
}
