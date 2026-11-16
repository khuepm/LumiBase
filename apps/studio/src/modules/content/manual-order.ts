/** Manual ordering (#690): where a dragged row lands relative to the drop target. */
export type ReorderTarget = { after: string | null } | { before: string };

/**
 * Dragging down places the item after the target, dragging up places it
 * before — relative ids, so it works on any page of a filtered list.
 */
export function reorderTargetFor(order: string[], dragId: string, targetId: string): ReorderTarget | null {
  const from = order.indexOf(dragId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  return from < to ? { after: targetId } : { before: targetId };
}
