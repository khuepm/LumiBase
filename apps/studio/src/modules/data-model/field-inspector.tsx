import { useMemo, useState } from 'react';
import {
  AlignLeft,
  AlignJustify,
  FileText,
  Code2,
  Terminal,
  Link2,
  Palette,
  Hash,
  Star,
  ChevronDown,
  Tag,
  ToggleLeft,
  Calendar,
  ArrowRight,
  ArrowLeft,
  LayoutGrid,
  Paperclip,
  FolderOpen,
  Search,
  Sparkles,
  Braces,
  Repeat,
  SeparatorHorizontal,
  Info,
  Lock,
  X,
  AlertTriangle,
  Eye,
  EyeOff,
  Table2,
  SquarePen,
  ListChecks,
  CircleDot,
  ListTree,
  Smile,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import {
  findInterfaceCatalogueItem,
  INTERFACE_CATALOGUE,
  INTERFACE_GROUPS,
} from '@/modules/content/interfaces/catalogue';
import { DISPLAY_CATALOGUE } from '@/modules/content/displays/registry';
import { MustacheTemplateEditor } from '@/modules/content/mustache-template-editor';

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

const TABS = ['Field', 'Interface', 'Table display', 'Validation', 'Conditions', 'Layout', 'Storage'] as const;
type InspectorTab = (typeof TABS)[number];

// Icons per interface id
const IFACE_ICONS: Record<string, LucideIcon> = {
  'input': AlignLeft,
  'input-multiline': AlignJustify,
  'wysiwyg': FileText,
  'markdown': Code2,
  'code': Terminal,
  'slug': Link2,
  'color': Palette,
  'input-number': Hash,
  'rating': Star,
  'select-dropdown': ChevronDown,
  'select-multiple-dropdown': ListChecks,
  'select-radio': CircleDot,
  'select-multiple-checkbox': ListChecks,
  'select-multiple-checkbox-tree': ListTree,
  'select-icon': Smile,
  'slider': SlidersHorizontal,
  'tags': Tag,
  'toggle': ToggleLeft,
  'datetime': Calendar,
  'relation-m2o': ArrowRight,
  'relation-o2m': ArrowLeft,
  'relation-m2m': LayoutGrid,
  'file': Paperclip,
  'files': FolderOpen,
  'seo': Search,
  'aio': Sparkles,
  'json-raw': Braces,
  'repeater': Repeat,
  'presentation-divider': SeparatorHorizontal,
  'presentation-notice': Info,
};

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
  const [tab, setTab] = useState<InspectorTab>('Field');
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

  const isRelation = form.interface?.startsWith('relation-') || form.interface === 'files';
  const isMustache = form.display === 'mustache' || form.display === 'mustache-template';
  const needsTableDisplayConfig = isRelation && !form.display;

  const sample = useMemo(() => {
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
    setForm({ ...form, displayOptions: next });
  };

  const handleInterfaceChange = (ifaceId: string) => {
    const iface = findInterfaceCatalogueItem(ifaceId);
    const nextOptions = iface?.defaultOptions ?? {};
    const nextSpecial = iface?.defaultSpecial ?? [];
    setForm({
      ...form,
      interface: ifaceId,
      type: iface?.type ?? form.type,
      options: nextOptions,
      special: nextSpecial,
      display: iface?.defaultDisplay ?? null,
      width: iface?.width ?? form.width,
    });
    setOptionsDraft(stringifyJson(nextOptions));
    setSpecialDraft(nextSpecial.join(', '));
    setDisplayOptionsDraft('{}');
  };

  const currentIfaceItem = findInterfaceCatalogueItem(form.interface);
  const IfaceIcon = IFACE_ICONS[form.interface] ?? Braces;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/30 backdrop-blur-[1px]"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Sidebar panel */}
      <div className="flex h-full w-full max-w-[460px] flex-col bg-background shadow-2xl">
        {/* Panel header */}
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IfaceIcon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold leading-tight truncate">
              {form.name || 'New field'}
            </h3>
            <p className="text-xs text-muted-foreground">
              {currentIfaceItem?.label ?? form.interface}
              {form.locked && (
                <span className="ml-2 inline-flex items-center gap-0.5 text-amber-600">
                  <Lock className="h-3 w-3" /> system
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b px-3 scrollbar-none">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === t
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'Table display' && needsTableDisplayConfig ? (
                <span className="flex items-center gap-1">
                  {t}
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                </span>
              ) : (
                t
              )}
            </button>
          ))}
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === 'Field' && (
            <FieldTab
              form={form}
              setForm={setForm}
              valid={valid}
              canEditStorage={canEditStorage}
            />
          )}

          {tab === 'Interface' && (
            <InterfaceTab
              form={form}
              canEditStorage={canEditStorage}
              optionsDraft={optionsDraft}
              optionsJsonOk={optionsJson.ok}
              onInterfaceChange={handleInterfaceChange}
              onOptionsDraftChange={setOptionsDraft}
            />
          )}

          {tab === 'Table display' && (
            <TableDisplayTab
              form={form}
              setForm={setForm}
              siblingFields={siblingFields}
              sample={sample}
              displayOptionsDraft={displayOptionsDraft}
              displayOptionsJson={displayOptionsJson}
              setDisplayOptionsDraft={setDisplayOptionsDraft}
              updateDisplayOption={updateDisplayOption}
              isMustache={isMustache}
              isRelation={isRelation}
              needsTableDisplayConfig={needsTableDisplayConfig}
            />
          )}

          {tab === 'Validation' && (
            <ValidationTab
              form={form}
              setForm={setForm}
              canEditStorage={canEditStorage}
              validationDraft={validationDraft}
              validationJsonOk={validationJson.ok}
              onValidationDraftChange={setValidationDraft}
            />
          )}

          {tab === 'Conditions' && (
            <JsonTextarea
              label="Conditions"
              hint="Array of condition rules controlling field visibility."
              value={conditionsDraft}
              onChange={setConditionsDraft}
              valid={conditionsJson.ok}
              rows={14}
            />
          )}

          {tab === 'Layout' && (
            <LayoutTab form={form} setForm={setForm} />
          )}

          {tab === 'Storage' && (
            <StorageTab
              form={form}
              setForm={setForm}
              canEditStorage={canEditStorage}
              defaultValueDraft={defaultValueDraft}
              setDefaultValueDraft={setDefaultValueDraft}
              defaultValueJsonOk={defaultValueJson.ok}
              specialDraft={specialDraft}
              setSpecialDraft={setSpecialDraft}
              translationsDraft={translationsDraft}
              setTranslationsDraft={setTranslationsDraft}
              translationsJsonOk={translationsJson.ok}
            />
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
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
                special: specialDraft
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                options: optionsJson.value,
                displayOptions: displayOptionsJson.value,
                validation: validationJson.value,
                conditions: conditionsJson.value,
                translations: translationsJson.value,
              })
            }
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : 'Save field'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab sub-components ───────────────────────────────────────────────────────

interface FieldTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  valid: boolean;
  canEditStorage: boolean;
}

function FieldTab({ form, setForm, valid, canEditStorage }: FieldTabProps) {
  return (
    <div className="space-y-4">
      <FormField label="Machine name" hint="Lowercase letters, numbers and underscores only.">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
          disabled={!canEditStorage}
          placeholder="field_name"
          autoFocus
          className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono disabled:opacity-60"
        />
        {form.name && !valid && (
          <p className="mt-1 text-xs text-destructive">
            Must start with a letter. Only a–z, 0–9, _ allowed.
          </p>
        )}
      </FormField>

      <FormField label="Label" hint="Human-readable name shown in the UI.">
        <input
          value={form.label ?? ''}
          onChange={(e) => setForm({ ...form, label: e.target.value || null })}
          placeholder="Field label"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </FormField>

      <FormField label="Note" hint="Helper text shown below the field in forms.">
        <textarea
          value={form.note ?? ''}
          onChange={(e) => setForm({ ...form, note: e.target.value || null })}
          rows={3}
          placeholder="Describe this field…"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </FormField>
    </div>
  );
}

interface InterfaceTabProps {
  form: FieldFormState;
  canEditStorage: boolean;
  optionsDraft: string;
  optionsJsonOk: boolean;
  onInterfaceChange: (id: string) => void;
  onOptionsDraftChange: (v: string) => void;
}

function InterfaceTab({
  form,
  canEditStorage,
  optionsDraft,
  optionsJsonOk,
  onInterfaceChange,
  onOptionsDraftChange,
}: InterfaceTabProps) {
  const currentItem = findInterfaceCatalogueItem(form.interface);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <SquarePen className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium">Collection form interface</h4>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Choose how this field appears when editing an item.
        </p>

        <div className="space-y-4">
          {INTERFACE_GROUPS.map((group) => {
            const items = INTERFACE_CATALOGUE.filter((i) => i.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {items.map((item) => {
                    const Icon = IFACE_ICONS[item.id] ?? Braces;
                    const selected = form.interface === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!canEditStorage}
                        onClick={() => onInterfaceChange(item.id)}
                        title={item.description}
                        className={`flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center transition-all ${
                          selected
                            ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/30'
                            : 'hover:border-muted-foreground/60 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-[10px] font-medium leading-tight">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {currentItem?.description && (
        <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">{currentItem.label}:</strong>{' '}
          {currentItem.description}
        </div>
      )}

      <JsonTextarea
        label="Interface options"
        hint="JSON options passed to the interface component."
        value={optionsDraft}
        onChange={onOptionsDraftChange}
        valid={optionsJsonOk}
        rows={8}
      />
    </div>
  );
}

interface TableDisplayTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  siblingFields: Array<{ name: string; type: string; interface: string }>;
  sample: Record<string, unknown>;
  displayOptionsDraft: string;
  displayOptionsJson: { ok: boolean; value: Record<string, unknown> };
  setDisplayOptionsDraft: (v: string) => void;
  updateDisplayOption: (key: string, value: unknown) => void;
  isMustache: boolean;
  isRelation: boolean;
  needsTableDisplayConfig: boolean;
}

function TableDisplayTab({
  form,
  setForm,
  siblingFields,
  sample,
  displayOptionsDraft,
  displayOptionsJson,
  setDisplayOptionsDraft,
  updateDisplayOption,
  isMustache,
  isRelation,
  needsTableDisplayConfig,
}: TableDisplayTabProps) {
  const allFields = [
    { name: form.name, type: form.type, interface: form.interface },
    ...siblingFields,
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Table2 className="h-4 w-4 text-muted-foreground" />
        <div>
          <h4 className="text-sm font-medium">Display in data tables</h4>
          <p className="text-xs text-muted-foreground">
            How this field renders in collection list views.
          </p>
        </div>
      </div>

      {needsTableDisplayConfig && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            This is a relation field. Without a display template, the table will show raw IDs.
            Configure a display below to show meaningful content.
          </p>
        </div>
      )}

      <FormField label="Display type" hint="How to render this field's value in the table cell.">
        <select
          value={form.display ?? ''}
          onChange={(e) => {
            setForm({ ...form, display: e.target.value || null });
            setDisplayOptionsDraft('{}');
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">Auto (inferred from interface / type)</option>
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
      </FormField>

      {/* Mustache / template display */}
      {isMustache && (
        <FormField
          label="Display template"
          hint={
            <>
              Use <code className="rounded bg-muted px-1 font-mono">{'{{field_name}}'}</code> to
              insert values. Type <code className="rounded bg-muted px-1 font-mono">{'{{{'}</code> for
              autocomplete.
            </>
          }
        >
          <MustacheTemplateEditor
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).template ?? '',
            )}
            onChange={(next) => updateDisplayOption('template', next)}
            fields={allFields.map((f) => ({ name: f.name, hint: `${f.type}/${f.interface}` }))}
            sample={sample}
          />
        </FormField>
      )}

      {/* Relation display — displayField shortcut */}
      {isRelation && form.display === 'relation' && (
        <FormField
          label="Related field to display"
          hint={
            <>
              Field on the related collection to show. Or use{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  setForm({ ...form, display: 'mustache-template' });
                  setDisplayOptionsDraft('{}');
                }}
              >
                Mustache template
              </button>{' '}
              for composed labels like <code className="rounded bg-muted px-1 font-mono">{'{{title}} ({{id}})'}</code>.
            </>
          }
        >
          <input
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).displayField ?? 'title',
            )}
            onChange={(e) => updateDisplayOption('displayField', e.target.value)}
            placeholder="title"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          />
        </FormField>
      )}

      {/* Relation + mustache template */}
      {isRelation && isMustache && (
        <FormField
          label="Related item template"
          hint={
            <>
              Compose the label using fields from the related collection.{' '}
              <code className="rounded bg-muted px-1 font-mono">{'{{title}}'}</code>{' '}
              <code className="rounded bg-muted px-1 font-mono">{'{{id}}'}</code>
            </>
          }
        >
          <MustacheTemplateEditor
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).template ?? '',
            )}
            onChange={(next) => updateDisplayOption('template', next)}
            fields={allFields.map((f) => ({ name: f.name, hint: `${f.type}/${f.interface}` }))}
            sample={sample}
            placeholder="{{title}} — {{id}}"
          />
        </FormField>
      )}

      {/* Display options JSON — always shown as advanced */}
      <details className="group">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          Advanced display options
        </summary>
        <div className="mt-3">
          <JsonTextarea
            label="Display options JSON"
            value={displayOptionsDraft}
            onChange={setDisplayOptionsDraft}
            valid={displayOptionsJson.ok}
            rows={8}
          />
        </div>
      </details>
    </div>
  );
}

interface ValidationTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  canEditStorage: boolean;
  validationDraft: string;
  validationJsonOk: boolean;
  onValidationDraftChange: (v: string) => void;
}

function ValidationTab({
  form,
  setForm,
  canEditStorage,
  validationDraft,
  validationJsonOk,
  onValidationDraftChange,
}: ValidationTabProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <ToggleField
          label="Required"
          description="Value must be provided."
          checked={form.required}
          disabled={!canEditStorage}
          onChange={(v) => setForm({ ...form, required: v })}
        />
        <ToggleField
          label="Nullable"
          description="Allows NULL in database."
          checked={form.nullable ?? true}
          disabled={!canEditStorage}
          onChange={(v) => setForm({ ...form, nullable: v })}
        />
      </div>

      <JsonTextarea
        label="Validation rules"
        hint="Array of rule objects applied server-side."
        value={validationDraft}
        onChange={onValidationDraftChange}
        valid={validationJsonOk}
        rows={12}
      />
    </div>
  );
}

interface LayoutTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
}

function LayoutTab({ form, setForm }: LayoutTabProps) {
  return (
    <div className="space-y-5">
      <FormField label="Width" hint="How much horizontal space the field occupies in the form.">
        <div className="flex gap-2">
          {(['half', 'full', 'fill'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setForm({ ...form, width: w })}
              className={`flex-1 rounded-md border py-2 text-xs font-medium capitalize transition-colors ${
                (form.width ?? 'full') === w
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-muted/60'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <ToggleField
          label="Hidden"
          description="Hide from edit forms."
          icon={EyeOff}
          checked={form.hidden ?? false}
          onChange={(v) => setForm({ ...form, hidden: v })}
        />
        <ToggleField
          label="Readonly"
          description="Prevent editing."
          icon={Lock}
          checked={form.readonly ?? false}
          onChange={(v) => setForm({ ...form, readonly: v })}
        />
      </div>

      <FormField label="Group" hint="Group name for visual field grouping in forms.">
        <input
          value={form.group ?? ''}
          onChange={(e) => setForm({ ...form, group: e.target.value || null })}
          placeholder="e.g. metadata"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </FormField>
    </div>
  );
}

interface StorageTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  canEditStorage: boolean;
  defaultValueDraft: string;
  setDefaultValueDraft: (v: string) => void;
  defaultValueJsonOk: boolean;
  specialDraft: string;
  setSpecialDraft: (v: string) => void;
  translationsDraft: string;
  setTranslationsDraft: (v: string) => void;
  translationsJsonOk: boolean;
}

function StorageTab({
  form,
  setForm,
  canEditStorage,
  defaultValueDraft,
  setDefaultValueDraft,
  defaultValueJsonOk,
  specialDraft,
  setSpecialDraft,
  translationsDraft,
  setTranslationsDraft,
  translationsJsonOk,
}: StorageTabProps) {
  return (
    <div className="space-y-4">
      <FormField label="Database type" hint="Underlying column type.">
        <input
          value={form.type}
          disabled={!canEditStorage}
          onChange={(e) => setForm({ ...form, type: e.target.value })}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono disabled:opacity-60"
        />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <NumberInput
          label="Length"
          value={form.length}
          onChange={(length) => setForm({ ...form, length })}
        />
        <NumberInput
          label="Precision"
          value={form.precision}
          onChange={(precision) => setForm({ ...form, precision })}
        />
        <NumberInput
          label="Scale"
          value={form.scale}
          onChange={(scale) => setForm({ ...form, scale })}
          min={0}
        />
        <NumberInput
          label="Sort order"
          value={form.sortOrder}
          onChange={(v) => setForm({ ...form, sortOrder: v ?? 0 })}
          min={0}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ToggleField label="Unique" checked={form.unique ?? false} onChange={(v) => setForm({ ...form, unique: v })} />
        <ToggleField label="Indexed" checked={form.indexed ?? false} onChange={(v) => setForm({ ...form, indexed: v })} />
        <ToggleField label="Searchable" checked={form.searchable ?? true} onChange={(v) => setForm({ ...form, searchable: v })} />
        <ToggleField label="Raw enabled" checked={form.rawEnabled ?? true} onChange={(v) => setForm({ ...form, rawEnabled: v })} />
        <ToggleField label="Encrypted" checked={form.encrypted ?? false} onChange={(v) => setForm({ ...form, encrypted: v })} />
        <ToggleField label="Versioned" checked={form.versioned ?? false} onChange={(v) => setForm({ ...form, versioned: v })} />
      </div>

      <FormField label="Default value (JSON)">
        <textarea
          value={defaultValueDraft}
          onChange={(e) => setDefaultValueDraft(e.target.value)}
          rows={3}
          placeholder="null"
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
        />
        {!defaultValueJsonOk && (
          <p className="mt-1 text-xs text-destructive">Invalid JSON.</p>
        )}
      </FormField>

      <FormField label="Special" hint="Comma-separated special type flags.">
        <input
          value={specialDraft}
          onChange={(e) => setSpecialDraft(e.target.value)}
          placeholder="e.g. m2o, cast-json"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </FormField>

      <JsonTextarea
        label="Translations"
        hint="Per-locale label/hint overrides."
        value={translationsDraft}
        onChange={setTranslationsDraft}
        valid={translationsJsonOk}
        rows={8}
      />
    </div>
  );
}

// ─── Shared helper components ────────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}

function FormField({ label, hint, children }: FormFieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </label>
  );
}

interface ToggleFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  onChange: (v: boolean) => void;
}

function ToggleField({ label, description, checked, disabled, icon: Icon, onChange }: ToggleFieldProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 hover:bg-muted/40">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <span className="flex items-center gap-1 text-xs font-medium">
          {Icon && <Icon className="h-3 w-3" />}
          {label}
        </span>
        {description && (
          <p className="text-[10px] text-muted-foreground">{description}</p>
        )}
      </div>
    </label>
  );
}

function JsonTextarea({
  label,
  hint,
  value,
  onChange,
  valid,
  rows,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  rows: number;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
      />
      {!valid && <p className="text-xs text-destructive">Invalid JSON.</p>}
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
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      <input
        type="number"
        min={min}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      />
    </div>
  );
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

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
