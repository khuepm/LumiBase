import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Filter, GripVertical, Minus, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  CONDITION_OPS,
  parseFormLayout,
  validateFormLayout,
  conditionSchema,
  placedFields,
  type Condition,
  type ConditionLeaf,
  type ConditionOp,
  type FormLayout,
  type LayoutNode,
} from '@lumibase/contracts/form-layout';
import type { FieldResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  addNode,
  containers,
  emptyLayout,
  formatRuleValue,
  fromSimple,
  moveInto,
  parseRuleValue,
  placeField,
  pruneUnknownFields,
  refOf,
  removeNode,
  shiftNode,
  toSimple,
  updateNode,
  type NodeRef,
} from './form-layout-model';

/**
 * Collection settings → Form layout (#750). Builds the tabs / groups /
 * dividers tree that the item form renders, and the `visibleWhen` conditions
 * on each node. Fields are placed by dragging them onto a container (or the
 * top-level drop zone) or, without a pointer, with the "Place in" picker.
 */

const DRAG_MIME = 'application/x-lumibase-layout-ref';

const OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  in: 'is one of',
  nin: 'is not one of',
  empty: 'is empty',
  nempty: 'is not empty',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  contains: 'contains',
};

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Save failed.';
}

export function FormLayoutTab({ collectionName }: { collectionName: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();

  const fieldsQuery = useQuery({
    queryKey: ['fields', collectionName],
    queryFn: async () => (await client.schema.listFields(collectionName)).data,
  });
  const layoutQuery = useQuery({
    queryKey: ['form-layout', collectionName],
    queryFn: async () => parseFormLayout((await client.schema.getFormLayout(collectionName)).data?.layout),
  });

  const fields: FieldResource[] = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const [draft, setDraft] = useState<FormLayout | null>(null);

  // Hydrate once both queries settle; placements of deleted fields are dropped.
  useEffect(() => {
    if (draft !== null || !fieldsQuery.isSuccess || !layoutQuery.isSuccess) return;
    setDraft(pruneUnknownFields(layoutQuery.data ?? emptyLayout(), fieldNames));
  }, [draft, fieldsQuery.isSuccess, layoutQuery.isSuccess, layoutQuery.data, fieldNames]);

  const saveMutation = useMutation({
    mutationFn: async (layout: FormLayout | null) => (await client.schema.setFormLayout(collectionName, layout)).data,
    onSuccess: (data) => {
      const saved = parseFormLayout(data?.layout);
      setDraft(saved ?? emptyLayout());
      void queryClient.invalidateQueries({ queryKey: ['form-layout', collectionName] });
    },
  });

  if (fieldsQuery.isLoading || layoutQuery.isLoading || draft === null) {
    return <p className="text-sm text-muted-foreground">Loading form layout…</p>;
  }

  const check = validateFormLayout(draft, fieldNames);
  const placed = new Set(placedFields(draft));
  const unplaced = fields.filter((f) => !placed.has(f.name));
  const targets = containers(draft.nodes);

  const onDropInto = (parentId: string | null) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const ref = event.dataTransfer.getData(DRAG_MIME) as NodeRef | '';
    if (!ref) return;
    setDraft((d) => {
      if (!d) return d;
      return ref.startsWith('field:') ? placeField(d, ref.slice(6), parentId) : moveInto(d, ref, parentId);
    });
  };

  const editor: TreeEditor = {
    fields,
    targets,
    update: (ref, patch) => setDraft((d) => (d ? updateNode(d, ref, patch) : d)),
    remove: (ref) => setDraft((d) => (d ? removeNode(d, ref) : d)),
    shift: (ref, delta) => setDraft((d) => (d ? shiftNode(d, ref, delta) : d)),
    add: (type, parentId) => setDraft((d) => (d ? addNode(d, type, parentId) : d)),
    moveInto: (ref, parentId) => setDraft((d) => (d ? moveInto(d, ref, parentId) : d)),
    onDropInto,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-xs text-muted-foreground">
          Arrange the item form into tabs, groups and dividers. Fields you do not place keep rendering in a default
          section above the layout. A collection with no layout renders exactly as before.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => saveMutation.mutate(null)}
            disabled={saveMutation.isPending}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            Remove layout
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate(draft.nodes.length === 0 ? null : draft)}
            disabled={!check.ok || saveMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saveMutation.isPending ? 'Saving…' : 'Save layout'}
          </button>
        </div>
      </div>

      {!check.ok && (
        <ul role="alert" className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {check.issues.map((issue, i) => (
            <li key={i}>
              <span className="font-mono">{issue.path}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {saveMutation.error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {errorMessage(saveMutation.error)}
        </div>
      )}
      {saveMutation.isSuccess && !saveMutation.isPending && (
        <p role="status" className="text-xs text-emerald-700">
          Layout saved.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[14rem_1fr]">
        <aside aria-label="Unplaced fields" className="space-y-2 rounded-lg border p-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Unplaced fields</h3>
          {unplaced.length === 0 && <p className="text-xs text-muted-foreground">Every field is placed.</p>}
          <ul className="space-y-1.5">
            {unplaced.map((f) => (
              <li
                key={f.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, `field:${f.name}`);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                data-testid={`unplaced-${f.name}`}
                className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs"
              >
                <GripVertical className="h-3 w-3 flex-none cursor-grab text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate font-mono">{f.name}</span>
                <select
                  aria-label={`Place ${f.name} in`}
                  value=""
                  onChange={(e) => {
                    const target = e.target.value;
                    if (!target) return;
                    setDraft((d) => (d ? placeField(d, f.name, target === '__top' ? null : target) : d));
                  }}
                  className="max-w-[6rem] rounded border bg-background text-[10px]"
                >
                  <option value="">Place…</option>
                  <option value="__top">Top level</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {' '.repeat(t.depth * 2)}
                      {t.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </aside>

        <section aria-label="Layout" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <AddButton label="Add tab" onClick={() => editor.add('tab', null)} />
            <AddButton label="Add group" onClick={() => editor.add('group', null)} />
            <AddButton label="Add divider" onClick={() => editor.add('divider', null)} />
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDropInto(null)}
            data-testid="layout-drop-top"
            className="min-h-16 space-y-2 rounded-lg border border-dashed p-3"
          >
            {draft.nodes.length === 0 && (
              <p className="text-xs text-muted-foreground">Drop fields here, or add a tab or group.</p>
            )}
            {draft.nodes.map((node) => (
              <NodeEditor key={refOf(node)} node={node} editor={editor} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

interface TreeEditor {
  fields: FieldResource[];
  targets: Array<{ id: string; label: string; depth: number }>;
  update: (ref: NodeRef, patch: Record<string, unknown>) => void;
  remove: (ref: NodeRef) => void;
  shift: (ref: NodeRef, delta: -1 | 1) => void;
  add: (type: 'tab' | 'group' | 'divider', parentId: string | null) => void;
  moveInto: (ref: NodeRef, parentId: string | null) => void;
  onDropInto: (parentId: string | null) => (event: DragEvent<HTMLElement>) => void;
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
    >
      <Plus className="h-3 w-3" />
      {label}
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function nodeName(node: LayoutNode): string {
  if (node.type === 'field') return node.field;
  return node.label ?? node.id;
}

function NodeEditor({ node, editor }: { node: LayoutNode; editor: TreeEditor }) {
  const ref = refOf(node);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isContainer = node.type === 'tab' || node.type === 'group';
  const name = nodeName(node);

  return (
    <div
      draggable={node.type !== 'field' ? true : undefined}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(DRAG_MIME, ref);
      }}
      data-testid={`layout-node-${ref}`}
      className={cn('rounded-md border bg-background', isContainer && 'p-2', !isContainer && 'px-2 py-1')}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {node.type !== 'field' && <GripVertical className="h-3 w-3 cursor-grab text-muted-foreground" aria-hidden />}
        {node.type === 'divider' && <Minus className="h-3 w-3 text-muted-foreground" aria-hidden />}
        <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{node.type}</span>
        {node.type === 'field' ? (
          <span className="flex-1 font-mono">{node.field}</span>
        ) : (
          <input
            aria-label={`${node.type} label`}
            value={node.label ?? ''}
            placeholder={node.type === 'divider' ? 'Optional label' : 'Label'}
            onChange={(e) => editor.update(ref, { label: e.target.value || undefined })}
            className="flex-1 rounded border bg-background px-1.5 py-0.5"
          />
        )}
        {node.visibleWhen && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-sky-700" title="Has a visibility condition">
            <Filter className="h-3 w-3" aria-hidden /> conditional
          </span>
        )}
        <IconButton label={`Settings for ${name}`} onClick={() => setSettingsOpen((v) => !v)}>
          <Filter className="h-3 w-3" />
        </IconButton>
        <IconButton label={`Move ${name} up`} onClick={() => editor.shift(ref, -1)}>
          <ArrowUp className="h-3 w-3" />
        </IconButton>
        <IconButton label={`Move ${name} down`} onClick={() => editor.shift(ref, 1)}>
          <ArrowDown className="h-3 w-3" />
        </IconButton>
        <IconButton label={`Remove ${name}`} onClick={() => editor.remove(ref)}>
          <Trash2 className="h-3 w-3" />
        </IconButton>
      </div>

      {settingsOpen && <NodeSettings node={node} nodeRef={ref} editor={editor} />}

      {isContainer && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={editor.onDropInto(node.id)}
          data-testid={`layout-drop-${node.id}`}
          className="mt-2 min-h-10 space-y-1.5 rounded border border-dashed p-2"
        >
          {node.children.length === 0 && <p className="text-[11px] text-muted-foreground">Drop fields here.</p>}
          {node.children.map((child) => (
            <NodeEditor key={refOf(child)} node={child} editor={editor} />
          ))}
          <div className="flex gap-1.5 pt-1">
            <button type="button" onClick={() => editor.add('group', node.id)} className="text-[11px] text-muted-foreground hover:underline">
              + group
            </button>
            <button type="button" onClick={() => editor.add('divider', node.id)} className="text-[11px] text-muted-foreground hover:underline">
              + divider
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeSettings({ node, nodeRef, editor }: { node: LayoutNode; nodeRef: NodeRef; editor: TreeEditor }) {
  const parentOptions = editor.targets.filter((t) => node.type === 'field' || t.id !== node.id);
  return (
    <div className="mt-2 space-y-2 rounded border bg-muted/20 p-2 text-xs">
      <ConditionEditor
        value={node.visibleWhen}
        fields={editor.fields}
        exclude={node.type === 'field' ? node.field : undefined}
        onChange={(cond) => editor.update(nodeRef, { visibleWhen: cond })}
      />
      {node.type !== 'divider' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={node.skipRequiredWhenHidden === true}
              onChange={(e) => editor.update(nodeRef, { skipRequiredWhenHidden: e.target.checked || undefined })}
            />
            Skip required when hidden
          </label>
          <label className="inline-flex items-center gap-1">
            Hidden value on save
            <select
              value={node.hiddenValue ?? ''}
              onChange={(e) => editor.update(nodeRef, { hiddenValue: e.target.value || undefined })}
              className="rounded border bg-background px-1"
            >
              <option value="">inherit (keep)</option>
              <option value="keep">keep</option>
              <option value="clear">clear</option>
            </select>
          </label>
        </div>
      )}
      {node.type === 'group' && (
        <div className="flex flex-wrap gap-3">
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={node.collapsible === true}
              onChange={(e) => editor.update(nodeRef, { collapsible: e.target.checked || undefined, collapsed: undefined })}
            />
            Collapsible
          </label>
          {node.collapsible && (
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={node.collapsed === true}
                onChange={(e) => editor.update(nodeRef, { collapsed: e.target.checked || undefined })}
              />
              Starts collapsed
            </label>
          )}
        </div>
      )}
      <label className="inline-flex items-center gap-1">
        Move to
        <select
          aria-label={`Move ${nodeName(node)} to`}
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor.moveInto(nodeRef, v === '__top' ? null : v);
          }}
          className="rounded border bg-background px-1"
        >
          <option value="">…</option>
          <option value="__top">Top level</option>
          {parentOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * Rule-list editor for `visibleWhen`: "Show when all/any of these rules
 * match". Conditions using `not` or nesting switch to a JSON editor.
 */
export function ConditionEditor({
  value,
  fields,
  exclude,
  onChange,
}: {
  value: Condition | undefined;
  fields: FieldResource[];
  /** The field being configured — a field cannot depend on itself. */
  exclude?: string;
  onChange: (next: Condition | undefined) => void;
}) {
  const simple = toSimple(value);
  const [jsonMode, setJsonMode] = useState(simple === null);
  const [jsonText, setJsonText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const options = fields.filter((f) => f.name !== exclude);
  const typeOf = (key: string) => fields.find((f) => f.name === key)?.type;

  if (jsonMode || simple === null) {
    return (
      <div className="space-y-1">
        <label className="block font-medium" htmlFor="condition-json">
          Show when (JSON)
        </label>
        <textarea
          id="condition-json"
          value={jsonText}
          onChange={(e) => {
            const text = e.target.value;
            setJsonText(text);
            if (text.trim() === '') {
              setJsonError(null);
              onChange(undefined);
              return;
            }
            try {
              const parsed = conditionSchema.safeParse(JSON.parse(text));
              if (parsed.success) {
                setJsonError(null);
                onChange(parsed.data);
              } else {
                setJsonError(parsed.error.issues[0]?.message ?? 'Invalid condition.');
              }
            } catch {
              setJsonError('Invalid JSON.');
            }
          }}
          rows={5}
          className="w-full rounded border bg-background p-1 font-mono text-[11px]"
        />
        {jsonError && <p className="text-destructive">{jsonError}</p>}
        {toSimple(value) !== null && (
          <button type="button" className="text-[11px] hover:underline" onClick={() => setJsonMode(false)}>
            Back to rule editor
          </button>
        )}
      </div>
    );
  }

  const setRules = (rules: ConditionLeaf[], match = simple.match) => onChange(fromSimple({ match, rules }));
  const first = options[0]?.name;

  return (
    <fieldset className="space-y-1">
      <legend className="font-medium">Visibility</legend>
      {simple.rules.length === 0 ? (
        <p className="text-muted-foreground">Always shown.</p>
      ) : (
        <label className="inline-flex items-center gap-1">
          Show when
          <select
            aria-label="Match"
            value={simple.match}
            onChange={(e) => setRules(simple.rules, e.target.value as 'all' | 'any')}
            className="rounded border bg-background px-1"
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these rules match:
        </label>
      )}
      {simple.rules.map((rule, index) => {
        const replace = (next: ConditionLeaf) => setRules(simple.rules.map((r, i) => (i === index ? next : r)));
        return (
          <div key={index} className="flex flex-wrap items-center gap-1" data-testid="condition-rule">
            <select
              aria-label={`Rule ${index + 1} field`}
              value={rule.field}
              onChange={(e) => replace({ ...rule, field: e.target.value })}
              className="rounded border bg-background px-1 font-mono"
            >
              {options.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Rule ${index + 1} operator`}
              value={rule.op}
              onChange={(e) => {
                const op = e.target.value as ConditionOp;
                replace({ field: rule.field, op, value: parseRuleValue(op, formatRuleValue(rule.value), typeOf(rule.field)) });
              }}
              className="rounded border bg-background px-1"
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {rule.op !== 'empty' && rule.op !== 'nempty' && (
              <input
                aria-label={`Rule ${index + 1} value`}
                value={formatRuleValue(rule.value)}
                placeholder={rule.op === 'in' || rule.op === 'nin' ? 'a, b, c' : 'value'}
                onChange={(e) => replace({ ...rule, value: parseRuleValue(rule.op, e.target.value, typeOf(rule.field)) })}
                className="w-32 rounded border bg-background px-1"
              />
            )}
            <IconButton label={`Remove rule ${index + 1}`} onClick={() => setRules(simple.rules.filter((_, i) => i !== index))}>
              <Trash2 className="h-3 w-3" />
            </IconButton>
          </div>
        );
      })}
      <div className="flex gap-2">
        {first && (
          <button
            type="button"
            className="text-[11px] hover:underline"
            onClick={() => setRules([...simple.rules, { field: first, op: 'nempty' }])}
          >
            + Add rule
          </button>
        )}
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:underline"
          onClick={() => {
            setJsonText(value ? JSON.stringify(value, null, 2) : '');
            setJsonMode(true);
          }}
        >
          Edit as JSON
        </button>
      </div>
    </fieldset>
  );
}
