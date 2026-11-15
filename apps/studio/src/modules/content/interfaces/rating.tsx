import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface RatingOptions {
  max?: number;
  allowClear?: boolean;
}

/** `rating` — clickable star scale, default 1..5. */
export const RatingInterface: InterfaceComponent<number> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<RatingOptions>(field);
  const max = opts.max ?? 5;
  const current = typeof value === 'number' ? value : 0;
  return (
    <div className="inline-flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => {
        const idx = i + 1;
        const filled = idx <= current;
        return (
          <button
            key={idx}
            type="button"
            disabled={disabled}
            aria-label={`Rate ${idx}`}
            onClick={() => onChange(opts.allowClear !== false && current === idx ? null : idx)}
            className="rounded p-0.5 hover:bg-accent disabled:opacity-50"
          >
            <Star
              className={cn(
                'h-4 w-4',
                filled ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
              )}
            />
          </button>
        );
      })}
      {current > 0 && (
        <span className="ms-2 text-xs text-muted-foreground">{current}/{max}</span>
      )}
    </div>
  );
};
