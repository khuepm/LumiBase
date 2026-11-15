import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FieldResource } from '@lumibase/sdk';
import { cn } from '@/lib/cn';
import { resolveInterface } from './registry';
import { readOptions, type InterfaceComponent } from './types';

interface RepeaterOptions {
  /** Sub-field definitions; each item is a partial FieldResource. */
  fields?: FieldResource[];
  /** Optional label expression, e.g. `'{title}'`; falls back to `Item N`. */
  labelTemplate?: string;
  addLabel?: string;
}

type Row = Record<string, unknown>;

/**
 * `repeater` — array-of-objects editor with reorder + add/remove.
 *
 * Each row is rendered via the registry recursively so any interface (text,
 * relation, even nested repeaters) can be embedded. The component lives in
 * its own file rather than registry.tsx to break the import cycle.
 */
export const RepeaterInterface: InterfaceComponent<Row[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<RepeaterOptions>(field);
  const subFields = opts.fields ?? [];
  const rows: Row[] = Array.isArray(value) ? value : [];
  const [openIdx, setOpenIdx] = useState<number | null>(rows.length ? 0 : null);

  if (subFields.length === 0) {
    return (
      <p className="text-xs text-destructive">
        Missing `meta.options.fields` for repeater field.
      </p>
    );
  }

  const update = (idx: number, row: Row) => {
    onChange(rows.map((r, i) => (i === idx ? row : r)));
  };
  const remove = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    onChange(next);
    if (openIdx !== null && openIdx >= next.length) setOpenIdx(null);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const a = next[idx];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[idx] = b;
    next[target] = a;
    onChange(next);
    if (openIdx === idx) setOpenIdx(target);
  };
  const add = () => {
    onChange([...rows, {}]);
    setOpenIdx(rows.length);
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No entries yet.</p>
      )}
      {rows.map((row, idx) => (
        <RepeaterRow
          key={idx}
          row={row}
          idx={idx}
          total={rows.length}
          subFields={subFields}
          labelTemplate={opts.labelTemplate}
          open={openIdx === idx}
          disabled={disabled}
          onToggle={() => setOpenIdx(openIdx === idx ? null : idx)}
          onChange={(next) => update(idx, next)}
          onRemove={() => remove(idx)}
          onMove={(dir) => move(idx, dir)}
        />
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <Plus className="h-3 w-3" />
        {opts.addLabel ?? 'Add entry'}
      </button>
    </div>
  );
};

function RepeaterRow({
  row,
  idx,
  total,
  subFields,
  labelTemplate,
  open,
  disabled,
  onToggle,
  onChange,
  onRemove,
  onMove,
}: {
  row: Row;
  idx: number;
  total: number;
  subFields: FieldResource[];
  labelTemplate?: string;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onChange: (next: Row) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const title = labelTemplate
    ? labelTemplate.replace(/\{(\w+)\}/g, (_m, key) => String(row[key] ?? '')).trim() ||
    `Item ${idx + 1}`
    : `Item ${idx + 1}`;

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-start text-sm"
        >
          <span className={cn('text-xs font-mono text-muted-foreground')}>#{idx + 1}</span>
          <span className="truncate">{title}</span>
        </button>
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button
            type="button"
            disabled={idx === 0 || disabled}
            onClick={() => onMove(-1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"
            aria-label="Move up"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={idx === total - 1 || disabled}
            onClick={() => onMove(1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"
            aria-label="Move down"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            className="rounded p-1 hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
            aria-label="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {open && (
        <div className="space-y-3 border-t bg-muted/10 p-3">
          {subFields.map((sf) => {
            const Interface = resolveInterface(sf);
            return (
              <div key={sf.name}>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {sf.name}
                  {sf.required && <span className="ms-1 text-destructive">*</span>}
                  <span className="ms-2 text-[10px] uppercase">
                    {sf.interface || sf.type}
                  </span>
                </label>
                <Interface
                  field={sf}
                  value={row[sf.name]}
                  disabled={disabled}
                  onChange={(next) => onChange({ ...row, [sf.name]: next })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
