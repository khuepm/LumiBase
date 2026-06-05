import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollectionResource, FieldResource } from '@lumibase/sdk';
import { GripVertical, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { FieldInspector, type FieldFormState } from './field-inspector';

interface FieldsTabProps {
  collectionName: string;
}

/**
 * Fields tab: drag-drop reorder + inspector for adding/editing fields.
 * Uses dnd-kit per the roadmap.
 */
export function FieldsTab({ collectionName }: FieldsTabProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FieldFormState | null>(null);

  const fieldsQuery = useQuery({
    queryKey: ['fields', collectionName],
    queryFn: async () =>
      (await client.schema.listFields(collectionName)).data,
  });
  const compiledQuery = useQuery({
    queryKey: ['compiled', collectionName],
    queryFn: async () => (await client.schema.getCompiled(collectionName)).data,
  });

  const upsertMutation = useMutation({
    mutationFn: async (state: FieldFormState) => {
      await client.schema.upsertField(collectionName, state.name, {
        name: state.name,
        type: state.type,
        interface: state.interface,
        required: state.required,
        readonly: state.readonly ?? false,
        hidden: state.hidden ?? false,
        width: state.width ?? 'full',
        sortOrder: state.sortOrder,
        display: state.display ?? null,
        displayOptions: state.displayOptions ?? {},
        translations: state.translations ?? {},
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fields', collectionName] });
      queryClient.invalidateQueries({ queryKey: ['collection', collectionName] });
      setEditing(null);
    },
  });
  const updateSystemFieldMutation = useMutation({
    mutationFn: async (state: FieldFormState) => {
      const compiled = compiledQuery.data;
      const meta = { ...((compiled?.meta as Record<string, unknown> | undefined) ?? {}) };
      const overrides = {
        ...((meta.systemFieldOverrides as Record<string, unknown> | undefined) ?? {}),
        [state.name]: {
          display: state.display ?? null,
          hidden: state.hidden ?? false,
          readonly: state.readonly ?? false,
          width: state.width ?? 'full',
          translations: state.translations ?? {},
        },
      };
      meta.systemFieldOverrides = overrides;
      await client.schema.updateCollection(collectionName, { meta } as Partial<CollectionResource>);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compiled', collectionName] });
      queryClient.invalidateQueries({ queryKey: ['collection', collectionName] });
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (fieldName: string) => {
      await client.schema.deleteField(collectionName, fieldName);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['fields', collectionName] }),
  });

  const reorderMutation = useMutation({
    mutationFn: async (newOrder: { name: string; type: string; interface: string; sortOrder: number }[]) => {
      // Persist new sortOrder for each field. Backend supports per-field upsert.
      for (const f of newOrder) {
        await client.schema.upsertField(collectionName, f.name, {
          name: f.name,
          type: f.type,
          interface: f.interface,
          sortOrder: f.sortOrder,
        });
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['fields', collectionName] }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fields = fieldsQuery.data ?? [];
  const systemFields = compiledQuery.data?.systemFields ?? [];

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    const reordered = arrayMove(fields, oldIndex, newIndex);
    reorderMutation.mutate(
      reordered.map((f, i) => ({
        name: f.name,
        type: f.type,
        interface: f.interface,
        sortOrder: i,
      })),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Fields</h2>
        <button
          type="button"
          onClick={() =>
            setEditing({
              name: '',
              type: 'string',
              interface: 'input',
              required: false,
              sortOrder: fields.length,
              display: null,
              displayOptions: {},
              hidden: false,
              readonly: false,
              width: 'full',
              translations: {},
            })
          }
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs"
        >
          <Plus className="h-3 w-3" /> Add field
        </button>
      </div>

      {fieldsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading fields…</p>
      )}

      {systemFields.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-xs font-medium uppercase text-muted-foreground">System fields</h3>
          </div>
          <ul className="divide-y rounded-lg border bg-muted/20">
            {systemFields.map((field) => (
              <SystemFieldRow
                key={field.id}
                field={field}
                onEdit={() => setEditing(toFieldFormState(field, true))}
              />
            ))}
          </ul>
        </section>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y rounded-lg border">
            {fields.map((f) => (
              <SortableField
                key={f.id}
                id={f.id}
                name={f.name}
                type={f.type}
                interfaceName={f.interface}
                required={f.required}
                onEdit={() =>
                  setEditing({
                    name: f.name,
                    type: f.type,
                    interface: f.interface,
                    required: f.required,
                    sortOrder: f.sortOrder,
                    display: ((f as unknown as { display?: string | null }).display) ?? null,
                    displayOptions:
                      ((f as unknown as { displayOptions?: Record<string, unknown> })
                        .displayOptions) ?? {},
                    hidden: f.hidden,
                    readonly: ((f as unknown as { readonly?: boolean }).readonly) ?? false,
                    width: ((f as unknown as { width?: FieldFormState['width'] }).width) ?? 'full',
                    translations:
                      ((f as unknown as { translations?: Record<string, unknown> })
                        .translations) ?? {},
                  })
                }
                onDelete={() => {
                  if (confirm(`Delete field "${f.name}"?`)) {
                    deleteMutation.mutate(f.name);
                  }
                }}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {fields.length === 0 && !fieldsQuery.isLoading && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No fields yet. Click <strong>Add field</strong> to begin.
        </p>
      )}

      {editing && (
        <FieldInspector
          key={`${editing.system ? 'system' : 'field'}:${editing.name || 'new'}`}
          state={editing}
          siblingFields={fields
            .filter((f) => f.name !== editing.name)
            .map((f) => ({ name: f.name, type: f.type, interface: f.interface }))}
          onCancel={() => setEditing(null)}
          onSubmit={(state) =>
            state.system
              ? updateSystemFieldMutation.mutate(state)
              : upsertMutation.mutate(state)
          }
          isSubmitting={upsertMutation.isPending || updateSystemFieldMutation.isPending}
        />
      )}
    </div>
  );
}

function toFieldFormState(field: FieldResource, locked: boolean): FieldFormState {
  return {
    name: field.name,
    type: field.type,
    interface: field.interface,
    required: field.required,
    readonly: field.readonly ?? false,
    hidden: field.hidden,
    width: field.width ?? 'full',
    sortOrder: field.sortOrder,
    display: field.display ?? null,
    displayOptions: field.displayOptions ?? {},
    translations: field.translations ?? {},
    system: field.system ?? false,
    locked,
  };
}

interface SystemFieldRowProps {
  field: FieldResource;
  onEdit: () => void;
}

function SystemFieldRow({ field, onEdit }: SystemFieldRowProps) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <div className="flex-1">
        <button type="button" onClick={onEdit} className="font-medium hover:underline">
          {field.name}
        </button>
        <span className="ml-2 text-xs text-muted-foreground">
          {field.type} · {field.interface}
          {field.hidden && ' · hidden'}
          {field.readonly && ' · readonly'}
        </span>
      </div>
      <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground">Locked</span>
    </li>
  );
}

interface SortableFieldProps {
  id: string;
  name: string;
  type: string;
  interfaceName: string;
  required: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableField({ id, name, type, interfaceName, required, onEdit, onDelete }: SortableFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-3 px-3 py-2">
      <button
        type="button"
        className="cursor-grab text-muted-foreground"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1">
        <button
          type="button"
          onClick={onEdit}
          className="font-medium hover:underline"
        >
          {name}
        </button>
        <span className="ml-2 text-xs text-muted-foreground">
          {type} · {interfaceName}
          {required && ' · required'}
        </span>
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${name}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}
