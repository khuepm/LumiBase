import { codePointLength } from '@lumibase/contracts/field';
import { readOptions, type InterfaceComponent } from './types';

interface TextOptions {
  placeholder?: string;
  /** #751 — Unicode code points; enforced by the API on every write. */
  minLength?: number;
  maxLength?: number;
}

/**
 * Length hint/counter for `minLength`/`maxLength`. Counts Unicode code points
 * like the server does — the native `maxLength` attribute counts UTF-16 units
 * and would block valid input (an emoji is two units), so it is not used.
 */
export function LengthHint({ value, opts }: { value: string; opts: TextOptions }) {
  const { minLength, maxLength } = opts;
  if (minLength === undefined && maxLength === undefined) return null;
  const len = codePointLength(value);
  const tooLong = maxLength !== undefined && len > maxLength;
  const tooShort = minLength !== undefined && value !== '' && len < minLength;
  return (
    <p
      className={`mt-0.5 text-right text-[10px] ${tooLong || tooShort ? 'text-destructive' : 'text-muted-foreground'}`}
      aria-live="polite"
    >
      {tooShort ? `Minimum ${minLength} · ` : ''}
      {maxLength !== undefined ? `${len} / ${maxLength}` : `${len}`}
    </p>
  );
}

/** `input` — single-line text. */
export const TextInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TextOptions>(field);
  return (
    <div>
      <input
        type="text"
        value={value ?? ''}
        placeholder={opts.placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
      <LengthHint value={value ?? ''} opts={opts} />
    </div>
  );
};

/** `input-multiline` — textarea. */
export const TextMultilineInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TextOptions & { rows?: number }>(field);
  return (
    <div>
      <textarea
        value={value ?? ''}
        placeholder={opts.placeholder}
        rows={opts.rows ?? 4}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
      <LengthHint value={value ?? ''} opts={opts} />
    </div>
  );
};
