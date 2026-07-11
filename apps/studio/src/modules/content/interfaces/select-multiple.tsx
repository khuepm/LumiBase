import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface Choice {
  value: string;
  text?: string;
}

interface SelectMultipleOptions {
  choices?: Choice[];
  allowOther?: boolean;
  placeholder?: string;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * `select-multiple-dropdown` — multi-choice popover bound to
 * `meta.options.choices`. Stores the selected values as `string[]`.
 */
export const SelectMultipleDropdown: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SelectMultipleOptions>(field);
  const choices = opts.choices ?? [];
  const selected = asArray(value);
  const [open, setOpen] = useState(false);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };

  const labelFor = (val: string) => choices.find((c) => c.value === val)?.text ?? val;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      >
        <span className={cn('flex flex-wrap gap-1', selected.length === 0 && 'text-muted-foreground')}>
          {selected.length === 0
            ? opts.placeholder ?? '— select —'
            : selected.map((v) => (
                <span key={v} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {labelFor(v)}
                </span>
              ))}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-lg">
          <ul className="max-h-60 overflow-y-auto py-1">
            {choices.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No choices configured.</li>
            )}
            {choices.map((c) => {
              const active = selected.includes(c.value);
              return (
                <li key={c.value}>
                  <button
                    type="button"
                    onClick={() => toggle(c.value)}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded border',
                        active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      )}
                    >
                      {active && <Check className="h-2.5 w-2.5" />}
                    </span>
                    {c.text ?? c.value}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

/**
 * `select-multiple-checkbox` — flat checkbox list bound to
 * `meta.options.choices`. Stores selected values as `string[]`.
 */
export const SelectMultipleCheckbox: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SelectMultipleOptions>(field);
  const choices = opts.choices ?? [];
  const selected = asArray(value);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };

  if (choices.length === 0) {
    return <p className="text-xs text-muted-foreground">No choices configured.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {choices.map((c) => {
        const active = selected.includes(c.value);
        return (
          <label
            key={c.value}
            className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/40"
          >
            <input
              type="checkbox"
              checked={active}
              disabled={disabled}
              onChange={() => toggle(c.value)}
            />
            {c.text ?? c.value}
          </label>
        );
      })}
    </div>
  );
};
