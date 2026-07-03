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

interface RelationManyOptions {
  collection?: string;
  displayField?: string;
}

/**
 * `relation-o2m` / `relation-m2m` — ordered multi-id picker.
 * Stores an array of related ids. Offers "Create new" and "Add existing"
 * actions (shared `RelationDrawer`) and drag-to-reorder. Junction writes for
 * m2m are handled server-side once the relation engine resolves the field.
 */
export const RelationManyInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<RelationManyOptions>(field);
  const [drawer, setDrawer] = useState<null | 'existing' | 'new'>(null);
  const client = getApiClient();
  const collection = opts.collection;
  const display = opts.displayField ?? 'title';
  const ids = Array.isArray(value) ? value : [];

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Fetch display labels for already-selected ids.
  const labelsQuery = useQuery({
    enabled: !!collection && ids.length > 0,
    queryKey: ['relation-many-labels', collection, ids, display],
    queryFn: async () =>
      client.items(collection as never).list({
        filter: { id: { _in: ids } },
        limit: ids.length,
      }),
  });

  if (!collection) {
    return (
      <p className="text-xs text-destructive">
        Missing `meta.options.collection` for relation field.
      </p>
    );
  }

  const labelFor = (id: string) => {
    const row = labelsQuery.data?.data.find((r) => r.id === id);
    return row ? String(row.data?.[display] ?? id) : `${id.slice(0, 6)}…`;
  };

  const addIds = (next: string[]) => {
    const merged = [...ids];
    for (const id of next) if (!merged.includes(id)) merged.push(id);
    onChange(merged);
  };

  const remove = (id: string) => onChange(ids.filter((i) => i !== id));

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onChange(arrayMove(ids, from, to));
  };

  return (
    <div className="space-y-2">
      {ids.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {ids.map((id) => (
                <SortableChip
                  key={id}
                  id={id}
                  label={labelFor(id)}
                  disabled={disabled}
                  onRemove={() => remove(id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {!disabled && (
        <div className="flex gap-2">
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

      {drawer && (
        <RelationDrawer
          collection={collection}
          displayField={display}
          excludeIds={ids}
          initialMode={drawer}
          onClose={() => setDrawer(null)}
          onSelect={addIds}
        />
      )}
    </div>
  );
};

function SortableChip({
  id,
  label,
  disabled,
  onRemove,
}: {
  id: string;
  label: string;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
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
      <span className="flex-1 truncate">{label}</span>
      {!disabled && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${id}`}>
          <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}
