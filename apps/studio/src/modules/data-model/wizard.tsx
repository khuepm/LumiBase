import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

type Step = 1 | 2 | 3;
type PrimaryKeyType = 'nanoid' | 'uuid' | 'string' | 'integer' | 'bigInteger';
type StorageMode = 'jsonb' | 'materialized' | 'physical' | 'external';

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Three-step wizard for creating a new collection.
 *  1. Identity — machine name + display options
 *  2. Defaults — accountability, versioning, archive flags
 *  3. Review — summary + create
 */
export function CollectionWizardPage() {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [singleton, setSingleton] = useState(false);
  const [note, setNote] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [accountability, setAccountability] = useState<'all' | 'activity' | 'none'>('all');
  const [primaryKeyType, setPrimaryKeyType] = useState<PrimaryKeyType>('nanoid');
  const [storageMode, setStorageMode] = useState<StorageMode>('jsonb');

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = getApiClient();

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.schema.createCollection({
        name,
        singleton,
        note: note || null,
        accountability,
        versioning,
        primaryKeyType,
        storageMode,
      });
      return res.data;
    },
    onSuccess: (collection) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      navigate({ to: '/data-model/$name', params: { name: collection.name } });
    },
  });

  const nameValid = NAME_PATTERN.test(name);
  const canNext = step === 1 ? nameValid : true;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New collection</h1>
        <p className="text-sm text-muted-foreground">
          Step {step} of 3 — {step === 1 ? 'identity' : step === 2 ? 'defaults' : 'review'}
        </p>
      </header>

      <ol className="flex gap-2">
        {([1, 2, 3] as const).map((s) => (
          <li
            key={s}
            className={`h-1 flex-1 rounded ${
              s <= step ? 'bg-primary' : 'bg-muted'
            }`}
          />
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-4 rounded-lg border p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Machine name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="posts"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              autoFocus
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Lowercase letters, digits, underscore. Must start with a letter.
            </p>
            {name && !nameValid && (
              <p className="mt-1 text-xs text-destructive">
                Invalid format — must match {String(NAME_PATTERN)}
              </p>
            )}
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={singleton}
              onChange={(e) => setSingleton(e.target.checked)}
            />
            <span className="text-sm">Singleton (only one item)</span>
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 rounded-lg border p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Description (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Accountability</span>
            <select
              value={accountability}
              onChange={(e) => setAccountability(e.target.value as typeof accountability)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="all">All (revisions + activity)</option>
              <option value="activity">Activity only</option>
              <option value="none">None</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Primary key</span>
            <select
              value={primaryKeyType}
              onChange={(e) => setPrimaryKeyType(e.target.value as PrimaryKeyType)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="nanoid">Nano ID</option>
              <option value="uuid">UUID</option>
              <option value="string">String provided by API</option>
              <option value="integer">Integer sequence</option>
              <option value="bigInteger">Big integer sequence</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Storage mode</span>
            <select
              value={storageMode}
              onChange={(e) => setStorageMode(e.target.value as StorageMode)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="jsonb">JSONB document store</option>
              <option value="materialized">Materialized projection</option>
              <option value="physical">Physical table</option>
              <option value="external">External table</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={versioning}
              onChange={(e) => setVersioning(e.target.checked)}
            />
            <span className="text-sm">Enable content versioning (drafts)</span>
          </label>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3 rounded-lg border p-6 text-sm">
          <div>
            <span className="text-muted-foreground">Name:</span>{' '}
            <span className="font-medium">{name}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Singleton:</span>{' '}
            {singleton ? 'yes' : 'no'}
          </div>
          <div>
            <span className="text-muted-foreground">Versioning:</span>{' '}
            {versioning ? 'yes' : 'no'}
          </div>
          <div>
            <span className="text-muted-foreground">Accountability:</span>{' '}
            {accountability}
          </div>
          <div>
            <span className="text-muted-foreground">Primary key:</span>{' '}
            {primaryKeyType}
          </div>
          <div>
            <span className="text-muted-foreground">Storage mode:</span>{' '}
            {storageMode}
          </div>
          {note && (
            <div>
              <span className="text-muted-foreground">Note:</span> {note}
            </div>
          )}
          {create.error && (
            <p className="text-destructive">
              {(create.error as Error).message}
            </p>
          )}
        </div>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => (step > 1 ? setStep((step - 1) as Step) : navigate({ to: '/data-model' }))}
          className="rounded-md border px-4 py-2 text-sm"
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step < 3 ? (
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setStep((step + 1) as Step)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create collection'}
          </button>
        )}
      </div>
    </div>
  );
}
