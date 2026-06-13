import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Trash2,
  Layers,
  Settings,
  FileJson,
  LayoutDashboard,
  Archive,
  Shield,
} from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { DisplayTab } from './display-tab';
import { FieldsTab } from './fields-tab';
import { RawJsonTab } from './raw-json-tab';

type Tab = 'fields' | 'display' | 'archive' | 'raw';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'fields', label: 'Fields', icon: Layers },
  { id: 'display', label: 'Display template', icon: LayoutDashboard },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'raw', label: 'Raw JSON', icon: FileJson },
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
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-4">
        <div className="h-6 w-32 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (collectionQuery.error || !collectionQuery.data) {
    return (
      <div className="mx-auto max-w-4xl px-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Collection not found.
        </div>
      </div>
    );
  }

  const collection = collectionQuery.data;

  return (
    <div className="mx-auto max-w-4xl space-y-0 px-4">
      {/* Breadcrumb */}
      <Link
        to="/data-model"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Data model
      </Link>

      {/* Collection header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-muted/40">
            <Layers className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{collection.name}</h1>
            <p className="text-xs text-muted-foreground">
              {collection.singleton ? 'Singleton' : 'Collection'} ·{' '}
              <span className="font-mono">{collection.id}</span>
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete collection "${collection.name}"? This cannot be undone.`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={deleteMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {/* Tabs */}
      <nav className="flex gap-0.5 border-b">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition-colors -mb-px ${
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <section className="pt-6">
        {tab === 'fields' && <FieldsTab collectionName={collection.name} />}
        {tab === 'display' && <DisplayTab collectionName={collection.name} />}
        {tab === 'archive' && <ArchiveTab collection={collection} />}
        {tab === 'raw' && <RawJsonTab collectionName={collection.name} />}
      </section>
    </div>
  );
}

function ArchiveTab({ collection }: { collection: { archiveField?: string | null; archiveValue?: string | null } }) {
  if (!collection.archiveField) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <Archive className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">No archive field configured</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Set up an archive field in the collection settings to enable soft-delete.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Archive className="h-4 w-4 text-muted-foreground" />
        Archive configuration
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Field</dt>
          <dd className="mt-0.5 font-mono">{collection.archiveField}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Archive value</dt>
          <dd className="mt-0.5 font-mono">{collection.archiveValue ?? '—'}</dd>
        </div>
      </dl>
    </div>
  );
}
