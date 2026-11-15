import { contentDirProps } from '@/lib/text-direction';
import { readOptions, type InterfaceComponent } from './types';

interface TextOptions {
  placeholder?: string;
  maxLength?: number;
}

/** `input` — single-line text. */
export const TextInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
  locale,
}) => {
  const opts = readOptions<TextOptions>(field);
  return (
    <input
      type="text"
      {...contentDirProps(locale)}
      value={value ?? ''}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};

/** `input-multiline` — textarea. */
export const TextMultilineInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
  locale,
}) => {
  const opts = readOptions<TextOptions & { rows?: number }>(field);
  return (
    <textarea
      {...contentDirProps(locale)}
      value={value ?? ''}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      rows={opts.rows ?? 4}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};
