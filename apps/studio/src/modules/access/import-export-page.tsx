import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileJson, ShieldAlert, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  AccessConflict,
  AccessExportManifest,
  AccessImportDiff,
  AccessImportDiffSection,
  AccessImportDryRunResult,
  AccessImportMode,
} from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const IMPORT_MODES: Array<{ value: AccessImportMode; label: string; hint: string }> = [
  { value: 'merge', label: 'Merge', hint: 'Upsert managed refs and keep existing access rows.' },
  { value: 'replace-managed', label: 'Replace managed', hint: 'Replace refs present in the manifest.' },
  { value: 'replace-all', label: 'Replace all', hint: 'Replace all importable access rows for this site.' },
];

type AccessImportEntityDiffKey = Exclude<keyof AccessImportDiff, 'bindings'>;

const DIFF_SECTIONS: Array<{ key: AccessImportEntityDiffKey; label: string }> = [
  { key: 'roles', label: 'Roles' },
  { key: 'policies', label: 'Policies' },
  { key: 'apiKeys', label: 'API keys' },
];

const BINDING_SECTIONS: Array<{ key: keyof AccessImportDiff['bindings']; label: string }> = [
  { key: 'rolePolicies', label: 'Role policies' },
  { key: 'userRoles', label: 'User roles' },
  { key: 'userPolicies', label: 'User policies' },
  { key: 'apiKeyRoles', label: 'API key roles' },
  { key: 'apiKeyPolicies', label: 'API key policies' },
];

export function AccessImportExportPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportManifest = useMutation({
    mutationFn: async () => (await client.access.exportManifest()).data,
    onSuccess: (manifest) => {
      downloadManifest(manifest);
      setExportError(null);
    },
    onError: (error) => setExportError((error as Error).message),
  });

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Import / export</h2>
          <p className="text-xs text-muted-foreground">
            Move roles, policies, bindings, and API key access metadata between environments.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => exportManifest.mutate()}
            disabled={exportManifest.isPending}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> {exportManifest.isPending ? 'Exporting...' : 'Export'}
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Upload className="h-4 w-4" /> Import
          </button>
        </div>
      </header>

      {exportError && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {exportError}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <Capability icon={FileJson} title="Portable manifest" text="JSON includes access refs and binding priorities." />
        <Capability icon={ShieldAlert} title="Dry-run first" text="Review diff, warnings, and blocking conflicts before writes." />
        <Capability icon={CheckCircle2} title="Audited apply" text="Successful imports refresh access queries after the apply response." />
      </section>

      {importing && (
        <AccessImportDialog
          onClose={() => setImporting(false)}
          onApplied={() => {
            setImporting(false);
            queryClient.invalidateQueries({ queryKey: ['access'] });
          }}
        />
      )}
    </div>
  );
}

export function AccessImportDialog({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const client = getApiClient();
  const [manifest, setManifest] = useState<AccessExportManifest | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<AccessImportDryRunResult | null>(null);
  const [mode, setMode] = useState<AccessImportMode>('merge');
  const [applied, setApplied] = useState(false);

  const dryRunMutation = useMutation({
    mutationFn: async (input: AccessExportManifest) => (await client.access.dryRunImport(input)).data,
    onSuccess: (result) => {
      setDryRun(result);
      setApplied(false);
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!manifest) throw new Error('Choose a manifest first.');
      return (await client.access.importManifest(manifest, { mode })).data;
    },
    onSuccess: () => {
      setApplied(true);
      onApplied();
    },
  });

  const totals = useMemo(() => (dryRun ? summarizeImportDiff(dryRun.diff) : null), [dryRun]);
  const blocking = dryRun?.conflicts.conflicts ?? [];
  const warnings = dryRun?.conflicts.warnings ?? [];
  const canApply = !!manifest && !!dryRun?.valid && !dryRunMutation.isPending && !applyMutation.isPending;

  async function readManifest(file: File): Promise<void> {
    setFileName(file.name);
    setParseError(null);
    setDryRun(null);
    setApplied(false);

    try {
      const parsed = JSON.parse(await readFileText(file)) as AccessExportManifest;
      if (!parsed || parsed.schema !== 'lumibase.access@v1') {
        throw new Error('Selected file is not a LumiBase access manifest.');
      }
      setManifest(parsed);
      dryRunMutation.mutate(parsed);
    } catch (error) {
      setManifest(null);
      setParseError((error as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">Import access manifest</h3>
            <p className="text-xs text-muted-foreground">Dry-run runs immediately after a valid JSON file is selected.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import dialog"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          <label className="block rounded-md border border-dashed p-4">
            <span className="mb-2 block text-sm font-medium">Manifest JSON</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readManifest(file);
              }}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
            />
            {fileName && <span className="mt-2 block text-xs text-muted-foreground">{fileName}</span>}
          </label>

          {parseError && <AlertPanel tone="danger" title="Could not parse manifest" items={[parseError]} />}
          {dryRunMutation.error && (
            <AlertPanel tone="danger" title="Dry-run failed" items={[(dryRunMutation.error as Error).message]} />
          )}
          {dryRunMutation.isPending && <p className="text-sm text-muted-foreground">Running dry-run...</p>}

          {dryRun && (
            <>
              <div className="grid gap-2 sm:grid-cols-4">
                <Metric label="Create" value={totals?.create ?? 0} />
                <Metric label="Update" value={totals?.update ?? 0} />
                <Metric label="Unchanged" value={totals?.unchanged ?? 0} />
                <Metric label="Delete" value={totals?.delete ?? 0} />
              </div>

              <DryRunStatus dryRun={dryRun} />
              <DiffPanel diff={dryRun.diff} />
              <ConflictPanel title="Blocking conflicts" conflicts={blocking} tone="danger" />
              <ConflictPanel title="Warnings" conflicts={warnings} tone="warning" />

              <section className="rounded-md border p-3">
                <h4 className="mb-2 text-sm font-semibold">Apply mode</h4>
                <div className="grid gap-2 md:grid-cols-3">
                  {IMPORT_MODES.map((item) => (
                    <label
                      key={item.value}
                      className={cn(
                        'rounded-md border p-3 text-sm',
                        mode === item.value && 'border-primary bg-primary/5',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input
                          type="radio"
                          name="access-import-mode"
                          value={item.value}
                          checked={mode === item.value}
                          onChange={() => setMode(item.value)}
                        />
                        {item.label}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">{item.hint}</span>
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}

          {applyMutation.error && (
            <AlertPanel tone="danger" title="Import failed" items={[(applyMutation.error as Error).message]} />
          )}
          {applied && <AlertPanel tone="success" title="Import applied" items={['Access data was updated successfully.']} />}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => applyMutation.mutate()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {applyMutation.isPending ? 'Applying...' : 'Apply import'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function summarizeImportDiff(diff: AccessImportDiff): Omit<AccessImportDiffSection, 'entries'> {
  const sections = [
    diff.roles,
    diff.policies,
    diff.apiKeys,
    ...Object.values(diff.bindings),
  ];
  return sections.reduce(
    (acc, section) => ({
      create: acc.create + section.create,
      update: acc.update + section.update,
      unchanged: acc.unchanged + section.unchanged,
      delete: acc.delete + section.delete,
    }),
    { create: 0, update: 0, unchanged: 0, delete: 0 },
  );
}

function DiffPanel({ diff }: { diff: AccessImportDiff }) {
  return (
    <section className="rounded-md border">
      <h4 className="border-b px-3 py-2 text-sm font-semibold">Dry-run diff</h4>
      <div className="divide-y">
        {DIFF_SECTIONS.map((section) => (
          <DiffSection key={section.key} label={section.label} section={diff[section.key]} />
        ))}
        {BINDING_SECTIONS.map((section) => (
          <DiffSection key={section.key} label={section.label} section={diff.bindings[section.key]} />
        ))}
      </div>
    </section>
  );
}

function DiffSection({ label, section }: { label: string; section: AccessImportDiffSection }) {
  return (
    <details className="group" open={section.create + section.update + section.delete > 0}>
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          +{section.create} / ~{section.update} / ={section.unchanged} / -{section.delete}
        </span>
      </summary>
      {section.entries.length > 0 && (
        <ul className="space-y-1 px-3 pb-3 text-xs">
          {section.entries.map((entry) => (
            <li key={`${entry.ref}:${entry.status}`} className="flex items-center justify-between rounded bg-muted/40 px-2 py-1">
              <span className="font-mono">{entry.ref}</span>
              <StatusPill status={entry.status} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ConflictPanel({
  title,
  conflicts,
  tone,
}: {
  title: string;
  conflicts: AccessConflict[];
  tone: 'danger' | 'warning';
}) {
  if (!conflicts.length) return null;
  return (
    <AlertPanel
      tone={tone}
      title={`${title} (${conflicts.length})`}
      items={conflicts.map(
        (item) =>
          `${item.collection}:${item.action} ${item.reason} (${item.existingPolicy} / ${item.incomingPolicy})`,
      )}
    />
  );
}

function DryRunStatus({ dryRun }: { dryRun: AccessImportDryRunResult }) {
  const hasReview = dryRun.conflicts.warnings.length > 0 || dryRun.conflicts.conflicts.length > 0;
  if (dryRun.valid && !hasReview) {
    return <AlertPanel tone="success" title="Dry-run passed" items={['No blocking conflicts or validation errors.']} />;
  }
  if (dryRun.valid) {
    return <AlertPanel tone="warning" title="Dry-run passed with warnings" items={['Review warnings before applying.']} />;
  }
  const errors = dryRun.errors.map((error) => `${error.path ? `${error.path}: ` : ''}${error.message}`);
  return <AlertPanel tone="danger" title="Dry-run blocked" items={errors.length ? errors : ['Resolve blocking conflicts before applying.']} />;
}

function AlertPanel({
  tone,
  title,
  items,
}: {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  items: string[];
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border p-3 text-sm',
        tone === 'success' && 'border-emerald-300 bg-emerald-50 text-emerald-900',
        tone === 'warning' && 'border-amber-300 bg-amber-50 text-amber-900',
        tone === 'danger' && 'border-destructive/40 bg-destructive/10 text-destructive',
      )}
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        {tone === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {title}
      </div>
      <ul className="space-y-1 text-xs">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: AccessImportDiffSection['entries'][number]['status'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        status === 'create' && 'bg-emerald-100 text-emerald-800',
        status === 'update' && 'bg-sky-100 text-sky-800',
        status === 'unchanged' && 'bg-muted text-muted-foreground',
        status === 'delete' && 'bg-rose-100 text-rose-800',
      )}
    >
      {status}
    </span>
  );
}

function Capability({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileJson;
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <Icon className="mb-3 h-5 w-5 text-primary" />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function downloadManifest(manifest: AccessExportManifest): void {
  const body = JSON.stringify(manifest, null, 2);
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lumibase-access-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsText(file);
  });
}
