import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { FieldResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { resolveInterface } from './registry';
import { useExtensionUpdates } from '@/lib/extension-loader';
import type { InterfaceComponent } from './types';

/**
 * `blocks` — dynamic zone editor (#748).
 *
 * Value: ordered `{ id, type, data }[]`; `type` is a block template, i.e. a
 * collection of this site whose fields are the block's schema. Supports add
 * (picker of `options.allowedBlocks`), remove, reorder (drag, or the
 * keyboard: drag handle + arrows/space via dnd-kit, plus explicit
 * move-up/down buttons), collapse, and a per-block form built from the
 * existing interface registry — so nested `blocks` fields just work.
 * The server is the authority on validation; this editor never drops data
 * it does not understand (unknown block types render read-only).
 */

export interface BlockValue {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface BlocksOptions {
  allowedBlocks: string[];
  min?: number;
  max?: number;
}

const ID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

/** nanoid-compatible 21-char id (Web Crypto); the server keeps ids it is given. */
export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b & 63];
  return id;
}

/** Field options may arrive at `field.options` (REST) or `field.meta.options`. */
export function readBlocksOptions(field: FieldResource): BlocksOptions {
  const meta = (field as { meta?: { options?: unknown } }).meta;
  const raw = (field.options ?? meta?.options ?? {}) as Record<string, unknown>;
  const allowed = Array.isArray(raw.allowedBlocks)
    ? raw.allowedBlocks.filter((v): v is string => typeof v === 'string')
    : [];
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
  return { allowedBlocks: [...new Set(allowed)], min: count(raw.min), max: count(raw.max) };
}

/** `null`/missing/garbage → `[]`; blocks missing an id get one. Never throws. */
export function normalizeBlocks(value: unknown): BlockValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b))
    .map((b) => ({
      id: typeof b.id === 'string' && b.id ? b.id : newBlockId(),
      type: typeof b.type === 'string' ? b.type : '',
      data: b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : {},
    }));
}

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Fields of a template that make sense inside a block form. */
function editableTemplateFields(fields: FieldResource[]): FieldResource[] {
  return fields
    .filter((f) => !f.hidden && !f.system && f.type !== 'alias')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export const BlocksInterface: InterfaceComponent<BlockValue[]> = ({ value, field, disabled, onChange }) => {
  const opts = readBlocksOptions(field);
  const blocks = useMemo(() => normalizeBlocks(value), [value]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  const baseId = useId();
  const client = getApiClient();

  // Template schemas, one query per allowed type (shares the `['fields', name]`
  // cache with the item forms). Types present in the value but no longer
  // allowed are fetched too, so their data still renders.
  const templateNames = useMemo(
    () => [...new Set([...opts.allowedBlocks, ...blocks.map((b) => b.type).filter(Boolean)])],
    [opts.allowedBlocks, blocks],
  );
  const templateQueries = useQueries({
    queries: templateNames.map((name) => ({
      queryKey: ['fields', name],
      queryFn: async () => (await client.schema.listFields(name)).data as FieldResource[],
    })),
  });
  const templates = new Map<string, FieldResource[] | undefined>(
    templateNames.map((name, i) => [name, templateQueries[i]?.data]),
  );

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (opts.allowedBlocks.length === 0) {
    return (
      <p className="text-xs text-destructive">
        Missing `options.allowedBlocks` (block template collections) for this blocks field.
      </p>
    );
  }

  const atMax = opts.max !== undefined && blocks.length >= opts.max;
  const label = (b: BlockValue) => humanize(b.type || 'unknown');

  const emit = (next: BlockValue[]) => onChange(next);
  const add = (type: string) => {
    if (atMax || disabled) return;
    const block: BlockValue = { id: newBlockId(), type, data: {} };
    emit([...blocks, block]);
    setAnnouncement(`Added ${humanize(type)} block at position ${blocks.length + 1}.`);
  };
  const remove = (idx: number) => {
    const removed = blocks[idx];
    emit(blocks.filter((_, i) => i !== idx));
    if (removed) setAnnouncement(`Removed ${label(removed)} block.`);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const moved = blocks[from];
    emit(arrayMove(blocks, from, to));
    if (moved) setAnnouncement(`Moved ${label(moved)} block to position ${to + 1} of ${blocks.length}.`);
  };
  const updateData = (idx: number, data: Record<string, unknown>) =>
    emit(blocks.map((b, i) => (i === idx ? { ...b, data } : b)));
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    move(
      blocks.findIndex((b) => b.id === active.id),
      blocks.findIndex((b) => b.id === over.id),
    );
  };

  return (
    <div className="space-y-2" data-testid="blocks-interface">
      <p className="sr-only" role="status" aria-live="polite" data-testid="blocks-announcer">
        {announcement}
      </p>
      {blocks.length === 0 && <p className="text-xs text-muted-foreground">No blocks yet.</p>}
      {blocks.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <ol className="space-y-2" aria-label={`${field.label ?? field.name} blocks`}>
              {blocks.map((block, idx) => (
                <SortableBlock
                  key={block.id}
                  block={block}
                  idx={idx}
                  total={blocks.length}
                  label={label(block)}
                  allowed={opts.allowedBlocks.includes(block.type)}
                  templateFields={templates.get(block.type)}
                  collapsed={collapsed.has(block.id)}
                  disabled={disabled}
                  bodyId={`${baseId}-block-${block.id}`}
                  onToggle={() => toggle(block.id)}
                  onRemove={() => remove(idx)}
                  onMove={(dir) => move(idx, idx + dir)}
                  onDataChange={(data) => updateData(idx, data)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {!disabled && (
        <div role="group" aria-label="Add block" className="flex flex-wrap items-center gap-1">
          {opts.allowedBlocks.map((type) => (
            <button
              key={type}
              type="button"
              disabled={atMax}
              onClick={() => add(type)}
              className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              <Plus className="h-3 w-3" aria-hidden />
              Add {humanize(type)}
            </button>
          ))}
          {(opts.min !== undefined || opts.max !== undefined) && (
            <span className="ms-auto text-[10px] text-muted-foreground">
              {blocks.length}
              {opts.max !== undefined ? ` / ${opts.max}` : ''} blocks
              {opts.min !== undefined && blocks.length < opts.min ? ` (min ${opts.min})` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

function SortableBlock({
  block,
  idx,
  total,
  label,
  allowed,
  templateFields,
  collapsed,
  disabled,
  bodyId,
  onToggle,
  onRemove,
  onMove,
  onDataChange,
}: {
  block: BlockValue;
  idx: number;
  total: number;
  label: string;
  allowed: boolean;
  templateFields: FieldResource[] | undefined;
  collapsed: boolean;
  disabled?: boolean;
  bodyId: string;
  onToggle: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onDataChange: (data: Record<string, unknown>) => void;
}) {
  useExtensionUpdates(); // sub-fields resolve extension interfaces during render
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const position = `${label} block ${idx + 1} of ${total}`;
  const fields = templateFields ? editableTemplateFields(templateFields) : undefined;
  const preview = fields
    ?.map((f) => block.data[f.name])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '');

  return (
    <li ref={setNodeRef} style={style} className="rounded-md border bg-background" data-block-id={block.id}>
      <div className="flex items-center gap-1 px-2 py-1">
        {!disabled && (
          <button
            type="button"
            className="cursor-grab rounded p-1 text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder ${position}`}
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          className="flex flex-1 items-center gap-2 text-start text-sm"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          )}
          <span className="font-mono text-xs text-muted-foreground">#{idx + 1}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            {label}
          </span>
          {preview && <span className="truncate text-muted-foreground">{preview}</span>}
        </button>
        {!disabled && (
          <div className="flex items-center gap-0.5 text-muted-foreground">
            <button
              type="button"
              disabled={idx === 0}
              onClick={() => onMove(-1)}
              className="rounded p-1 hover:bg-accent disabled:opacity-30"
              aria-label={`Move ${position} up`}
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              disabled={idx === total - 1}
              onClick={() => onMove(1)}
              className="rounded p-1 hover:bg-accent disabled:opacity-30"
              aria-label={`Move ${position} down`}
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded p-1 hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Remove ${position}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <div id={bodyId} className="space-y-3 border-t bg-muted/10 p-3">
          {!allowed && (
            <p className="text-xs text-amber-700">
              Block type “{block.type || 'unknown'}” is not allowed in this field; saving will be rejected until it is removed.
            </p>
          )}
          {fields === undefined && <p className="text-xs text-muted-foreground">Loading block fields…</p>}
          {fields?.length === 0 && <p className="text-xs text-muted-foreground">This block type has no fields.</p>}
          {fields?.map((sf) => {
            const Interface = resolveInterface(sf);
            const inputId = `${bodyId}-${sf.name}`;
            return (
              <div key={sf.name} id={inputId}>
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {sf.label ?? sf.name}
                  {sf.required && <span className="ms-1 text-destructive">*</span>}
                </span>
                <Interface
                  field={sf}
                  value={block.data[sf.name]}
                  disabled={disabled}
                  onChange={(next) => onDataChange({ ...block.data, [sf.name]: next })}
                />
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}
