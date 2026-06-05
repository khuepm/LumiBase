import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/lib/api';

type Step = 1 | 2 | 3 | 4 | 5;
type PrimaryKeyType = 'nanoid' | 'uuid' | 'string' | 'integer' | 'bigInteger';
type StorageMode = 'jsonb' | 'materialized' | 'physical' | 'external';
type PermissionDefault = 'inherit' | 'private' | 'public-read';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 1, label: 'Identity' },
  { id: 2, label: 'Storage' },
  { id: 3, label: 'System fields' },
  { id: 4, label: 'Permissions' },
  { id: 5, label: 'Review' },
];

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function CollectionWizardPage() {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [pluralLabel, setPluralLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [hidden, setHidden] = useState(false);
  const [singleton, setSingleton] = useState(false);
  const [note, setNote] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [accountability, setAccountability] = useState<'all' | 'activity' | 'none'>('all');
  const [primaryKeyType, setPrimaryKeyType] = useState<PrimaryKeyType>('nanoid');
  const [storageMode, setStorageMode] = useState<StorageMode>('jsonb');
  const [statusField, setStatusField] = useState(true);
  const [sortField, setSortField] = useState(true);
  const [archiveField, setArchiveField] = useState(false);
  const [auditFields, setAuditFields] = useState(true);
  const [permissionDefault, setPermissionDefault] = useState<PermissionDefault>('inherit');

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = getApiClient();
  const storageWarning =
    storageMode === 'jsonb' && (primaryKeyType === 'integer' || primaryKeyType === 'bigInteger')
      ? 'Integer primary keys require materialized or physical storage mode.'
      : null;

  const createPayload = useMemo(
    () => ({
      name,
      label: label || null,
      pluralLabel: pluralLabel || null,
      hidden,
      singleton,
      icon: icon || null,
      color: color || null,
      note: note || null,
      accountability,
      versioning,
      primaryKeyType,
      storageMode,
      primaryKeyField: 'id',
      sortField: sortField ? 'sort' : null,
      archiveField: archiveField ? 'status' : null,
      archiveValue: archiveField ? 'archived' : null,
      unarchiveValue: archiveField ? 'draft' : null,
      meta: {
        systemFields: {
          status: statusField,
          sort: sortField,
          archive: archiveField,
          audit: auditFields,
        },
        permissionDefault,
      },
    }),
    [
      accountability,
      archiveField,
      auditFields,
      color,
      hidden,
      icon,
      label,
      name,
      note,
      permissionDefault,
      pluralLabel,
      primaryKeyType,
      singleton,
      sortField,
      statusField,
      storageMode,
      versioning,
    ],
  );

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.schema.createCollection(createPayload);
      return res.data;
    },
    onSuccess: (collection) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      navigate({ to: '/data-model/$name', params: { name: collection.name } });
    },
  });

  const nameValid = NAME_PATTERN.test(name);
  const canNext = step === 1 ? nameValid : step === 2 ? !storageWarning : true;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New collection</h1>
        <p className="text-sm text-muted-foreground">
          Step {step} of 5 — {STEPS.find((s) => s.id === step)?.label.toLowerCase()}
        </p>
      </header>

      <ol className="flex gap-2">
        {STEPS.map((s) => (
          <li
            key={s.id}
            aria-label={s.label}
            className={`h-1 flex-1 rounded ${
              s.id <= step ? 'bg-primary' : 'bg-muted'
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
            {name && !nameValid && (
              <p className="mt-1 text-xs text-destructive">
                Invalid format — must match {String(NAME_PATTERN)}
              </p>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Post"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Plural label</span>
            <input
              value={pluralLabel}
              onChange={(e) => setPluralLabel(e.target.value)}
              placeholder="Posts"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Icon</span>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="newspaper"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Color</span>
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#2563eb"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => setHidden(e.target.checked)}
            />
            <span className="text-sm">Hide from navigation</span>
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 rounded-lg border p-6">
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
          {storageWarning && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {storageWarning}
            </p>
          )}

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={singleton}
              onChange={(e) => setSingleton(e.target.checked)}
            />
            <span className="text-sm">Singleton</span>
          </label>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4 rounded-lg border p-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={statusField}
              onChange={(e) => setStatusField(e.target.checked)}
            />
            <span className="text-sm">Status field</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sortField}
              onChange={(e) => setSortField(e.target.checked)}
            />
            <span className="text-sm">Sort field</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archiveField}
              onChange={(e) => setArchiveField(e.target.checked)}
            />
            <span className="text-sm">Archive behavior</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={auditFields}
              onChange={(e) => setAuditFields(e.target.checked)}
            />
            <span className="text-sm">Created and updated fields</span>
          </label>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4 rounded-lg border p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Permission defaults</span>
            <select
              value={permissionDefault}
              onChange={(e) => setPermissionDefault(e.target.value as PermissionDefault)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="inherit">Inherit default</option>
              <option value="private">Private</option>
              <option value="public-read">Public read</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Description</span>
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
              <option value="all">All</option>
              <option value="activity">Activity only</option>
              <option value="none">None</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={versioning}
              onChange={(e) => setVersioning(e.target.checked)}
            />
            <span className="text-sm">Enable content versioning</span>
          </label>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-3 rounded-lg border p-6 text-sm">
          <pre
            aria-label="Review JSON"
            className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs"
          >
            {JSON.stringify(createPayload, null, 2)}
          </pre>
          {storageWarning && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              {storageWarning}
            </p>
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
        {step < 5 ? (
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
            disabled={create.isPending || Boolean(storageWarning)}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? 'Creating...' : 'Create collection'}
          </button>
        )}
      </div>
    </div>
  );
}
