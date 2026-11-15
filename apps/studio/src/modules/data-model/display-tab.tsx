import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { DISPLAY_CATALOGUE } from '@/modules/content/displays/registry';
import { DisplayTemplateEditor } from '@/modules/content/display-template-editor';
import { PreviewUrlSection } from './preview-url-section';

interface DisplayTabProps {
  collectionName: string;
}

/**
 * Display tab — Phase B.
 *
 * Two responsibilities:
 *
 * 1. **Collection-level `displayTemplate`** — drives the row label used
 *    by relation displays and reference pickers. Edited via the
 *    Mustache template editor with autocomplete + live preview.
 *
 * 2. **Per-field display overview** — read-only mirror of which display
 *    each field currently uses. Authors change the display from the
 *    field inspector (Fields tab); this view is for at-a-glance audit
 *    and so the page is no longer the empty placeholder it was at the
 *    end of Phase A.
 */
export function DisplayTab({ collectionName }: DisplayTabProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();

  const collectionQuery = useQuery({
    queryKey: ['collection', collectionName],
    queryFn: async () => (await client.schema.getCollection(collectionName)).data,
  });

  const fieldsQuery = useQuery({
    queryKey: ['fields', collectionName],
    queryFn: async () => (await client.schema.listFields(collectionName)).data,
  });

  const [template, setTemplate] = useState('');
  // Hydrate local template from server once the collection loads.
  useEffect(() => {
    if (collectionQuery.data) {
      setTemplate(collectionQuery.data.displayTemplate ?? '');
    }
  }, [collectionQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      client.schema.updateCollection(collectionName, {
        displayTemplate: template || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', collectionName] });
    },
  });

  const fields = fieldsQuery.data ?? [];
  const dirty =
    collectionQuery.data && (collectionQuery.data.displayTemplate ?? '') !== template;

  return (
    <div className="space-y-6">
      <PreviewUrlSection collectionName={collectionName} />

      <section>
        <header className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Display template</h3>
            <p className="text-xs text-muted-foreground">
              Used to label rows in relation pickers and references.
            </p>
          </div>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </header>
        <DisplayTemplateEditor
          value={template || null}
          onChange={(next) => setTemplate(next ?? '')}
          fields={fields.map((f) => ({
            name: f.name,
            type: f.type,
            hint: `${f.type}/${f.interface}`,
          }))}
          sample={Object.fromEntries(
            fields.map((f) => [f.name, sampleFor(f.type, f.name)]),
          )}
        />
      </section>

      <section>
        <header className="mb-2">
          <h3 className="text-sm font-medium">Per-field displays</h3>
          <p className="text-xs text-muted-foreground">
            Edit the display for a field from the Fields tab inspector.
          </p>
        </header>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-start text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Field</th>
                <th className="px-3 py-2">Interface</th>
                <th className="px-3 py-2">Display</th>
              </tr>
            </thead>
            <tbody>
              {fields.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No fields yet.
                  </td>
                </tr>
              )}
              {fields.map((f) => {
                const displayKey = (f as unknown as { display?: string | null }).display;
                const known = DISPLAY_CATALOGUE.find((d) => d.id === displayKey);
                return (
                  <tr key={f.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{f.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.interface}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {displayKey ? (
                        <span title={known?.hint}>
                          {known?.label ?? displayKey}
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">auto</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function sampleFor(type: string, name: string): unknown {
  if (type === 'boolean') return true;
  if (type === 'integer' || type === 'decimal') return 42;
  if (type === 'datetime' || type === 'date' || type === 'timestamp')
    return new Date().toISOString();
  return `<${name}>`;
}
