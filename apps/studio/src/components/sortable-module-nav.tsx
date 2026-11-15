import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ModuleNavItem, type ModuleDef } from '@/components/module-nav-item';

/**
 * Drag-to-reorder module sidebar (#757). Lazy-loaded by the app shell only
 * while an admin is in "Reorder modules" mode, so `@dnd-kit/*` stays out of
 * the initial Studio bundle for the (far more common) read-only sidebar.
 */

function SortableItem(props: { module: ModuleDef; active: boolean; adminBase: string; expanded: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.module.id });
  return (
    <ModuleNavItem
      {...props}
      editing
      containerRef={setNodeRef}
      containerStyle={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      dragging={isDragging}
      handleProps={{ ...attributes, ...listeners }}
    />
  );
}

export interface SortableModuleNavProps {
  modules: ModuleDef[];
  activeModule: string;
  adminBase: string;
  expanded: boolean;
  onReorder: (nextOrder: string[]) => void;
}

export function SortableModuleNav({ modules, activeModule, adminBase, expanded, onReorder }: SortableModuleNavProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const current = modules.map((module) => module.id);
    onReorder(arrayMove(current, current.indexOf(String(active.id)), current.indexOf(String(over.id))));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={modules.map((module) => module.id)} strategy={verticalListSortingStrategy}>
        {modules.map((module) => (
          <SortableItem key={module.id} module={module} active={activeModule === module.id} adminBase={adminBase} expanded={expanded} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

export default SortableModuleNav;
