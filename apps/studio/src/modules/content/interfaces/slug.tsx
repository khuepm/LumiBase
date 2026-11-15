import { Link2 } from 'lucide-react';
import { checkSlug, slugify, type SlugPolicy } from '@lumibase/contracts/field';
import { readOptions, type InterfaceComponent } from './types';

interface SlugOptions {
  placeholder?: string;
  maxLength?: number;
  /** #751 — charset policy; without it the Studio formats as ASCII and the API does not enforce. */
  slug?: SlugPolicy;
}

const DEFAULT_MAX = 80;

/**
 * `slug` — URL-safe single-line text with auto-format on blur, using the
 * shared `slugify` (the same policy the API enforces when `options.slug` is
 * set). Vietnamese diacritics transliterate under `ascii`
 * ("Tiếng Việt" → "tieng-viet").
 */
export const SlugInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SlugOptions>(field);
  const maxLength = opts.maxLength ?? DEFAULT_MAX;
  const current = value ?? '';
  const problem = opts.slug && current !== '' ? checkSlug(current, opts.slug) : null;
  return (
    <div>
      <div className="flex items-center gap-1 rounded-md border bg-background pl-2 focus-within:ring-1 focus-within:ring-primary">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          value={current}
          placeholder={opts.placeholder ?? 'my-slug'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const cleaned = slugify(e.target.value, opts.slug, { maxLength });
            if (cleaned !== e.target.value) onChange(cleaned);
          }}
          className="flex-1 bg-transparent px-1 py-1 text-sm focus:outline-none disabled:opacity-50"
        />
      </div>
      {problem && (
        <p className="mt-0.5 text-[10px] text-destructive" role="alert">
          Slug {problem}.
        </p>
      )}
    </div>
  );
};
