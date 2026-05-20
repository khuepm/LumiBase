/**
 * Cursor overlay — POST-GA2.
 *
 * Renders remote peer cursors over a text editor. Positions are computed
 * by mapping character offsets to client coordinates via a
 * `getClientRectForOffset(offset)` callback the host editor must provide
 * (works for textarea, codemirror, and Monaco — each exposes the same
 * primitive under different names).
 */

import { useEffect, useRef, useState } from 'react';
import type { PeerCursor } from '../hooks/use-cursor';

export interface CursorOverlayProps {
  peers: PeerCursor[];
  /** Container element used as a coordinate origin. */
  containerRef: React.RefObject<HTMLElement>;
  /** Host editor callback: convert a char offset to a {x, y, h} rect. */
  getRectForOffset: (offset: number) => { x: number; y: number; h: number } | null;
}

interface RenderedCursor {
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  h: number;
}

export function CursorOverlay({ peers, containerRef, getRectForOffset }: CursorOverlayProps) {
  const [rendered, setRendered] = useState<RenderedCursor[]>([]);
  const rafRef = useRef<number>();

  // Recompute positions on every peers change & on container resize.
  useEffect(() => {
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      const next: RenderedCursor[] = [];
      for (const peer of peers) {
        const rect = getRectForOffset(peer.head);
        if (!rect) continue;
        next.push({
          userId: peer.userId,
          name: peer.name,
          color: peer.color,
          x: rect.x,
          y: rect.y,
          h: rect.h,
        });
      }
      setRendered(next);
    });

    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [peers, getRectForOffset]);

  if (!containerRef.current || rendered.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {rendered.map((c) => (
        <div
          key={c.userId}
          className="absolute"
          style={{
            transform: `translate(${c.x}px, ${c.y}px)`,
            height: c.h,
          }}
        >
          {/* Caret bar */}
          <span
            className="block w-[2px]"
            style={{ height: c.h, backgroundColor: c.color }}
          />
          {/* Name label */}
          <span
            className="absolute -top-5 left-0 whitespace-nowrap rounded-sm px-1 py-0.5 text-[10px] font-medium text-white shadow-sm"
            style={{ backgroundColor: c.color }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </div>
  );
}
