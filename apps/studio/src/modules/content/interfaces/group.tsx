import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { readOptions } from './types';
import type { FieldResource } from '@lumibase/sdk';

export type GroupVariant = 'raw' | 'detail' | 'accordion';

interface GroupOptions {
  title?: string;
  /** Accordion only: whether it starts open. */
  start?: 'open' | 'closed';
}

/**
 * Presentational container for the group interfaces (`group-raw`,
 * `group-detail`, `group-accordion`). The grouping *logic* (which child fields
 * belong to which group) lives in the item-detail FieldsTab; this component
 * only renders the chrome around the already-resolved children.
 */
export function GroupContainer({
  variant,
  field,
  children,
}: {
  variant: GroupVariant;
  field: FieldResource;
  children: ReactNode;
}) {
  const opts = readOptions<GroupOptions>(field);
  const title = opts.title || field.label || field.name;
  const [open, setOpen] = useState(opts.start !== 'closed');

  if (variant === 'raw') {
    return <div className="space-y-4">{children}</div>;
  }

  if (variant === 'accordion') {
    return (
      <div className="rounded-lg border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
        </button>
        {open && <div className="space-y-4 border-t p-3">{children}</div>}
      </div>
    );
  }

  // detail
  return (
    <fieldset className="rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold uppercase text-muted-foreground">{title}</legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}
