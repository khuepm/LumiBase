import { useMemo, useState } from 'react';
import { isRichTextDocument, richTextToHtml, type RichTextDocument } from '@lumibase/contracts/richtext';
import { JsonRawInterface } from './json-raw';
import type { InterfaceComponent } from './types';

/**
 * `richtext` — preview for a portable rich-text document (content migrated
 * with `lumibase migrate`, #728), plus the raw JSON editor behind a toggle.
 *
 * The full editor is epic #669 (R02); until then this shows what the content
 * looks like and keeps it editable as JSON. A localized field stores
 * `{ locale: document }` and gets a locale switcher.
 *
 * The HTML comes from `richTextToHtml`, which escapes every text node and
 * drops unsafe link schemes, so injecting it is safe for any stored document.
 */

type Value = RichTextDocument | Record<string, RichTextDocument>;

/** Split a value into `[locale, document]` pairs (`''` for a single document). */
export function richTextEntries(value: unknown): Array<[string, RichTextDocument]> {
  if (isRichTextDocument(value)) return [['', value]];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).filter((e): e is [string, RichTextDocument] => isRichTextDocument(e[1]));
  }
  return [];
}

export const RichTextInterface: InterfaceComponent<Value> = (props) => {
  const { value } = props;
  const [raw, setRaw] = useState(false);
  const entries = useMemo(() => richTextEntries(value), [value]);
  const [locale, setLocale] = useState<string | null>(null);
  const current = entries.find(([l]) => l === locale) ?? entries[0];
  const html = useMemo(() => (current ? richTextToHtml(current[1]) : ''), [current]);
  const invalid = value !== null && value !== undefined && entries.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {entries.length > 1 &&
          entries.map(([l]) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              className={`rounded border px-2 py-0.5 ${current?.[0] === l ? 'bg-accent' : ''}`}
            >
              {l}
            </button>
          ))}
        <button type="button" onClick={() => setRaw((v) => !v)} className="ml-auto text-primary hover:underline">
          {raw ? 'Preview' : 'Edit JSON'}
        </button>
      </div>
      {raw || invalid ? (
        <>
          {invalid && <p className="text-xs text-amber-700">Not a rich-text document; showing raw JSON.</p>}
          <JsonRawInterface {...(props as Parameters<typeof JsonRawInterface>[0])} />
        </>
      ) : current ? (
        <div
          data-testid="richtext-preview"
          className="prose prose-sm max-w-none rounded-md border bg-background p-3"
          // Safe: richTextToHtml escapes text and filters link schemes.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Empty.</p>
      )}
    </div>
  );
};
