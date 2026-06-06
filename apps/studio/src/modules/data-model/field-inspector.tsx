import { useMemo, useState } from 'react';
import { DISPLAY_CATALOGUE } from '@/modules/content/displays/registry';
import { MustacheTemplateEditor } from '@/modules/content/mustache-template-editor';

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const TABS = ['Basics', 'Options', 'Display', 'Validation', 'Conditions', 'Layout', 'Storage', 'Translations'] as const;
type InspectorTab = (typeof TABS)[number];

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
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown[];
  options?: Record<string, unknown>;
  required: boolean;
  readonly?: boolean;
  hidden?: boolean;
  encrypted?: boolean;
  versioned?: boolean;
  rawEnabled?: boolean;
  group?: string | null;
  width?: 'half' | 'full' | 'fill';
  sortOrder: number;
  display?: string | null;
  displayOptions?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  conditions?: unknown[];
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
  const [tab, setTab] = useState<InspectorTab>('Basics');
  const [optionsDraft, setOptionsDraft] = useState(() => stringifyJson(state.options ?? {}));
  const [displayOptionsDraft, setDisplayOptionsDraft] = useState(() =>
    stringifyJson(state.displayOptions ?? {}),
  );
  const [validationDraft, setValidationDraft] = useState(() =>
    stringifyJson(state.validation ?? { rules: [] }),
  );
  const [conditionsDraft, setConditionsDraft] = useState(() =>
    stringifyJson(state.conditions ?? []),
  );
  const [defaultValueDraft, setDefaultValueDraft] = useState(() =>
    state.defaultValue === undefined ? '' : stringifyJson(state.defaultValue),
  );
  const [specialDraft, setSpecialDraft] = useState(() => (state.special ?? []).join(', '));
  const [translationsDraft, setTranslationsDraft] = useState(() =>
    stringifyJson(state.translations ?? {}),
  );
  const valid = NAME_PATTERN.test(form.name);
  const optionsJson = useMemo(() => parseJsonObject(optionsDraft), [optionsDraft]);
  const displayOptionsJson = useMemo(() => parseJsonObject(displayOptionsDraft), [displayOptionsDraft]);
  const validationJson = useMemo(() => parseJsonObject(validationDraft), [validationDraft]);
  const conditionsJson = useMemo(() => parseJsonArray(conditionsDraft), [conditionsDraft]);
  const translationsJson = useMemo(() => parseJsonObject(translationsDraft), [translationsDraft]);
  const defaultValueJson = useMemo(() => parseOptionalJson(defaultValueDraft), [defaultValueDraft]);
  const jsonValid =
    optionsJson.ok &&
    displayOptionsJson.ok &&
    validationJson.ok &&
    conditionsJson.ok &&
    translationsJson.ok &&
    defaultValueJson.ok;
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
    const next = { ...(displayOptionsJson.ok ? displayOptionsJson.value : {}), [key]: value };
    setDisplayOptionsDraft(stringifyJson(next));
    setForm({
      ...form,
      displayOptions: next,
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

        <div className="mt-4 flex flex-wrap gap-1 border-b pb-2">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                tab === item ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {tab === 'Basics' && (
            <>
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
                <span className="mb-1 block text-sm font-medium">Label</span>
                <input
                  value={form.label ?? ''}
                  onChange={(e) => setForm({ ...form, label: e.target.value || null })}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">Note</span>
                <textarea
                  value={form.note ?? ''}
                  onChange={(e) => setForm({ ...form, note: e.target.value || null })}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
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
            </>
          )}

          {tab === 'Options' && (
            <JsonTextarea
              label="Options JSON"
              value={optionsDraft}
              onChange={setOptionsDraft}
              valid={optionsJson.ok}
              rows={12}
            />
          )}

          {tab === 'Display' && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Display</span>
                <select
                  value={form.display ?? ''}
                  onChange={(e) => {
                    setForm({ ...form, display: e.target.value || null });
                    setDisplayOptionsDraft('{}');
                  }}
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
                    value={String((displayOptionsJson.ok ? displayOptionsJson.value : {}).template ?? '')}
                    onChange={(next) => updateDisplayOption('template', next)}
                    fields={siblingFields.map((f) => ({
                      name: f.name,
                      hint: `${f.type}/${f.interface}`,
                    }))}
                    sample={sample}
                  />
                </div>
              )}

              <JsonTextarea
                label="Display options JSON"
                value={displayOptionsDraft}
                onChange={setDisplayOptionsDraft}
                valid={displayOptionsJson.ok}
                rows={10}
              />
            </>
          )}

          {tab === 'Validation' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.required}
                    disabled={!canEditStorage}
                    onChange={(e) => setForm({ ...form, required: e.target.checked })}
                  />
                  <span className="text-sm">Required</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.nullable ?? true}
                    disabled={!canEditStorage}
                    onChange={(e) => setForm({ ...form, nullable: e.target.checked })}
                  />
                  <span className="text-sm">Nullable</span>
                </label>
              </div>
              <JsonTextarea
                label="Validation JSON"
                value={validationDraft}
                onChange={setValidationDraft}
                valid={validationJson.ok}
                rows={12}
              />
            </>
          )}

          {tab === 'Conditions' && (
            <JsonTextarea
              label="Conditions JSON"
              value={conditionsDraft}
              onChange={setConditionsDraft}
              valid={conditionsJson.ok}
              rows={14}
            />
          )}

          {tab === 'Layout' && (
            <>
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
                <span className="mb-1 block text-sm font-medium">Group</span>
                <input
                  value={form.group ?? ''}
                  onChange={(e) => setForm({ ...form, group: e.target.value || null })}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </label>
            </>
          )}

          {tab === 'Storage' && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Type</span>
                <input
                  value={form.type}
                  disabled={!canEditStorage}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Length" value={form.length} onChange={(length) => setForm({ ...form, length })} />
                <NumberInput label="Precision" value={form.precision} onChange={(precision) => setForm({ ...form, precision })} />
                <NumberInput label="Scale" value={form.scale} onChange={(scale) => setForm({ ...form, scale })} min={0} />
                <NumberInput label="Sort order" value={form.sortOrder} onChange={(sortOrder) => setForm({ ...form, sortOrder: sortOrder ?? 0 })} min={0} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.unique ?? false} onChange={(e) => setForm({ ...form, unique: e.target.checked })} />
                  <span className="text-sm">Unique</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.indexed ?? false} onChange={(e) => setForm({ ...form, indexed: e.target.checked })} />
                  <span className="text-sm">Indexed</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.searchable ?? true} onChange={(e) => setForm({ ...form, searchable: e.target.checked })} />
                  <span className="text-sm">Searchable</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.rawEnabled ?? true} onChange={(e) => setForm({ ...form, rawEnabled: e.target.checked })} />
                  <span className="text-sm">Raw enabled</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.encrypted ?? false} onChange={(e) => setForm({ ...form, encrypted: e.target.checked })} />
                  <span className="text-sm">Encrypted</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.versioned ?? false} onChange={(e) => setForm({ ...form, versioned: e.target.checked })} />
                  <span className="text-sm">Versioned</span>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Default value JSON</span>
                <textarea
                  value={defaultValueDraft}
                  onChange={(e) => setDefaultValueDraft(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                />
                {!defaultValueJson.ok && <p className="mt-1 text-xs text-destructive">Invalid JSON.</p>}
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Special</span>
                <input
                  value={specialDraft}
                  onChange={(e) => setSpecialDraft(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </label>
            </>
          )}

          {tab === 'Translations' && (
            <JsonTextarea
              label="Translations JSON"
              value={translationsDraft}
              onChange={setTranslationsDraft}
              valid={translationsJson.ok}
              rows={14}
            />
          )}
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
            disabled={!valid || !jsonValid || isSubmitting}
            onClick={() =>
              onSubmit({
                ...form,
                defaultValue: defaultValueJson.value,
                special: specialDraft.split(',').map((item) => item.trim()).filter(Boolean),
                options: optionsJson.value,
                displayOptions: displayOptionsJson.value,
                validation: validationJson.value,
                conditions: conditionsJson.value,
                translations: translationsJson.value,
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type JsonResult<T> = { ok: true; value: T } | { ok: false; value: T };

function parseJsonObject(value: string): JsonResult<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // handled below
  }
  return { ok: false, value: {} };
}

function parseJsonArray(value: string): JsonResult<unknown[]> {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { ok: true, value: parsed };
  } catch {
    // handled below
  }
  return { ok: false, value: [] };
}

function parseOptionalJson(value: string): JsonResult<unknown> {
  if (!value.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function JsonTextarea({
  label,
  value,
  onChange,
  valid,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
      />
      {!valid && <p className="mt-1 text-xs text-destructive">Invalid JSON.</p>}
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min = 1,
}: {
  label: string;
  value?: number | null;
  onChange: (value: number | null) => void;
  min?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        type="number"
        min={min}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      />
    </label>
  );
}
