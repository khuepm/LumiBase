import { readOptions, type InterfaceComponent } from './types';

interface AioValue {
  summary?: string;
  prompt?: string;
  tone?: string;
  entities?: string[];
  questions?: string[];
}

interface AioOptions {
  summaryMaxLength?: number;
  tones?: string[];
}

export const AioInterface: InterfaceComponent<AioValue> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<AioOptions>(field);
  const current = value ?? {};
  const tones = opts.tones?.length ? opts.tones : ['neutral', 'expert', 'friendly'];

  const update = (key: keyof AioValue, next: string | string[]) => {
    onChange({ ...current, [key]: next });
  };

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <label className="block">
        <span className="mb-1 flex items-center justify-between text-xs font-medium">
          Answer summary
          <span className="font-normal text-muted-foreground">
            {(current.summary ?? '').length}/{opts.summaryMaxLength ?? 300}
          </span>
        </span>
        <textarea
          value={current.summary ?? ''}
          maxLength={opts.summaryMaxLength ?? 300}
          rows={3}
          disabled={disabled}
          onChange={(event) => update('summary', event.target.value)}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium">AI prompt</span>
        <textarea
          value={current.prompt ?? ''}
          rows={4}
          disabled={disabled}
          onChange={(event) => update('prompt', event.target.value)}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium">Tone</span>
        <select
          value={current.tone ?? tones[0]}
          disabled={disabled}
          onChange={(event) => update('tone', event.target.value)}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {tones.map((tone) => (
            <option key={tone} value={tone}>
              {tone}
            </option>
          ))}
        </select>
      </label>

      <TokenInput
        label="Entities"
        value={current.entities ?? []}
        disabled={disabled}
        onChange={(next) => update('entities', next)}
      />
      <TokenInput
        label="Questions"
        value={current.questions ?? []}
        disabled={disabled}
        onChange={(next) => update('questions', next)}
      />
    </div>
  );
};

function TokenInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      <input
        value={value.join(', ')}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
    </label>
  );
}
