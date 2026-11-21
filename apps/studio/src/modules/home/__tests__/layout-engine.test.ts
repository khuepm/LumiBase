import { describe, expect, it } from 'vitest';
import { addWidget, cellAt, compact, moveWidget, removeWidget, resizeWidget } from '../layout-engine';
import type { DashboardLayout, DashboardWidget } from '@lumibase/contracts';

const w = (id: string, x: number, y: number, ww: number, h: number): DashboardWidget => ({ id, type: 'note', x, y, w: ww, h });
const L = (...widgets: DashboardWidget[]): DashboardLayout => ({ version: 1, widgets });
const noOverlap = (ws: DashboardWidget[]) =>
  ws.every((a, i) => ws.every((b, j) => i === j || !(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)));

describe('dashboard layout engine (#691)', () => {
  it('floats widgets up and removes holes', () => {
    expect(compact([w('a', 0, 5, 6, 2), w('b', 6, 9, 6, 2)]).map((x) => [x.id, x.y])).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('moves a widget and pushes the one it lands on out of the way', () => {
    const next = moveWidget(L(w('a', 0, 0, 6, 2), w('b', 6, 0, 6, 2)), 'b', 0, 0);
    expect(next.widgets.find((x) => x.id === 'b')).toMatchObject({ x: 0, y: 0 });
    expect(next.widgets.find((x) => x.id === 'a')).toMatchObject({ y: 2 });
    expect(noOverlap(next.widgets)).toBe(true);
  });

  it('resizes within the grid and clamps out-of-range values', () => {
    const next = resizeWidget(L(w('a', 8, 0, 4, 2)), 'a', 20, 0);
    expect(next.widgets[0]).toMatchObject({ w: 12, h: 1, x: 0 });
  });

  it('adds at the bottom with a unique id, and removes', () => {
    let l = L(w('note', 0, 0, 12, 3));
    l = addWidget(l, { type: 'note', w: 4, h: 2 });
    expect(l.widgets.map((x) => x.id)).toEqual(['note', 'note-2']);
    expect(l.widgets[1]).toMatchObject({ y: 3 });
    expect(removeWidget(l, 'note').widgets).toEqual([{ id: 'note-2', type: 'note', x: 0, y: 0, w: 4, h: 2 }]);
  });

  it('never overlaps after random moves', () => {
    let l = L(w('a', 0, 0, 4, 2), w('b', 4, 0, 4, 3), w('c', 8, 0, 4, 1), w('d', 0, 2, 12, 2));
    const moves: Array<[string, number, number]> = [['a', 6, 1], ['d', 3, 0], ['c', 0, 0], ['b', 9, 4], ['a', 0, 0]];
    for (const [id, x, y] of moves) {
      l = moveWidget(l, id, x, y);
      expect(noOverlap(l.widgets)).toBe(true);
      expect(l.widgets.every((x) => x.x + x.w <= 12)).toBe(true);
    }
  });

  it('maps a pointer offset to a grid cell', () => {
    expect(cellAt(250, 170, 1200, 80)).toEqual({ x: 2, y: 2 });
    expect(cellAt(-5, -5, 1200, 80)).toEqual({ x: 0, y: 0 });
  });
});
