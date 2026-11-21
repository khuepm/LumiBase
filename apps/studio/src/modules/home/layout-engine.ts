import {
  DASHBOARD_GRID_COLUMNS as COLS,
  DASHBOARD_MAX_ROWS,
  type DashboardLayout,
  type DashboardWidget,
} from '@lumibase/contracts';

/**
 * Pure grid operations for the dashboard composer (#691). Widgets sit on a
 * 12-column grid; after every move or resize the layout is compacted upward
 * (each widget falls to the highest row where it collides with nothing
 * already placed), so there are no holes and no overlaps.
 */

function overlaps(a: DashboardWidget, b: DashboardWidget): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function clampWidget(w: DashboardWidget): DashboardWidget {
  const width = Math.max(1, Math.min(COLS, Math.round(w.w)));
  const height = Math.max(1, Math.min(12, Math.round(w.h)));
  return {
    ...w,
    w: width,
    h: height,
    x: Math.max(0, Math.min(COLS - width, Math.round(w.x))),
    y: Math.max(0, Math.min(DASHBOARD_MAX_ROWS, Math.round(w.y))),
  };
}

/**
 * Remove overlaps and float everything up. `pinned` (the widget just moved
 * or resized) keeps its position; the others flow around it in reading order.
 */
export function compact(widgets: DashboardWidget[], pinned?: string): DashboardWidget[] {
  const clamped = widgets.map(clampWidget);
  const first = clamped.filter((w) => w.id === pinned);
  const rest = clamped.filter((w) => w.id !== pinned).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: DashboardWidget[] = [];
  for (const w of [...first, ...rest]) {
    let y = w.id === pinned ? w.y : 0;
    const candidate = { ...w, y };
    while (placed.some((p) => overlaps(p, candidate))) candidate.y = ++y;
    if (w.id !== pinned) {
      // Float up as far as possible without colliding.
      while (candidate.y > 0 && !placed.some((p) => overlaps(p, { ...candidate, y: candidate.y - 1 }))) candidate.y -= 1;
    }
    placed.push(candidate);
  }
  // Pinned widget may now sit below free space: float it up too.
  return placed
    .map((w) => {
      if (w.id !== pinned) return w;
      const others = placed.filter((p) => p.id !== pinned);
      const c = { ...w };
      while (c.y > 0 && !others.some((p) => overlaps(p, { ...c, y: c.y - 1 }))) c.y -= 1;
      return c;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function moveWidget(layout: DashboardLayout, id: string, x: number, y: number): DashboardLayout {
  return {
    ...layout,
    widgets: compact(layout.widgets.map((w) => (w.id === id ? { ...w, x, y } : w)), id),
  };
}

export function resizeWidget(layout: DashboardLayout, id: string, w: number, h: number): DashboardLayout {
  return {
    ...layout,
    widgets: compact(layout.widgets.map((wg) => (wg.id === id ? { ...wg, w, h } : wg)), id),
  };
}

export function removeWidget(layout: DashboardLayout, id: string): DashboardLayout {
  return { ...layout, widgets: compact(layout.widgets.filter((w) => w.id !== id)) };
}

/** Add a widget at the bottom of the board. */
export function addWidget(
  layout: DashboardLayout,
  widget: Omit<DashboardWidget, 'x' | 'y' | 'id'> & { id?: string },
): DashboardLayout {
  const bottom = layout.widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
  const taken = new Set(layout.widgets.map((w) => w.id));
  let n = 1;
  const base = (widget.id ?? widget.type).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'widget';
  let id = base;
  while (taken.has(id)) id = `${base}-${++n}`;
  return { ...layout, widgets: compact([...layout.widgets, { ...widget, id, x: 0, y: bottom }]) };
}

/** Grid cell under a pointer offset within the board. */
export function cellAt(
  offsetX: number,
  offsetY: number,
  boardWidth: number,
  rowHeight: number,
): { x: number; y: number } {
  const colWidth = boardWidth / COLS;
  return { x: Math.max(0, Math.floor(offsetX / colWidth)), y: Math.max(0, Math.floor(offsetY / rowHeight)) };
}
