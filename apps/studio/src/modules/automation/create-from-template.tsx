import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * "Create from template" for the Flows page (Jev J11, #518).
 *
 * Loads the automation templates (`GET /ai/automation/templates`), lets an
 * admin edit the template parameters as JSON (pre-filled with the example),
 * builds the flow server-side (`POST /ai/automation/templates/:key/build`,
 * which validates and writes nothing) and saves it as a DRAFT manual flow
 * through the normal flows API. Activating it stays a separate step in the
 * editor, and the flow runs in shadow mode unless the site's automation gate
 * says otherwise.
 *
 * All calls go through `getApiClient()` so the shell's API base and bearer
 * apply (shell contract C2).
 */

interface TemplateView {
  key: string;
  name: string;
  description: string;
  exampleParams: Record<string, unknown>;
  parameters: Array<{ name: string; type: string; required: boolean; description: string }>;
}

function messageOf(err: unknown): string {
  if (err instanceof LumiError) {
    const errors = (err.body as { errors?: Array<{ message?: string; path?: string[] }> })?.errors ?? [];
    if (errors.length > 0) {
      return errors.map((e) => (e.path && e.path.length > 0 ? `${e.path.join('.')}: ${e.message}` : e.message)).join('; ');
    }
  }
  return err instanceof Error ? err.message : 'Request failed.';
}

export function CreateFromTemplate({ onCreated }: { onCreated?: (flowId: string) => void }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>('');
  const [params, setParams] = useState('');
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ['automation-templates'],
    queryFn: async () => (await client.rawRequest<TemplateView[]>('/api/v1/ai/automation/templates')).data,
    retry: false,
  });

  const create = useMutation({
    mutationFn: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params);
      } catch {
        throw new Error('Parameters must be valid JSON.');
      }
      const built = await client.rawRequest<Record<string, unknown>>(
        `/api/v1/ai/automation/templates/${encodeURIComponent(selected)}/build`,
        { method: 'POST', body: JSON.stringify(parsed) },
      );
      const saved = await client.rawRequest<{ id: string }>('/api/v1/flows', {
        method: 'POST',
        body: JSON.stringify(built.data),
      });
      return saved.data;
    },
    onSuccess: (flow) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['flows'] });
      onCreated?.(flow.id);
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (templates.isLoading) return <p className="text-sm text-muted-foreground">Loading templates…</p>;
  if (templates.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        {templates.error instanceof LumiError && templates.error.status === 403
          ? 'Automation templates are available to site admins only.'
          : 'Failed to load automation templates.'}
      </p>
    );
  }

  const list = templates.data ?? [];
  const current = list.find((t) => t.key === selected);

  return (
    <section aria-labelledby="flow-templates-heading" className="space-y-3 rounded-lg border p-4">
      <h2 id="flow-templates-heading" className="font-semibold">
        Create from template
      </h2>
      <label className="block text-sm">
        <span className="mb-1 block">Template</span>
        <select
          aria-label="Template"
          value={selected}
          onChange={(e) => {
            const key = e.target.value;
            setSelected(key);
            const template = list.find((t) => t.key === key);
            setParams(template ? JSON.stringify(template.exampleParams, null, 2) : '');
            setError(null);
          }}
          className="rounded border px-2 py-1"
        >
          <option value="">Choose a template…</option>
          {list.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <>
          <p className="text-sm text-muted-foreground">{current.description}</p>
          <label className="block text-sm">
            <span className="mb-1 block">Parameters (JSON)</span>
            <textarea
              aria-label="Template parameters"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              rows={10}
              className="w-full rounded border p-2 font-mono text-xs"
            />
          </label>
          <ul className="text-xs text-muted-foreground">
            {current.parameters.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code> ({p.type}
                {p.required ? ', required' : ''}) — {p.description}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Saved as a draft manual flow. It records suggestions in shadow mode until a site admin sets the automation gate.
          </p>
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Create draft flow
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
