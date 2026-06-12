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
import {
  GripVertical,
  Lock,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  AlertTriangle,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { FieldInspector, type FieldFormState } from './field-inspector';

interface FieldsTabProps {
  collectionName: string;
}

export function FieldsTab({ collectionName }: FieldsTabProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FieldFormState | null>(null);

  const fieldsQuery = useQuery({
    queryKey: ['fields', collectionName],
    queryFn: async () => (await client.schema.listFields(collectionName)).data,
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
        label: state.label ?? null,
        note: state.note ?? null,
        defaultValue: state.defaultValue,
        nullable: state.nullable ?? !state.required,
        unique: state.unique ?? false,
        indexed: state.indexed ?? false,
        searchable: state.searchable ?? true,
        length: state.length ?? null,
        precision: state.precision ?? null,
        scale: state.scale ?? null,
        special: state.special ?? [],
        options: state.options ?? {},
        required: state.required,
        readonly: state.readonly ?? false,
        hidden: state.hidden ?? false,
        encrypted: state.encrypted ?? false,
        versioned: state.versioned ?? false,
        rawEnabled: state.rawEnabled ?? true,
        group: state.group ?? null,
        width: state.width ?? 'full',
        sortOrder: state.sortOrder,
        display: state.display ?? null,
        displayOptions: state.displayOptions ?? {},
        validation: state.validation ?? { rules: [] },
        conditions: state.conditions ?? [],
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
    mutationFn: async (
      newOrder: { name: string; type: string; interface: string; sortOrder: number }[],
    ) => {
      await Promise.all(
        newOrder.map((f) =>
          client.schema.upsertField(collectionName, f.name, {
            name: f.name,
            type: f.type,
            interface: f.interface,
            sortOrder: f.sortOrder,
          }),
        ),
      );
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

  const openNewField = () =>
    setEditing({
      name: '',
      type: 'string',
      interface: 'input',
      label: null,
      note: null,
      defaultValue: undefined,
      nullable: true,
      unique: false,
      indexed: false,
      searchable: true,
      length: null,
      precision: null,
      scale: null,
      special: [],
      options: {},
      required: false,
      sortOrder: fields.length,
      display: null,
      displayOptions: {},
      validation: { rules: [] },
      conditions: [],
      hidden: false,
      readonly: false,
      encrypted: false,
      versioned: false,
      rawEnabled: true,
      group: null,
      width: 'full',
      translations: {},
    });

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Fields</h2>
          <p className="text-xs text-muted-foreground">
            {fields.length} custom {fields.length === 1 ? 'field' : 'fields'}
            {systemFields.length > 0 && ` · ${systemFields.length} system`}
          </p>
        </div>
        <button
          type="button"
          onClick={openNewField}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          Add field
        </button>
      </div>

      {fieldsQuery.isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-14 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      )}

      {/* System fields */}
      {systemFields.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              System fields
            </span>
          </div>
          <ul className="divide-y rounded-lg border bg-muted/10">
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

      {/* Custom fields — drag-drop */}
      {!fieldsQuery.isLoading && (
        <section>
          {systemFields.length > 0 && (
            <div className="mb-2 flex items-center gap-1.5">
              <Settings2 className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Custom fields
              </span>
            </div>
          )}

          {fields.length === 0 ? (
            <button
              type="button"
              onClick={openNewField}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary/80"
            >
              <Plus className="h-6 w-6" />
              <span>Add your first field</span>
            </button>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={fields.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="divide-y rounded-lg border">
                  {fields.map((f) => (
                    <SortableField
                      key={f.id}
                      id={f.id}
                      field={f}
                      onEdit={() =>
                        setEditing({
                          name: f.name,
                          type: f.type,
                          interface: f.interface,
                          label: ((f as unknown as { label?: string | null }).label) ?? null,
                          note: ((f as unknown as { note?: string | null }).note) ?? null,
                          defaultValue: (f as unknown as { defaultValue?: unknown }).defaultValue,
                          nullable:
                            ((f as unknown as { nullable?: boolean }).nullable) ?? !f.required,
                          unique: ((f as unknown as { unique?: boolean }).unique) ?? false,
                          indexed: ((f as unknown as { indexed?: boolean }).indexed) ?? false,
                          searchable:
                            ((f as unknown as { searchable?: boolean }).searchable) ?? true,
                          length:
                            ((f as unknown as { length?: number | null }).length) ?? null,
                          precision:
                            ((f as unknown as { precision?: number | null }).precision) ?? null,
                          scale: ((f as unknown as { scale?: number | null }).scale) ?? null,
                          special:
                            ((f as unknown as { special?: unknown[] }).special) ?? [],
                          options:
                            ((f as unknown as { options?: Record<string, unknown> }).options) ?? {},
                          required: f.required,
                          sortOrder: f.sortOrder,
                          display:
                            ((f as unknown as { display?: string | null }).display) ?? null,
                          displayOptions:
                            ((f as unknown as {
                              displayOptions?: Record<string, unknown>;
                            }).displayOptions) ?? {},
                          validation:
                            ((f as unknown as {
                              validation?: Record<string, unknown>;
                            }).validation) ?? { rules: [] },
                          conditions:
                            ((f as unknown as { conditions?: unknown[] }).conditions) ?? [],
                          hidden: f.hidden,
                          readonly:
                            ((f as unknown as { readonly?: boolean }).readonly) ?? false,
                          encrypted:
                            ((f as unknown as { encrypted?: boolean }).encrypted) ?? false,
                          versioned:
                            ((f as unknown as { versioned?: boolean }).versioned) ?? false,
                          rawEnabled:
                            ((f as unknown as { rawEnabled?: boolean }).rawEnabled) ?? true,
                          group: ((f as unknown as { group?: string | null }).group) ?? null,
                          width:
                            ((f as unknown as { width?: FieldFormState['width'] }).width) ??
                            'full',
                          translations:
                            ((f as unknown as {
                              translations?: Record<string, unknown>;
                            }).translations) ?? {},
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
          )}
        </section>
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
    label: field.label ?? null,
    note: field.note ?? null,
    defaultValue: field.defaultValue,
    nullable: field.nullable ?? !field.required,
    unique: field.unique ?? false,
    indexed: field.indexed ?? false,
    searchable: field.searchable ?? false,
    length: field.length ?? null,
    precision: field.precision ?? null,
    scale: field.scale ?? null,
    special: field.special ?? [],
    options: field.options ?? {},
    required: field.required,
    readonly: field.readonly ?? false,
    hidden: field.hidden,
    encrypted: field.encrypted ?? false,
    versioned: field.versioned ?? false,
    rawEnabled: field.rawEnabled ?? false,
    group: field.group ?? 'system',
    width: field.width ?? 'full',
    sortOrder: field.sortOrder,
    display: field.display ?? null,
    displayOptions: field.displayOptions ?? {},
    validation: field.validation ?? { rules: [] },
    conditions: field.conditions ?? [],
    translations: field.translations ?? {},
    system: field.system ?? false,
    locked,
  };
}

// ─── System field row ────────────────────────────────────────────────────────

interface SystemFieldRowProps {
  field: FieldResource;
  onEdit: () => void;
}

function SystemFieldRow({ field, onEdit }: SystemFieldRowProps) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onEdit}
          className="font-mono text-sm font-medium hover:underline"
        >
          {field.name}
        </button>
        {field.label && (
          <span className="ml-2 text-xs text-muted-foreground">{field.label}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <TypeBadge type={field.type} />
        <span className="rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {field.interface}
        </span>
        {field.hidden && <EyeOff className="h-3 w-3 text-muted-foreground" aria-label="Hidden" />}
      </div>
    </li>
  );
}

// ─── Sortable field row ───────────────────────────────────────────────────────

interface SortableFieldProps {
  id: string;
  field: FieldResource;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableField({ id, field, onEdit, onDelete }: SortableFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const display = (field as unknown as { display?: string | null }).display;
  const isRelation = field.interface?.startsWith('relation-') || field.interface === 'files';
  const missingDisplay = isRelation && !display;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 ${
        isDragging ? 'bg-muted/60' : ''
      }`}
    >
      {/* Drag handle */}
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Main content */}
      <div className="flex flex-1 min-w-0 items-center gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onEdit}
            className="font-mono text-sm font-medium hover:underline"
          >
            {field.name}
          </button>
          {field.label && (
            <span className="ml-2 text-xs text-muted-foreground">{field.label}</span>
          )}
        </div>

        {/* Badges */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {field.required && (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              required
            </span>
          )}
          {field.hidden && (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-label="Hidden" />
          )}
          {missingDisplay && (
            <span title="No table display configured — will show raw ID">
              <AlertTriangle
                className="h-3.5 w-3.5 text-amber-500"
                aria-label="No table display configured"
              />
            </span>
          )}
          <TypeBadge type={field.type} />
          <span className="rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {field.interface}
          </span>
          {display && (
            <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400">
              {display}
            </span>
          )}
        </div>
      </div>

      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label={`Delete ${field.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {type}
    </span>
  );
}
