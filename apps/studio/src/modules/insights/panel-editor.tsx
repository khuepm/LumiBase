import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AGGREGATES, PANEL_TYPES, type Aggregate, type PanelQuery, type PanelType } from '@lumibase/shared';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { insightsApi, type Panel } from './api';

/**
 * Inline panel editor (Req 7). Structured form → PanelQuery; field selectors
 * are restricted to the chosen collection's fields (matching the backend
 * whitelist). Includes a live preview before saving.
 * See `.kiro/specs/insights-dashboard`.
 */

interface Props {
  dashboardId: string;
  existing?: Panel;
  onClose: () => void;
}

export function PanelEditor({ dashboardId, existing, onClose }: Props) {
  const client = getApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<PanelType>(existing?.type ?? 'metric');
  const [collection, setCollection] = useState(existing?.query.collection ?? '');
  const [aggregate, setAggregate] = useState<Aggregate>(existing?.query.aggregate ?? 'count');
  const [field, setField] = useState(existing?.query.field ?? '');
  const [groupBy, setGroupBy] = useState(existing?.query.groupBy ?? '');

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });
  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
    enabled: !!collection,
  });

  const collections = (collectionsQuery.data ?? []) as { name: string }[];
  const fields = (fieldsQuery.data ?? []) as { name: string }[];

  const buildQuery = (): PanelQuery => ({
    collection,
    aggregate,
    ...(aggregate !== 'count' && field ? { field } : {}),
    ...(groupBy ? { groupBy } : {}),
  });

  const previewMutation = useMutation({
    mutationFn: () => insightsApi.previewPanel(dashboardId, buildQuery()),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        type,
        position: existing?.position ?? { x: 0, y: 0, w: 4, h: 4 },
        query: buildQuery(),
      };
      return existing
        ? insightsApi.updatePanel(dashboardId, existing.id, payload)
        : insightsApi.createPanel(dashboardId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights-panels', dashboardId] });
      onClose();
    },
  });

  const canSave = name.trim() && collection && (aggregate === 'count' || field);

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="grid grid-cols-2 gap-3">
        <Labeled label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border px-2 py-1 text-sm" />
        </Labeled>
        <Labeled label="Type">
          <select value={type} onChange={(e) => setType(e.target.value as PanelType)} className="w-full rounded border px-2 py-1 text-sm">
            {PANEL_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Collection">
          <select value={collection} onChange={(e) => { setCollection(e.target.value); setField(''); setGroupBy(''); }} className="w-full rounded border px-2 py-1 text-sm">
            <option value="">Select…</option>
            {collections.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Aggregate">
          <select value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)} className="w-full rounded border px-2 py-1 text-sm">
            {AGGREGATES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </Labeled>
        {aggregate !== 'count' && (
          <Labeled label="Field">
            <select value={field} onChange={(e) => setField(e.target.value)} className="w-full rounded border px-2 py-1 text-sm">
              <option value="">Select…</option>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </Labeled>
        )}
        <Labeled label="Group by (optional)">
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-full rounded border px-2 py-1 text-sm">
            <option value="">None</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        </Labeled>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => previewMutation.mutate()} disabled={!collection || (aggregate !== 'count' && !field)} className="rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50">
          Preview
        </button>
        <button type="button" onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
          {existing ? 'Save' : 'Add panel'}
        </button>
        <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm hover:bg-muted">Cancel</button>
        {saveMutation.isError && <span className="text-xs text-destructive">{(saveMutation.error as Error).message}</span>}
      </div>

      {previewMutation.isError && <p className="text-xs text-destructive">{(previewMutation.error as Error).message}</p>}
      {previewMutation.data && (
        <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-xs">
          {JSON.stringify(previewMutation.data.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
