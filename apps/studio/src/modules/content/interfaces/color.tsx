import type { InterfaceComponent } from './types';

const HEX_RE = /^#?[0-9a-fA-F]{3,8}$/;

/** `color` — native swatch + hex input synced together. */
export const ColorInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const hex = normalize(value ?? '#000000');
  // Two controls for one field: each needs its own accessible name.
  const label = typeof field.label === 'string' && field.label ? field.label : field.name;
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${label} picker`}
        value={hex}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-10 cursor-pointer rounded-md border bg-background disabled:opacity-50"
      />
      <input
        type="text"
        aria-label={`${label} hex value`}
        value={value ?? ''}
        disabled={disabled}
        placeholder="#000000"
        onChange={(e) => {
          const v = e.target.value;
          if (v === '' || HEX_RE.test(v)) onChange(v === '' ? null : v);
        }}
        className="w-28 rounded-md border bg-background px-2 py-1 font-mono text-xs disabled:opacity-50"
      />
    </div>
  );
};

function normalize(raw: string): string {
  if (!raw) return '#000000';
  if (raw.startsWith('#') && raw.length === 7) return raw;
  if (raw.startsWith('#') && raw.length === 4) {
    return '#' + raw.slice(1).split('').map((c) => c + c).join('');
  }
  return '#000000';
}
