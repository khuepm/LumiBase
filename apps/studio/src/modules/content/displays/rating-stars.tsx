import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { readDisplayOptions, type DisplayComponent } from './types';

interface RatingDisplayOptions {
  max?: number;
}

/** `rating-stars` — read-only star scale, default 1..5. */
export const RatingStarsDisplay: DisplayComponent<number> = ({ value, field }) => {
  const opts = readDisplayOptions<RatingDisplayOptions>(field);
  const max = opts.max ?? 5;
  const current = typeof value === 'number' ? value : 0;
  if (current === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span role="img" className="inline-flex items-center gap-0.5" aria-label={`${current} out of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          className={cn('h-3 w-3', i < current ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')}
        />
      ))}
    </span>
  );
};
