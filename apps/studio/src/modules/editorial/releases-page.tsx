import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Eye, Globe, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ReleasePreview } from './release-preview';

/**
 * Content releases with a pre-publish validation summary (#692).
 *
 * "Check" runs `GET /releases/:id/validate`: every item the release would
 * publish, validated in full. Each issue links to the item editor at the
 * offending field (`#field=<name>`). Publish stays disabled while the last
 * check found problems; the server enforces the same gate.
 */

interface ReleaseRow {
  id: string;
  name: string;
  status: string;
  atomicityMode: string;
  publishAt: string | null;
}

interface ReleaseItemRow {
  collection: string;
  itemId: string;
  targetStatus: string;
  outcome: string | null;
  outcomeReason: string | null;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface ReleaseValidation {
  valid: boolean;
  checked: number;
  items: Array<{ collection: string; itemId: string; issues: ValidationIssue[] }>;
}

/** Hash fragment the item editor reads to focus a field. */
export function fieldHash(field: string): string {
  // Nested paths (`sections.2.data.title`) focus their top-level field.
  const top = field.split('.')[0] ?? '';
  return top ? `field=${encodeURIComponent(top)}` : '';
}

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Request failed.';
}

export function ReleasesPage() {
  const client = getApiClient();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['releases'],
    queryFn: async () => (await client.rawRequest<ReleaseRow[]>('/api/v1/releases')).data,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Releases</h1>
        <p className="text-sm text-muted-foreground">
          Bundles of items that publish together. Check a release before publishing it.
        </p>
      </header>
      {list.isLoading && <p className="text-sm text-muted-foreground">Loading releases…</p>}
      {list.error && <p className="text-sm text-destructive">{errorMessage(list.error)}</p>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
        <ul className="space-y-1" aria-label="Releases">
          {(list.data ?? []).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelected(r.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md border px-3 py-2 text-start text-sm hover:bg-muted',
                  selected === r.id && 'bg-accent',
                )}
              >
                <span className="truncate">{r.name}</span>
                <span className="ms-2 text-xs text-muted-foreground">{r.status}</span>
              </button>
            </li>
          ))}
          {list.data?.length === 0 && <li className="text-sm text-muted-foreground">No releases yet.</li>}
        </ul>
        {selected ? <ReleaseDetail id={selected} /> : null}
      </div>
    </div>
  );
}

export function ReleaseDetail({ id }: { id: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [validation, setValidation] = useState<ReleaseValidation | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const detail = useQuery({
    queryKey: ['release', id],
    queryFn: async () =>
      (await client.rawRequest<ReleaseRow & { items: ReleaseItemRow[] }>(`/api/v1/releases/${encodeURIComponent(id)}`))
        .data,
  });
  const check = useMutation({
    mutationFn: async () =>
      (await client.rawRequest<ReleaseValidation>(`/api/v1/releases/${encodeURIComponent(id)}/validate`)).data,
    onSuccess: (v) => setValidation(v),
  });
  const publish = useMutation({
    mutationFn: async () =>
      (
        await client.rawRequest<{ status: string; outcomes: Array<{ itemId: string; reason?: string }> }>(
          `/api/v1/releases/${encodeURIComponent(id)}/publish`,
          { method: 'POST' },
        )
      ).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['release', id] });
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });

  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!detail.data) return <p className="text-sm text-destructive">{errorMessage(detail.error)}</p>;
  const release = detail.data;
  const blocked = validation !== null && !validation.valid;

  return (
    <section className="space-y-4 rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{release.name}</h2>
          <p className="text-xs text-muted-foreground">
            {release.status} · {release.atomicityMode} · {release.items.length} item(s)
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            aria-pressed={previewOpen}
            disabled={release.items.length === 0}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <Eye className="h-3.5 w-3.5" />
            Preview release
          </button>
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <ListChecks className="h-3.5 w-3.5" />
            {check.isPending ? 'Checking…' : 'Check'}
          </button>
          <button
            type="button"
            onClick={() => publish.mutate()}
            disabled={blocked || publish.isPending || release.status === 'published'}
            title={blocked ? 'Fix the problems listed below first.' : undefined}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Globe className="h-3.5 w-3.5" />
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>

      {check.error && <p className="text-sm text-destructive">{errorMessage(check.error)}</p>}
      {publish.error && <p className="text-sm text-destructive">{errorMessage(publish.error)}</p>}
      {publish.data && (
        <p className="text-sm" role="status">
          Publish result: <strong>{publish.data.status}</strong>
        </p>
      )}

      {previewOpen && <ReleasePreview releaseId={release.id} items={release.items} />}

      {validation && (
        <ValidationSummary validation={validation} />
      )}

      <table className="w-full text-sm">
        <thead className="text-start text-xs text-muted-foreground">
          <tr>
            <th className="py-1">Collection</th>
            <th>Item</th>
            <th>Target</th>
            <th>Last outcome</th>
          </tr>
        </thead>
        <tbody>
          {release.items.map((it) => (
            <tr key={`${it.collection}:${it.itemId}`} className="border-t">
              <td className="py-1">{it.collection}</td>
              <td>
                <Link
                  to="/content/$collection/$id"
                  params={{ collection: it.collection, id: it.itemId }}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {it.itemId}
                </Link>
              </td>
              <td>{it.targetStatus}</td>
              <td className="text-xs text-muted-foreground">
                {it.outcome ? `${it.outcome}${it.outcomeReason ? ` (${it.outcomeReason})` : ''}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ValidationSummary({ validation }: { validation: ReleaseValidation }) {
  if (validation.valid) {
    return (
      <p className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400" role="status">
        <CheckCircle2 className="h-4 w-4" />
        All {validation.checked} item(s) pass validation.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" role="alert">
      <p className="mb-2 flex items-center gap-1 text-sm font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {validation.items.length} item(s) cannot be published
      </p>
      <ul className="space-y-2 text-sm">
        {validation.items.map((item) => (
          <li key={`${item.collection}:${item.itemId}`}>
            <p className="font-mono text-xs text-muted-foreground">
              {item.collection} / {item.itemId}
            </p>
            <ul className="ms-4 list-disc">
              {item.issues.map((issue, i) => (
                <li key={`${issue.field}:${i}`}>
                  <Link
                    to="/content/$collection/$id"
                    params={{ collection: item.collection, id: item.itemId }}
                    hash={fieldHash(issue.field)}
                    className="text-primary hover:underline"
                  >
                    {issue.field || 'item'}
                  </Link>
                  : {issue.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
