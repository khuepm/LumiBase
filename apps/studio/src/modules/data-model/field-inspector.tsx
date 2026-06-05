import { useMemo, useState } from 'react';
import { DISPLAY_CATALOGUE } from '@/modules/content/displays/registry';
import { MustacheTemplateEditor } from '@/modules/content/mustache-template-editor';

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Phase B inspector — covers every interface listed in the Phase B
 * roadmap so authors can actually pick the new editors from the UI.
 *
 * The catalogue is grouped purely for human readability; the registry
 * inside `modules/content/interfaces/registry.tsx` is the source of
 * truth for which keys actually have a renderer.
 */
interface InterfaceMeta {
  id: string;
  label: string;
  type: string;
  group: string;
}

const INTERFACES: InterfaceMeta[] = [
  // Text
  { id: 'input', label: 'Input (single line)', type: 'string', group: 'Text' },
  { id: 'input-multiline', label: 'Input (multiline)', type: 'text', group: 'Text' },
  { id: 'wysiwyg', label: 'WYSIWYG', type: 'text', group: 'Text' },
  { id: 'markdown', label: 'Markdown', type: 'text', group: 'Text' },
  { id: 'code', label: 'Code (Monaco)', type: 'text', group: 'Text' },
  { id: 'slug', label: 'Slug', type: 'string', group: 'Text' },
  { id: 'color', label: 'Color', type: 'string', group: 'Text' },
  // Number
  { id: 'input-number', label: 'Number', type: 'integer', group: 'Number' },
  { id: 'rating', label: 'Rating', type: 'integer', group: 'Number' },
  // Choice
  { id: 'select-dropdown', label: 'Dropdown', type: 'string', group: 'Choice' },
  { id: 'tags', label: 'Tags', type: 'json', group: 'Choice' },
  // Boolean
  { id: 'toggle', label: 'Toggle', type: 'boolean', group: 'Boolean' },
  // Date
  { id: 'datetime', label: 'Date/time', type: 'datetime', group: 'Date' },
  // Relation
  { id: 'relation-m2o', label: 'Many-to-one', type: 'uuid', group: 'Relation' },
  { id: 'relation-o2m', label: 'One-to-many', type: 'alias', group: 'Relation' },
  { id: 'relation-m2m', label: 'Many-to-many', type: 'alias', group: 'Relation' },
  // File
  { id: 'file', label: 'File', type: 'uuid', group: 'File' },
  // Special
  { id: 'json-raw', label: 'JSON (raw)', type: 'json', group: 'Special' },
  { id: 'repeater', label: 'Repeater', type: 'json', group: 'Special' },
  { id: 'presentation-divider', label: 'Presentation: divider', type: 'alias', group: 'Special' },
  { id: 'presentation-notice', label: 'Presentation: notice', type: 'alias', group: 'Special' },
];

const GROUPS = ['Text', 'Number', 'Choice', 'Boolean', 'Date', 'Relation', 'File', 'Special'] as const;

export interface FieldFormState {
  name: string;
  type: string;
  interface: string;
  required: boolean;
  readonly?: boolean;
  hidden?: boolean;
  width?: 'half' | 'full' | 'fill';
  sortOrder: number;
  display?: string | null;
  displayOptions?: Record<string, unknown>;
  translations?: Record<string, unknown>;
  system?: boolean;
  locked?: boolean;
}

interface FieldInspectorProps {
  state: FieldFormState;
  /** Sibling fields used for Mustache template autocomplete. */
  siblingFields?: Array<{ name: string; type: string; interface: string }>;
  onCancel: () => void;
  onSubmit: (state: FieldFormState) => void;
  isSubmitting: boolean;
}

export function FieldInspector({
  state,
  siblingFields = [],
  onCancel,
  onSubmit,
  isSubmitting,
}: FieldInspectorProps) {
  const [form, setForm] = useState<FieldFormState>(state);
  const [translationsDraft, setTranslationsDraft] = useState(() =>
    JSON.stringify(state.translations ?? {}, null, 2),
  );
  const valid = NAME_PATTERN.test(form.name);
  const translationsValid = useMemo(() => {
    try {
      const parsed = JSON.parse(translationsDraft);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [translationsDraft]);
  const canEditStorage = !form.locked;

  const sample = useMemo(() => {
    // Synthetic sample row so the live preview shows something even before
    // any items exist for the collection.
    const row: Record<string, unknown> = { id: 'sample-id' };
    for (const f of siblingFields) {
      if (f.type === 'boolean') row[f.name] = true;
      else if (f.type === 'integer' || f.type === 'decimal') row[f.name] = 42;
      else row[f.name] = `<${f.name}>`;
    }
    return row;
  }, [siblingFields]);

  const updateDisplayOption = (key: string, value: unknown) => {
    setForm({
      ...form,
      displayOptions: { ...(form.displayOptions ?? {}), [key]: value },
    });
  };

  const isMustache =
    form.display === 'mustache' || form.display === 'mustache-template';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-end bg-black/30">
      <div className="h-full w-full max-w-md overflow-y-auto bg-background p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Field</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure the field's machine name, interface, display, and behaviour.
        </p>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Machine name</span>
            <input
              value={form.name}
              onChange={(e) =>
                setForm({ ...form, name: e.target.value.toLowerCase() })
              }
              disabled={!canEditStorage}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              autoFocus
            />
            {form.name && !valid && (
              <p className="mt-1 text-xs text-destructive">Invalid format.</p>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Interface</span>
            <select
              value={form.interface}
              disabled={!canEditStorage}
              onChange={(e) => {
                const iface = INTERFACES.find((i) => i.id === e.target.value);
                setForm({
                  ...form,
                  interface: e.target.value,
                  type: iface?.type ?? form.type,
                });
              }}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {INTERFACES.filter((i) => i.group === g).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Display</span>
            <select
              value={form.display ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  display: e.target.value || null,
                  // Reset options whenever the display key changes.
                  displayOptions: {},
                })
              }
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">Auto (resolve from interface/type)</option>
              {DISPLAY_CATALOGUE.map((d) => (
                <option key={d.id} value={d.id} title={d.hint}>
                  {d.label}
                </option>
              ))}
            </select>
            {form.display && (
              <p className="mt-1 text-xs text-muted-foreground">
                {DISPLAY_CATALOGUE.find((d) => d.id === form.display)?.hint}
              </p>
            )}
          </label>

          {isMustache && (
            <div>
              <span className="mb-1 block text-sm font-medium">Template</span>
              <MustacheTemplateEditor
                value={String((form.displayOptions ?? {}).template ?? '')}
                onChange={(next) => updateDisplayOption('template', next)}
                fields={siblingFields.map((f) => ({
                  name: f.name,
                  hint: `${f.type}/${f.interface}`,
                }))}
                sample={sample}
              />
            </div>
          )}

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.required}
              disabled={!canEditStorage}
              onChange={(e) => setForm({ ...form, required: e.target.checked })}
            />
            <span className="text-sm">Required</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.hidden ?? false}
                onChange={(e) => setForm({ ...form, hidden: e.target.checked })}
              />
              <span className="text-sm">Hidden</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.readonly ?? false}
                onChange={(e) => setForm({ ...form, readonly: e.target.checked })}
              />
              <span className="text-sm">Readonly</span>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Width</span>
            <select
              value={form.width ?? 'full'}
              onChange={(e) =>
                setForm({ ...form, width: e.target.value as FieldFormState['width'] })
              }
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="half">Half</option>
              <option value="full">Full</option>
              <option value="fill">Fill</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Translations JSON</span>
            <textarea
              value={translationsDraft}
              onChange={(e) => setTranslationsDraft(e.target.value)}
              rows={5}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
            />
            {!translationsValid && (
              <p className="mt-1 text-xs text-destructive">Translations must be a JSON object.</p>
            )}
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || !translationsValid || isSubmitting}
            onClick={() =>
              onSubmit({
                ...form,
                translations: JSON.parse(translationsDraft) as Record<string, unknown>,
              })
            }
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
