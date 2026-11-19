import { Suspense, lazy, useMemo, useState } from 'react';
import {
  isRichTextDocument,
  readRichTextFieldOptions,
  richTextToHtml,
  type RichTextDocument,
} from '@lumibase/contracts/richtext';
import { contentDirProps } from '@/lib/text-direction';
import { JsonRawInterface } from './json-raw';
import { readOptions, type InterfaceComponent } from './types';

/**
 * `richtext` — block-based rich-text editor (epic #669) for `richtext`
 * fields, and for `json` fields holding portable rich text (content migrated
 * with `lumibase migrate`, #728).
 *
 * The TipTap editor is a lazy chunk (`@/components/richtext/rich-text-editor`)
 * so it stays out of the Studio's initial bundle; until it loads, and for
 * read-only fields, the sanitised HTML preview is shown. A localized value
 * (`{ locale: document }`) gets a locale switcher; "Edit JSON" opens the raw
 * editor.
 *
 * The preview HTML comes from `richTextToHtml`, which escapes every text node,
 * drops unsafe URL schemes and ends with the allowlist sanitiser, so
 * injecting it is safe for any stored document.
 */

const RichTextEditor = lazy(() => import('@/components/richtext/rich-text-editor'));

type Value = RichTextDocument | Record<string, RichTextDocument>;
type Mode = 'edit' | 'preview' | 'json';

/** Split a value into `[locale, document]` pairs (`''` for a single document). */
export function richTextEntries(value: unknown): Array<[string, RichTextDocument]> {
  if (isRichTextDocument(value)) return [['', value]];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).filter((e): e is [string, RichTextDocument] => isRichTextDocument(e[1]));
  }
  return [];
}

function isLocaleMap(value: unknown): value is Record<string, RichTextDocument> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !isRichTextDocument(value) && richTextEntries(value).length > 0;
}

function Preview({ doc }: { doc: RichTextDocument }) {
  const html = useMemo(() => richTextToHtml(doc), [doc]);
  return (
    <div
      data-testid="richtext-preview"
      className="prose prose-sm max-w-none rounded-md border bg-background p-3"
      // Safe: richTextToHtml escapes text, filters URL schemes and sanitises the result.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const RichTextInterface: InterfaceComponent<Value> = (props) => {
  const { value, field, disabled, onChange, locale: contentLocale } = props;
  const options = useMemo(() => readRichTextFieldOptions(readOptions<unknown>(field)), [field]);
  const [mode, setMode] = useState<Mode>(disabled ? 'preview' : 'edit');
  const entries = useMemo(() => richTextEntries(value), [value]);
  const [locale, setLocale] = useState<string | null>(null);
  const current = entries.find(([l]) => l === locale) ?? entries[0];
  const localized = isLocaleMap(value);
  const invalid = value !== null && value !== undefined && entries.length === 0;
  const dirProps = contentDirProps(localized ? current?.[0] : contentLocale);
  const label = (field as { label?: string | null }).label ?? field.name;

  const write = (next: RichTextDocument | null) => {
    if (localized && current) {
      const map = { ...(value as Record<string, RichTextDocument>) };
      if (next) map[current[0]] = next;
      else delete map[current[0]];
      onChange(Object.keys(map).length ? map : null);
    } else {
      onChange(next);
    }
  };

  const modes: Array<[Mode, string]> = disabled
    ? [['preview', 'Preview'], ['json', 'JSON']]
    : [['edit', 'Edit'], ['preview', 'Preview'], ['json', 'Edit JSON']];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {entries.length > 1 &&
          entries.map(([l]) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              aria-pressed={current?.[0] === l}
              className={`rounded border px-2 py-0.5 ${current?.[0] === l ? 'bg-accent' : ''}`}
            >
              {l}
            </button>
          ))}
        <div className="ms-auto flex gap-2" role="group" aria-label="View">
          {modes.map(([m, text]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={mode === m ? 'font-medium text-foreground' : 'text-primary hover:underline'}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {mode === 'json' || invalid ? (
        <>
          {invalid && <p className="text-xs text-amber-700">Not a rich-text document; showing raw JSON.</p>}
          <JsonRawInterface {...(props as Parameters<typeof JsonRawInterface>[0])} />
        </>
      ) : mode === 'preview' || disabled ? (
        current ? <Preview doc={current[1]} /> : <p className="text-sm text-muted-foreground">Empty.</p>
      ) : (
        <Suspense fallback={current ? <Preview doc={current[1]} /> : <p className="text-sm text-muted-foreground">Loading editor…</p>}>
          <RichTextEditor
            key={current?.[0] ?? ''}
            value={current?.[1] ?? null}
            onChange={write}
            options={options}
            label={label}
            locale={localized ? current?.[0] : contentLocale}
            dir={dirProps.dir}
          />
        </Suspense>
      )}
    </div>
  );
};
