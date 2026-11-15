import { Link2 } from 'lucide-react';
import { readOptions, type InterfaceComponent } from './types';

interface SlugOptions {
  placeholder?: string;
  maxLength?: number;
}

/** Slugify helper: lowercased, ASCII-folded, dashes; safe for URLs. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** `slug` — URL-safe single-line text with auto-format on blur. */
export const SlugInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SlugOptions>(field);
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background ps-2 focus-within:ring-1 focus-within:ring-primary">
      <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
      <input
        type="text"
        value={value ?? ''}
        placeholder={opts.placeholder ?? 'my-slug'}
        maxLength={opts.maxLength ?? 80}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const cleaned = slugify(e.target.value);
          if (cleaned !== e.target.value) onChange(cleaned);
        }}
        className="flex-1 bg-transparent px-1 py-1 text-sm focus:outline-none disabled:opacity-50"
      />
    </div>
  );
};
