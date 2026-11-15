import { useEffect, useMemo, useState } from 'react';
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  Code2,
  Eye,
  Layers,
  AlertCircle,
} from 'lucide-react';
import {
  BLOCK_TYPES,
  CONTAINER_TYPES,
  type BlockNode,
  type BlockType,
  type ComponentTemplate,
  type TemplateBlock,
  defaultBlock,
  emptyComponentTemplate,
  serializeComponentTemplate,
} from './block-template-types';
import { BlockTemplateRenderer } from './block-template-renderer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldOption {
  name: string;
  type?: string;
}

interface BlockTemplateEditorProps {
  value: ComponentTemplate | null;
  onChange: (next: ComponentTemplate) => void;
  fields?: FieldOption[];
  sample?: Record<string, unknown>;
}

type EditorTab = 'visual' | 'json' | 'preview';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneTemplate(ct: ComponentTemplate): ComponentTemplate {
  return JSON.parse(JSON.stringify(ct)) as ComponentTemplate;
}

function applyToPath(
  ct: ComponentTemplate,
  path: number[],
  updater: (blocks: TemplateBlock[]) => TemplateBlock[],
): ComponentTemplate {
  const next = cloneTemplate(ct);
  if (path.length === 0) {
    next.template = updater(next.template);
    return next;
  }
  // For now only top-level blocks are editable in the visual editor.
  // Container children show as nested but are only editable via JSON tab.
  next.template = updater(next.template);
  return next;
}

// ---------------------------------------------------------------------------
// Block type badge colours
// ---------------------------------------------------------------------------

const TYPE_COLOUR: Record<BlockType, string> = {
  Text: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  Image: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  Badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  Spacer: 'bg-muted text-muted-foreground',
  Stack: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  Row: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
};

// ---------------------------------------------------------------------------
// Inline config panels per block type
// ---------------------------------------------------------------------------

interface ConfigPanelProps {
  block: BlockNode;
  fields: FieldOption[];
  onChange: (next: BlockNode) => void;
}

function FieldSelect({
  label,
  value,
  fields,
  onChange,
}: {
  label: string;
  value: string;
  fields: FieldOption[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="w-14 shrink-0 text-muted-foreground">{label}</label>
      <div className="relative flex-1">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary appearance-none pe-6"
        >
          <option value="">— literal —</option>
          {fields.map((f) => (
            <option key={f.name} value={`$.${f.name}`}>
              $.{f.name}
            </option>
          ))}
        </select>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="$.field or literal"
        className="w-28 rounded border bg-background px-2 py-1 text-xs font-mono outline-none focus:border-primary"
      />
    </div>
  );
}

function ConfigPanel({ block, fields, onChange }: ConfigPanelProps) {
  switch (block.type) {
    case 'Text':
      return (
        <div className="space-y-1.5">
          <FieldSelect
            label="value"
            value={block.value}
            fields={fields}
            onChange={(v) => onChange({ ...block, value: v })}
          />
          <div className="flex items-center gap-2 text-xs">
            <label className="w-14 shrink-0 text-muted-foreground">variant</label>
            <select
              value={block.variant ?? 'body'}
              onChange={(e) =>
                onChange({ ...block, variant: e.target.value as typeof block.variant })
              }
              className="rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
            >
              {(['title', 'subtitle', 'body', 'caption', 'mono'] as const).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={block.muted ?? false}
                onChange={(e) => onChange({ ...block, muted: e.target.checked })}
                className="accent-primary"
              />
              <span className="text-muted-foreground">muted</span>
            </label>
          </div>
        </div>
      );

    case 'Image':
      return (
        <div className="space-y-1.5">
          <FieldSelect
            label="src"
            value={block.src}
            fields={fields.filter((f) => f.type === 'file' || f.name.includes('image') || f.name.includes('photo') || f.name.includes('avatar'))}
            onChange={(v) => onChange({ ...block, src: v })}
          />
          <div className="flex items-center gap-2 text-xs">
            <label className="w-14 shrink-0 text-muted-foreground">size</label>
            <select
              value={typeof block.size === 'number' ? String(block.size) : (block.size ?? 'sm')}
              onChange={(e) => {
                const v = e.target.value;
                const n = Number(v);
                onChange({ ...block, size: isNaN(n) ? (v as typeof block.size) : n });
              }}
              className="rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
            >
              {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={block.rounded ?? false}
                onChange={(e) => onChange({ ...block, rounded: e.target.checked })}
                className="accent-primary"
              />
              <span className="text-muted-foreground">rounded</span>
            </label>
          </div>
        </div>
      );

    case 'Badge':
      return (
        <div className="space-y-1.5">
          <FieldSelect
            label="value"
            value={block.value}
            fields={fields}
            onChange={(v) => onChange({ ...block, value: v })}
          />
        </div>
      );

    case 'Spacer':
      return (
        <div className="flex items-center gap-2 text-xs">
          <label className="w-14 shrink-0 text-muted-foreground">size (px)</label>
          <input
            type="number"
            min={0}
            max={64}
            value={block.size ?? 8}
            onChange={(e) => onChange({ ...block, size: Number(e.target.value) })}
            className="w-20 rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
        </div>
      );

    case 'Stack':
      return (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <label className="w-14 shrink-0 text-muted-foreground">direction</label>
          <select
            value={block.direction ?? 'col'}
            onChange={(e) =>
              onChange({ ...block, direction: e.target.value as typeof block.direction })
            }
            className="rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          >
            <option value="col">col</option>
            <option value="row">row</option>
          </select>
          <label className="text-muted-foreground">gap</label>
          <input
            type="number"
            min={0}
            max={32}
            value={block.gap ?? 4}
            onChange={(e) => onChange({ ...block, gap: Number(e.target.value) })}
            className="w-14 rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <span className="text-[10px] text-muted-foreground italic">(children editable via JSON tab)</span>
        </div>
      );

    case 'Row':
      return (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <label className="w-14 shrink-0 text-muted-foreground">align</label>
          <select
            value={block.align ?? 'center'}
            onChange={(e) =>
              onChange({ ...block, align: e.target.value as typeof block.align })
            }
            className="rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          >
            {(['start', 'center', 'end', 'between'] as const).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <label className="text-muted-foreground">gap</label>
          <input
            type="number"
            min={0}
            max={32}
            value={block.gap ?? 8}
            onChange={(e) => onChange({ ...block, gap: Number(e.target.value) })}
            className="w-14 rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <span className="text-[10px] text-muted-foreground italic">(children editable via JSON tab)</span>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Block row
// ---------------------------------------------------------------------------

interface BlockRowProps {
  entry: TemplateBlock;
  index: number;
  total: number;
  fields: FieldOption[];
  onMove: (from: number, to: number) => void;
  onDelete: (i: number) => void;
  onUpdate: (i: number, entry: TemplateBlock) => void;
}

function BlockRow({ entry, index, total, fields, onMove, onDelete, onUpdate }: BlockRowProps) {
  const [expanded, setExpanded] = useState(true);
  const isContainer = CONTAINER_TYPES.includes(entry.render.type as BlockType);

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        {/* Type badge */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-mono uppercase font-semibold ${TYPE_COLOUR[entry.render.type as BlockType] ?? 'bg-muted text-muted-foreground'}`}
        >
          {entry.render.type}
        </button>

        {/* Condition */}
        <input
          type="text"
          value={entry.if ?? ''}
          onChange={(e) =>
            onUpdate(index, { ...entry, if: e.target.value || undefined })
          }
          placeholder="if: $.field"
          className="rounded border bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground outline-none focus:border-primary w-28"
        />

        <div className="flex-1" />

        {/* Move buttons */}
        <button
          type="button"
          onClick={() => onMove(index, index - 1)}
          disabled={index === 0}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30"
          title="Move up"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, index + 1)}
          disabled={index === total - 1}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30"
          title="Move down"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(index)}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-destructive/10 text-destructive"
          title="Remove block"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Config */}
      {expanded && (
        <div className="px-3 py-2.5 space-y-2">
          <ConfigPanel
            block={entry.render}
            fields={fields}
            onChange={(next) => onUpdate(index, { ...entry, render: next })}
          />
          {isContainer && (entry.render as { children?: TemplateBlock[] }).children && (entry.render as { children?: TemplateBlock[] }).children!.length > 0 && (
            <p className="text-[10px] text-muted-foreground italic">
              {(entry.render as { children?: TemplateBlock[] }).children!.length} child block(s) — edit in JSON tab
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add block toolbar
// ---------------------------------------------------------------------------

function AddBlockToolbar({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Add block
      </button>
      {open && (
        <div className="absolute start-0 top-full z-20 mt-1 w-44 rounded-md border bg-popover shadow-md overflow-hidden">
          {BLOCK_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onAdd(type);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent"
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-mono uppercase font-semibold ${TYPE_COLOUR[type]}`}
              >
                {type}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual tab
// ---------------------------------------------------------------------------

function VisualTab({
  template,
  fields,
  onChange,
}: {
  template: ComponentTemplate;
  fields: FieldOption[];
  onChange: (next: ComponentTemplate) => void;
}) {
  const blocks = template.template;

  const updateBlock = (i: number, entry: TemplateBlock) => {
    const next = [...blocks];
    next[i] = entry;
    onChange({ ...template, template: next });
  };

  const deleteBlock = (i: number) => {
    const next = blocks.filter((_, idx) => idx !== i);
    onChange({ ...template, template: next });
  };

  const moveBlock = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length) return;
    const next = [...blocks];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange({ ...template, template: next });
  };

  const addBlock = (type: BlockType) => {
    const entry: TemplateBlock = { render: defaultBlock(type) };
    onChange({ ...template, template: [...blocks, entry] });
  };

  return (
    <div className="space-y-2">
      {blocks.length === 0 && (
        <div className="rounded-lg border border-dashed py-10 text-center text-xs text-muted-foreground">
          No blocks yet. Add one below.
        </div>
      )}
      {blocks.map((entry, i) => (
        <BlockRow
          key={i}
          entry={entry}
          index={i}
          total={blocks.length}
          fields={fields}
          onMove={moveBlock}
          onDelete={deleteBlock}
          onUpdate={updateBlock}
        />
      ))}
      <AddBlockToolbar onAdd={addBlock} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON tab
// ---------------------------------------------------------------------------

function JsonTab({
  template,
  onChange,
}: {
  template: ComponentTemplate;
  onChange: (next: ComponentTemplate) => void;
}) {
  const [raw, setRaw] = useState(() => serializeComponentTemplate(template));
  const [error, setError] = useState<string | null>(null);

  // Sync raw when template changes externally (e.g. visual tab edits)
  useEffect(() => {
    const serialized = serializeComponentTemplate(template);
    setRaw(serialized);
    setError(null);
  }, [template]);

  const handleChange = (text: string) => {
    setRaw(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['kind'] === 'component-template'
      ) {
        onChange(parsed as ComponentTemplate);
        setError(null);
      } else {
        setError('JSON must have `"kind": "component-template"`');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <textarea
        value={raw}
        onChange={(e) => handleChange(e.target.value)}
        rows={18}
        spellCheck={false}
        className="w-full rounded-md border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed outline-none focus:border-primary resize-y"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview tab
// ---------------------------------------------------------------------------

function PreviewTab({
  template,
  sample,
  fields,
}: {
  template: ComponentTemplate;
  sample: Record<string, unknown>;
  fields: FieldOption[];
}) {
  // Build 3 variants: first (all fields present), partial, empty
  const fullSample = { ...sample };
  const partialSample = Object.fromEntries(
    Object.entries(sample).slice(0, Math.ceil(Object.keys(sample).length / 2)),
  );

  const specimens: Array<{ label: string; data: Record<string, unknown> }> = [
    { label: 'Full row', data: fullSample },
    { label: 'Partial row', data: partialSample },
    { label: 'Empty row', data: {} },
  ];

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">
        Preview with 3 sample rows: full, partial, empty.
      </p>
      <div className="divide-y rounded-lg border overflow-hidden">
        {specimens.map(({ label, data }) => (
          <div key={label} className="flex items-center gap-4 px-4 py-3">
            <span className="w-24 shrink-0 text-[10px] text-muted-foreground uppercase font-medium">
              {label}
            </span>
            <div className="flex-1">
              <BlockTemplateRenderer template={template} sample={data} />
            </div>
          </div>
        ))}
      </div>
      {fields.length === 0 && (
        <p className="text-[11px] text-amber-600">
          No fields — sample data is empty. Preview is limited.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Editor
// ---------------------------------------------------------------------------

/**
 * Block Template Editor — Phase F FE.
 *
 * Three-tab component: Visual (GUI block list) | JSON (raw DSL textarea) | Preview.
 *
 * The Visual tab supports top-level blocks with inline config. Container block
 * children (Stack/Row nested blocks) are editable through the JSON tab — this
 * is intentional complexity management for Phase F MVP.
 */
export function BlockTemplateEditor({
  value,
  onChange,
  fields = [],
  sample,
}: BlockTemplateEditorProps) {
  const [tab, setTab] = useState<EditorTab>('visual');

  const template = useMemo(() => value ?? emptyComponentTemplate(), [value]);

  // Build sample from fields if none provided
  const resolvedSample = useMemo(() => {
    if (sample) return sample;
    return Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.type === 'boolean'
          ? true
          : f.type === 'integer' || f.type === 'decimal'
          ? 42
          : f.type === 'datetime' || f.type === 'date'
          ? new Date().toISOString()
          : `<${f.name}>`,
      ]),
    );
  }, [sample, fields]);

  const TABS: Array<{ id: EditorTab; label: string; icon: React.ReactNode }> = [
    { id: 'visual', label: 'Visual', icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'json', label: 'JSON', icon: <Code2 className="h-3.5 w-3.5" /> },
    { id: 'preview', label: 'Preview', icon: <Eye className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5 w-fit">
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === id
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'visual' && (
        <VisualTab template={template} fields={fields} onChange={onChange} />
      )}
      {tab === 'json' && (
        <JsonTab template={template} onChange={onChange} />
      )}
      {tab === 'preview' && (
        <PreviewTab template={template} sample={resolvedSample} fields={fields} />
      )}
    </div>
  );
}
