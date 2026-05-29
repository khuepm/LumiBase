import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { DisplayTab } from './display-tab';
import { FieldsTab } from './fields-tab';
import { RawJsonTab } from './raw-json-tab';

type Tab = 'fields' | 'display' | 'archive' | 'raw';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'fields', label: 'Fields' },
  { id: 'display', label: 'Display' },
  { id: 'archive', label: 'Archive' },
  { id: 'raw', label: 'Raw JSON' },
];

export function CollectionDetailPage() {
  const { name } = useParams({ from: '/admin-layout/data-model/$name' });
  const [tab, setTab] = useState<Tab>('fields');
  const client = getApiClient();
  const queryClient = useQueryClient();

  const collectionQuery = useQuery({
    queryKey: ['collection', name],
    queryFn: async () => (await client.schema.getCollection(name)).data,
  });

  const deleteMutation = useMutation({
    mutationFn: () => client.schema.deleteCollection(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      window.location.href = '/data-model';
    },
  });

  if (collectionQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (collectionQuery.error || !collectionQuery.data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Collection not found.
      </div>
    );
  }

  const collection = collectionQuery.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        to="/data-model"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> Back to collections
      </Link>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{collection.name}</h1>
          <p className="text-sm text-muted-foreground">
            {collection.singleton ? 'Singleton' : 'Collection'} ·{' '}
            {collection.id}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete collection "${collection.name}"?`)) {
              deleteMutation.mutate();
            }
          }}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </header>

      <nav className="flex gap-1 border-b">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <section>
        {tab === 'fields' && <FieldsTab collectionName={collection.name} />}
        {tab === 'display' && <DisplayTab collectionName={collection.name} />}
        {tab === 'archive' && (
          <p className="text-sm text-muted-foreground">
            Archive field: {collection.archiveField || '—'} · value:{' '}
            {collection.archiveValue || '—'}
          </p>
        )}
        {tab === 'raw' && <RawJsonTab collectionName={collection.name} />}
      </section>
    </div>
  );
}
