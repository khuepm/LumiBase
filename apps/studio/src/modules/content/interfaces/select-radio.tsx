import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface Choice {
  value: string;
  text?: string;
}

interface SelectRadioOptions {
  choices?: Choice[];
}

/**
 * `select-radio` — single-choice radio group bound to `meta.options.choices`.
 * Stores the selected value as a `string`.
 */
export const SelectRadioInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SelectRadioOptions>(field);
  const choices = opts.choices ?? [];

  if (choices.length === 0) {
    return <p className="text-xs text-muted-foreground">No choices configured.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {choices.map((c) => {
        const active = value === c.value;
        return (
          <label
            key={c.value}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/40',
              active && 'border-primary bg-primary/5',
            )}
          >
            <input
              type="radio"
              name={field.name}
              checked={active}
              disabled={disabled}
              onChange={() => onChange(c.value)}
            />
            {c.text ?? c.value}
          </label>
        );
      })}
    </div>
  );
};
