import { useMemo } from 'react';
import { slugify, type SlugCharset, type SlugPolicy, type SlugSeparator } from '@lumibase/contracts/field';
import {
  SINGLE_CHOICE_INTERFACES,
  TEXT_LENGTH_FIELD_TYPES,
  validateFieldOptions,
  type FieldOptionIssue,
} from '@lumibase/contracts/schemas';

/**
 * #751 — structured editors for `options.allowClear`, `options.minLength` /
 * `options.maxLength` and `options.slug` in the field inspector. They edit the
 * same options object as the raw JSON textarea (unknown keys are preserved)
 * and surface the same Zod validation the server runs on schema write.
 */

export function fieldOptionIssues(input: {
  type: string;
  interface: string;
  options: Record<string, unknown>;
  length?: number | null;
}): FieldOptionIssue[] {
  return validateFieldOptions(input);
}

interface Props {
  type: string;
  iface: string;
  length?: number | null;
  options: Record<string, unknown>;
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
}

const withKey = (o: Record<string, unknown>, key: string, value: unknown) => {
  const next = { ...o };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

const numberOrUndefined = (raw: string): number | undefined => {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export function FieldOptionControls({ type, iface, length, options, disabled, onChange }: Props) {
  const isSingleChoice = (SINGLE_CHOICE_INTERFACES as readonly string[]).includes(iface);
  const isText = (TEXT_LENGTH_FIELD_TYPES as readonly string[]).includes(type);
  const isSlug = iface === 'slug';
  const issues = useMemo(
    () => fieldOptionIssues({ type, interface: iface, options, length }),
    [type, iface, options, length],
  );
  if (!isSingleChoice && !isText) return null;

  const slug = (options.slug && typeof options.slug === 'object' ? options.slug : undefined) as
    | Partial<SlugPolicy>
    | undefined;
  const setSlug = (patch: Partial<SlugPolicy> | undefined) => {
    if (patch === undefined) return onChange(withKey(options, 'slug', undefined));
    const merged: Record<string, unknown> = { ...(slug ?? { charset: 'ascii' }), ...patch };
    if (merged.charset !== 'custom') delete merged.pattern;
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    onChange(withKey(options, 'slug', merged));
  };
  const preview =
    slug && slug.charset ? slugify('Tiếng Việt — Đà Nẵng 2026', slug as SlugPolicy) : null;

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Field value options">
      <h4 className="text-sm font-medium">Value options</h4>

      {isSingleChoice && (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            aria-label="Allow clearing the selection"
            checked={options.allowClear !== false}
            disabled={disabled}
            onChange={(e) => onChange(withKey(options, 'allowClear', e.target.checked ? undefined : false))}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Allow clearing the selection</span>
            <span className="block text-[10px] text-muted-foreground">
              When off, editors cannot clear a value once it is set and the API rejects null or
              empty updates. Use “Required” to also forbid an empty value on create.
            </span>
          </span>
        </label>
      )}

      {isText && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Min length</span>
            <input
              type="number"
              min={0}
              aria-label="Min length"
              value={typeof options.minLength === 'number' ? options.minLength : ''}
              disabled={disabled}
              onChange={(e) => onChange(withKey(options, 'minLength', numberOrUndefined(e.target.value)))}
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Max length</span>
            <input
              type="number"
              min={1}
              aria-label="Max length"
              value={typeof options.maxLength === 'number' ? options.maxLength : ''}
              disabled={disabled}
              onChange={(e) => onChange(withKey(options, 'maxLength', numberOrUndefined(e.target.value)))}
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <p className="col-span-2 text-[10px] text-muted-foreground">
            Counted in Unicode code points (an emoji or “ệ” counts as one). Enforced by the API on
            every write.
          </p>
        </div>
      )}

      {isText && isSlug && (
        <div className="space-y-2">
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Slug charset</span>
            <select
              aria-label="Slug charset"
              value={slug?.charset ?? ''}
              disabled={disabled}
              onChange={(e) =>
                setSlug(e.target.value === '' ? undefined : { charset: e.target.value as SlugCharset })
              }
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value="">Default (Studio formats as ASCII, API does not enforce)</option>
              <option value="ascii">ASCII — transliterate (Tiếng Việt → tieng-viet)</option>
              <option value="unicode">Unicode — keep letters of every script</option>
              <option value="custom">Custom pattern</option>
            </select>
          </label>
          {slug?.charset && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium">Separator</span>
                <select
                  aria-label="Slug separator"
                  value={slug.separator ?? '-'}
                  disabled={disabled}
                  onChange={(e) => setSlug({ separator: e.target.value as SlugSeparator })}
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="-">-</option>
                  <option value="_">_</option>
                  <option value=".">.</option>
                </select>
              </label>
              <label className="flex items-end gap-2 pb-1 text-xs">
                <input
                  type="checkbox"
                  aria-label="Lowercase slug"
                  checked={slug.lowercase !== false}
                  disabled={disabled}
                  onChange={(e) => setSlug({ lowercase: e.target.checked ? undefined : false })}
                />
                <span className="font-medium">Lowercase</span>
              </label>
            </div>
          )}
          {slug?.charset === 'custom' && (
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Pattern</span>
              <input
                type="text"
                aria-label="Slug pattern"
                value={typeof slug.pattern === 'string' ? slug.pattern : ''}
                placeholder="^[a-z]{2}/[a-z0-9-]+$"
                disabled={disabled}
                onChange={(e) => setSlug({ pattern: e.target.value || undefined })}
                className="w-full rounded-md border bg-background px-2 py-1 font-mono text-sm"
              />
              <span className="block text-[10px] text-muted-foreground">
                Characters, classes like [a-z] or \p{'{'}L{'}'}, and quantifiers (* + ? {'{n,m}'}).
                Groups, alternation and backreferences are rejected so matching stays linear-time.
              </span>
            </label>
          )}
          {preview !== null && (
            <p className="text-[10px] text-muted-foreground" data-testid="slug-preview">
              Preview: <code>{preview}</code>
            </p>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" role="alert">
          {issues.map((i) => (
            <li key={`${i.path}:${i.message}`}>
              {i.path}: {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
