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
import { useQuery } from '@tanstack/react-query';
import { GripVertical, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { RelationDrawer } from './relation-drawer';
import { readOptions, type InterfaceComponent } from './types';

/** One linked record: which collection it lives in, and its id. */
export interface M2ABlock {
  collection: string;
  id: string;
}

interface RelationM2AOptions {
  /** Collections this field may link to. */
  collections?: string[];
  /** Per-collection label field; falls back to `title`. */
  displayFields?: Record<string, string>;
}

function asBlocks(value: unknown): M2ABlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is M2ABlock =>
      !!b && typeof b === 'object' && typeof (b as M2ABlock).collection === 'string' && typeof (b as M2ABlock).id === 'string',
  );
}

const keyOf = (b: M2ABlock) => `${b.collection}:${b.id}`;

/**
 * `relation-m2a` — the "Builder" interface. Links the current item to records
 * across *multiple* collections (many-to-any). Stores an ordered array of
 * `{ collection, id }`. Provides per-collection "Create new" / "Add existing"
 * via the shared RelationDrawer, plus drag-to-reorder.
 */
export const RelationM2AInterface: InterfaceComponent<M2ABlock[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<RelationM2AOptions>(field);
  const collections = opts.collections ?? [];
  const blocks = asBlocks(value);
  const [target, setTarget] = useState(collections[0] ?? '');
  const [drawer, setDrawer] = useState<null | 'existing' | 'new'>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (collections.length === 0) {
    return (
      <p className="text-xs text-destructive">
        Missing `meta.options.collections` (array of linkable collections) for M2A field.
      </p>
    );
  }

  const displayFieldFor = (collection: string) => opts.displayFields?.[collection] ?? 'title';

  const addFromTarget = (ids: string[]) => {
    const next = [...blocks];
    for (const id of ids) {
      const block = { collection: target, id };
      if (!next.some((b) => keyOf(b) === keyOf(block))) next.push(block);
    }
    onChange(next);
  };

  const remove = (block: M2ABlock) => onChange(blocks.filter((b) => keyOf(b) !== keyOf(block)));

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = blocks.findIndex((b) => keyOf(b) === active.id);
    const to = blocks.findIndex((b) => keyOf(b) === over.id);
    if (from === -1 || to === -1) return;
    onChange(arrayMove(blocks, from, to));
  };

  return (
    <div className="space-y-2">
      {blocks.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={blocks.map(keyOf)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {blocks.map((block) => (
                <SortableBlock
                  key={keyOf(block)}
                  block={block}
                  displayField={displayFieldFor(block.collection)}
                  disabled={disabled}
                  onRemove={() => remove(block)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setDrawer('existing')}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            <Search className="h-3 w-3" /> Add existing
          </button>
          <button
            type="button"
            onClick={() => setDrawer('new')}
            className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <Plus className="h-3 w-3" /> Create new
          </button>
        </div>
      )}

      {drawer && target && (
        <RelationDrawer
          collection={target}
          displayField={displayFieldFor(target)}
          excludeIds={blocks.filter((b) => b.collection === target).map((b) => b.id)}
          initialMode={drawer}
          onClose={() => setDrawer(null)}
          onSelect={addFromTarget}
        />
      )}
    </div>
  );
};

function SortableBlock({
  block,
  displayField,
  disabled,
  onRemove,
}: {
  block: M2ABlock;
  displayField: string;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const client = getApiClient();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: keyOf(block),
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const labelQuery = useQuery({
    queryKey: ['m2a-block-label', block.collection, block.id, displayField],
    queryFn: async () => client.items(block.collection as never).detail(block.id),
  });
  const blockData = labelQuery.data?.data as Record<string, unknown> | undefined;
  const label = blockData ? String(blockData[displayField] ?? block.id) : `${block.id.slice(0, 6)}…`;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm"
    >
      {!disabled && (
        <button
          type="button"
          className="cursor-grab text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
        {block.collection}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {!disabled && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${keyOf(block)}`}>
          <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}
