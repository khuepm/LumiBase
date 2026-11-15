import { useEffect, useMemo, useRef, useState } from 'react';

interface FieldOption {
  name: string;
  /** Optional secondary label (type/interface) shown to the right. */
  hint?: string;
}

interface MustacheTemplateEditorProps {
  /** Current template, e.g. `"{{title}} ({{slug}})"`. */
  value: string;
  onChange: (next: string) => void;
  /** Field names available for autocomplete. Hints (type) optional. */
  fields: FieldOption[];
  /**
   * Sample row used to render the live preview. Keys should match the
   * `fields` `name` values. Falls back to the field name in `[brackets]`
   * when a key is missing so the author can still see structure.
   */
  sample?: Record<string, unknown>;
  /** Multi-line textarea height in rows. Defaults to 3. */
  rows?: number;
  placeholder?: string;
}

const TOKEN_RE = /\{\{\s*([\w.-]*)$/;

/**
 * Mustache template editor — Phase B FE.
 *
 * Three-pane component:
 * 1. Textarea where the author types `{{field}}` placeholders.
 * 2. Inline autocomplete: typing `{{` opens a popover listing the
 *    collection's fields, filtered as the author types more characters
 *    after the opening braces.
 * 3. Live preview interpolating the same template against `sample` so
 *    authors can immediately verify formatting.
 *
 * Keeps the renderer in sync with `displays/mustache.tsx` (same regex,
 * same dotted-path resolution) so what you preview is what list cells
 * render at runtime.
 */
export function MustacheTemplateEditor({
  value,
  onChange,
  fields,
  sample,
  rows = 3,
  placeholder = '{{title}} \u2014 {{slug}}',
}: MustacheTemplateEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number>(value.length);
  const [hoverIndex, setHoverIndex] = useState(0);

  /** What the user has typed *after* the most recent unmatched `{{`. */
  const tokenContext = useMemo(() => {
    const upto = value.slice(0, caret);
    const match = upto.match(TOKEN_RE);
    if (!match) return null;
    const query = match[1] ?? '';
    return { query, start: caret - query.length };
  }, [value, caret]);

  const suggestions = useMemo(() => {
    if (!tokenContext) return [];
    const q = tokenContext.query.toLowerCase();
    return fields
      .filter((f: FieldOption) => f.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [tokenContext, fields]);

  // Reset hover when suggestion list shape changes.
  useEffect(() => {
    setHoverIndex(0);
  }, [suggestions.length, tokenContext?.query]);

  const insertSuggestion = (name: string) => {
    if (!tokenContext) return;
    const before = value.slice(0, tokenContext.start);
    const after = value.slice(caret);
    const next = `${before}${name}}}${after}`;
    onChange(next);
    // Restore focus + caret after the closing braces on next paint.
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = before.length + name.length + 2;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHoverIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHoverIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const pick = suggestions[hoverIndex];
      if (pick) insertSuggestion(pick.name);
    } else if (e.key === 'Escape') {
      // Closes the popover by moving caret out of the token context.
      setCaret(value.length);
    }
  };

  const preview = useMemo(() => renderTemplate(value, sample ?? {}), [value, sample]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTimeout(() => setCaret(-1), 100)}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
        />
        {suggestions.length > 0 && (
          <ul className="absolute start-2 top-full z-20 mt-1 max-h-56 w-72 overflow-auto rounded-md border bg-popover text-xs shadow-md">
            {suggestions.map((s, i) => (
              <li key={s.name}>
                <button
                  type="button"
                  // Use mousedown to fire before the textarea blur handler.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertSuggestion(s.name);
                  }}
                  onMouseEnter={() => setHoverIndex(i)}
                  className={`flex w-full items-center justify-between px-2 py-1 text-start ${i === hoverIndex ? 'bg-accent' : 'hover:bg-accent/60'
                    }`}
                >
                  <span className="font-mono">{s.name}</span>
                  {s.hint && <span className="text-muted-foreground">{s.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
        <p className="mb-1 text-[10px] uppercase text-muted-foreground">Live preview</p>
        <p className="break-words">
          {preview ? preview : <span className="text-muted-foreground italic">empty</span>}
        </p>
      </div>
    </div>
  );
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Mirrors `displays/mustache.tsx` exactly so the editor preview matches
 * runtime rendering. Missing values become an empty string.
 */
function renderTemplate(template: string, source: Record<string, unknown>): string {
  if (!template) return '';
  return template.replace(PLACEHOLDER, (_m, path) => {
    const v = resolvePath(source, path);
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}
