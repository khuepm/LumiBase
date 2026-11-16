import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { getApiClient, getActiveSite } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Settings → Developer → Types: the live OpenAPI switch (#745).
 *
 * Reads and writes `GET|PUT /api/v1/openapi/config` (site admin). The
 * document itself is `GET /api/v1/openapi.json`; it stays a 404 until this is
 * on AND the caller's realm is ticked.
 */
export const OPENAPI_REALMS = [
  { id: 'studio', label: 'Studio staff sessions' },
  { id: 'frontend', label: 'Frontend subscriber sessions' },
  { id: 'api_key', label: 'API keys' },
  { id: 'public', label: 'Public (anonymous) — needs public access enabled' },
] as const;

export type OpenApiRealmId = (typeof OPENAPI_REALMS)[number]['id'];

export interface OpenApiConfig {
  enabled: boolean;
  realms: OpenApiRealmId[];
}

const CONFIG_PATH = '/api/v1/openapi/config';

function describeError(err: unknown): string {
  if (err instanceof LumiError && err.status === 403) return 'Only site admins can change the OpenAPI setting.';
  return 'Failed to load or save the OpenAPI setting.';
}

export function OpenApiSettingsCard() {
  const client = getApiClient();
  const site = getActiveSite();
  const qc = useQueryClient();
  const enabledId = useId();
  const [form, setForm] = useState<OpenApiConfig | null>(null);

  const configQuery = useQuery({
    queryKey: ['openapi-config', site],
    queryFn: async () => (await client.rawRequest<OpenApiConfig>(CONFIG_PATH)).data,
  });

  useEffect(() => {
    if (configQuery.data) setForm(configQuery.data);
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: async (next: OpenApiConfig) =>
      (await client.rawRequest<OpenApiConfig>(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(next) })).data,
    onSuccess: (data) => {
      qc.setQueryData(['openapi-config', site], data);
    },
  });

  const toggleRealm = (realm: OpenApiRealmId, on: boolean) =>
    setForm((prev) =>
      prev ? { ...prev, realms: on ? [...new Set([...prev.realms, realm])] : prev.realms.filter((r) => r !== realm) } : prev,
    );

  // Same base URL resolution the SDK uses (desktop shell override included, DoD §2d).
  const documentUrl = `${getApiBaseUrl() || window.location.origin}/api/v1/openapi.json`;

  return (
    <section className="space-y-3 rounded-md border p-4" aria-labelledby={`${enabledId}-title`}>
      <div>
        <h2 id={`${enabledId}-title`} className="text-sm font-medium">
          Live OpenAPI document
        </h2>
        <p className="text-xs text-muted-foreground">
          Serves <code>/api/v1/openapi.json</code>, generated from this site&apos;s schema and filtered by each
          caller&apos;s permissions. Off by default; while off it answers 404.
        </p>
      </div>

      {configQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {configQuery.error && <p className="text-sm text-destructive">{describeError(configQuery.error)}</p>}

      {form && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(form);
          }}
        >
          <label htmlFor={enabledId} className="flex items-center gap-2 text-sm">
            <input
              id={enabledId}
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Enable the OpenAPI endpoint
          </label>

          <fieldset className="space-y-1" disabled={!form.enabled}>
            <legend className="text-xs font-medium">Who may fetch it</legend>
            {OPENAPI_REALMS.map((realm) => (
              <label key={realm.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.realms.includes(realm.id)}
                  onChange={(event) => toggleRealm(realm.id, event.target.checked)}
                />
                {realm.label}
              </label>
            ))}
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={save.isPending}
              className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {save.isSuccess && <span className="text-xs text-muted-foreground">Saved.</span>}
            {save.error && <span className="text-xs text-destructive">{describeError(save.error)}</span>}
          </div>

          {form.enabled && (
            <pre className="rounded-md bg-muted p-3 text-xs">{`curl -H "X-Lumi-Site: ${site}" \\
  -H "Authorization: Bearer $LUMI_TOKEN" \\
  ${documentUrl}`}</pre>
          )}
        </form>
      )}
    </section>
  );
}
