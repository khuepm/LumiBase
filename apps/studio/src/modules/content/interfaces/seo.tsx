import { readOptions, type InterfaceComponent } from './types';

interface SeoValue {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndex?: boolean;
  noFollow?: boolean;
}

interface SeoOptions {
  titleMaxLength?: number;
  descriptionMaxLength?: number;
}

export const SeoInterface: InterfaceComponent<SeoValue> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<SeoOptions>(field);
  const current = value ?? {};

  const update = (key: keyof SeoValue, next: string | boolean) => {
    onChange({ ...current, [key]: next });
  };

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <BoundedInput
        label="SEO title"
        value={current.title ?? ''}
        maxLength={opts.titleMaxLength ?? 70}
        disabled={disabled}
        onChange={(next) => update('title', next)}
      />
      <BoundedTextarea
        label="Meta description"
        value={current.description ?? ''}
        maxLength={opts.descriptionMaxLength ?? 160}
        disabled={disabled}
        onChange={(next) => update('description', next)}
      />
      <TextInput
        label="Canonical URL"
        value={current.canonical ?? ''}
        disabled={disabled}
        onChange={(next) => update('canonical', next)}
      />
      <TextInput
        label="Social image"
        value={current.image ?? ''}
        disabled={disabled}
        onChange={(next) => update('image', next)}
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={current.noIndex ?? false}
            disabled={disabled}
            onChange={(event) => update('noIndex', event.target.checked)}
          />
          No index
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={current.noFollow ?? false}
            disabled={disabled}
            onChange={(event) => update('noFollow', event.target.checked)}
          />
          No follow
        </label>
      </div>
    </div>
  );
};

function TextInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
    </label>
  );
}

function BoundedInput({
  label,
  value,
  maxLength,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs font-medium">
        {label}
        <span className="font-normal text-muted-foreground">
          {value.length}/{maxLength}
        </span>
      </span>
      <input
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
    </label>
  );
}

function BoundedTextarea({
  label,
  value,
  maxLength,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs font-medium">
        {label}
        <span className="font-normal text-muted-foreground">
          {value.length}/{maxLength}
        </span>
      </span>
      <textarea
        value={value}
        maxLength={maxLength}
        rows={3}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
    </label>
  );
}
