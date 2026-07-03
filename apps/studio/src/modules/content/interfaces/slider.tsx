import { readOptions, type InterfaceComponent } from './types';

interface SliderOptions {
  min?: number;
  max?: number;
  step?: number;
}

/**
 * `slider` — range input for numeric values. Reads `min`/`max`/`step` from
 * `meta.options` and stores a `number`.
 */
export const SliderInterface: InterfaceComponent<number> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SliderOptions>(field);
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const step = opts.step ?? 1;
  const current = typeof value === 'number' ? value : min;

  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer accent-primary disabled:opacity-50"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="w-20 rounded-md border bg-background px-2 py-1 text-right text-sm disabled:opacity-50"
      />
    </div>
  );
};
