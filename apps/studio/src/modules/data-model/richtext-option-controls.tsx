import {
  RICHTEXT_BLOCK_FEATURES,
  RICHTEXT_MARKS,
  readRichTextFieldOptions,
  type RichTextBlockFeature,
  type RichTextMark,
} from '@lumibase/contracts/richtext';

/**
 * Structured editor for a `richtext` field's options (#696): which heading
 * levels, marks and blocks editors may use, links/references, custom block
 * names and a length limit. Writes the same `options` object as the raw JSON
 * textarea (unknown keys are preserved); the API enforces these on write.
 */

interface Props {
  options: Record<string, unknown>;
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
}

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

const BLOCK_LABEL: Record<RichTextBlockFeature, string> = {
  heading: 'Headings',
  quote: 'Quotes',
  list: 'Lists',
  code: 'Code blocks',
  rule: 'Dividers',
  table: 'Tables',
  embed: 'Images / file embeds',
  footnote: 'Footnotes',
  custom: 'Custom blocks',
};

function set(o: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = { ...o };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** Toggle `item` in a list option; "everything selected" is stored as no key at all. */
function toggle<T>(current: readonly T[] | undefined, all: readonly T[], item: T): T[] | undefined {
  const base = current ?? all;
  const next = base.includes(item) ? base.filter((x) => x !== item) : [...base, item];
  const ordered = all.filter((x) => next.includes(x));
  return ordered.length === all.length ? undefined : ordered;
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className="inline-flex items-center gap-1 text-xs">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

export function RichTextOptionControls({ options, disabled, onChange }: Props) {
  const o = readRichTextFieldOptions(options);
  const marks = o.marks ?? RICHTEXT_MARKS;
  const blocks = o.blocks ?? RICHTEXT_BLOCK_FEATURES;
  const levels = o.headingLevels ?? LEVELS;

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Rich text options">
      <h4 className="text-sm font-medium">Rich text editor</h4>

      <fieldset className="space-y-1">
        <legend className="text-xs font-medium">Blocks</legend>
        <div className="flex flex-wrap gap-3">
          {RICHTEXT_BLOCK_FEATURES.map((b) => (
            <Check
              key={b}
              label={BLOCK_LABEL[b]}
              checked={blocks.includes(b)}
              disabled={disabled}
              onChange={() => onChange(set(options, 'blocks', toggle(o.blocks, RICHTEXT_BLOCK_FEATURES, b)))}
            />
          ))}
        </div>
      </fieldset>

      {blocks.includes('heading') && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">Heading levels</legend>
          <div className="flex flex-wrap gap-3">
            {LEVELS.map((l) => (
              <Check
                key={l}
                label={`H${l}`}
                checked={levels.includes(l)}
                disabled={disabled}
                onChange={() => onChange(set(options, 'headingLevels', toggle(o.headingLevels, LEVELS, l)))}
              />
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="space-y-1">
        <legend className="text-xs font-medium">Marks</legend>
        <div className="flex flex-wrap gap-3">
          {RICHTEXT_MARKS.map((m: RichTextMark) => (
            <Check
              key={m}
              label={m}
              checked={marks.includes(m)}
              disabled={disabled}
              onChange={() => onChange(set(options, 'marks', toggle(o.marks, RICHTEXT_MARKS, m)))}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Check label="Links" checked={o.links !== false} disabled={disabled} onChange={() => onChange(set(options, 'links', o.links === false ? undefined : false))} />
        <Check
          label="Item / file references"
          checked={o.references !== false}
          disabled={disabled}
          onChange={() => onChange(set(options, 'references', o.references === false ? undefined : false))}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-xs">
          <span className="font-medium">Custom blocks (comma-separated)</span>
          <input
            aria-label="Allowed custom block names"
            value={(o.customBlocks ?? []).join(', ')}
            placeholder="any registered block"
            disabled={disabled}
            onChange={(e) => {
              const names = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
              onChange(set(options, 'customBlocks', names.length ? names : undefined));
            }}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-medium">Max length (characters)</span>
          <input
            type="number"
            min={1}
            aria-label="Rich text max length"
            value={o.maxLength ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(set(options, 'maxLength', e.target.value.trim() && Number.isInteger(n) && n > 0 ? n : undefined));
            }}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        The editor shows only what is enabled, and the API rejects content that uses anything else.
      </p>
    </section>
  );
}
