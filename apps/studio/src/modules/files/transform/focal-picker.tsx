import { useRef } from 'react';

/**
 * Focal-point picker (image-transform-dsl Req 5.4). Click anywhere on the
 * preview image to set a normalized focal point `{ x, y }` in [0,1]; a crosshair
 * marks the current point. The focal point drives crop framing for `fit=cover`.
 */

export interface FocalPickerProps {
  src: string;
  focal?: { x: number; y: number };
  onChange: (focal: { x: number; y: number }) => void;
}

export function FocalPicker({ src, focal, onChange }: FocalPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onChange({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  };

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label="Set focal point"
      onClick={handleClick}
      className="relative inline-block cursor-crosshair overflow-hidden rounded-md border"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Focal preview" className="block max-h-64 max-w-full" />
      {focal && (
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary/70 shadow"
          style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
          data-testid="focal-marker"
        />
      )}
    </div>
  );
}
