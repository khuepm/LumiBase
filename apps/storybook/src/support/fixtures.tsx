import type { FieldResource } from '@lumibase/sdk';
import { useState, type ReactNode } from 'react';

/** Minimal schema-engine field for Studio interface/display stories. */
export function makeField(overrides: Partial<FieldResource> & { name: string }): FieldResource {
  return {
    id: `fld_${overrides.name}`,
    collectionId: 'col_articles',
    type: 'string',
    interface: 'input',
    required: false,
    hidden: false,
    sortOrder: 0,
    ...overrides,
  };
}

/**
 * Label + control, the way the item form lays a field out. Studio's form
 * renders a visible label next to each interface; stories reproduce that so
 * the a11y scan judges the control in context instead of flagging a bare,
 * unlabeled input the real page never shows.
 */
export function FieldFrame({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="block max-w-md space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
    </label>
  );
}

/** Same as {@link FieldFrame} for interfaces that render several controls (radio groups). */
export function FieldGroupFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="max-w-md space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      {children}
    </fieldset>
  );
}

/** Keeps a controlled interface's value in story state so it is interactive. */
export function useStoryValue<T>(initial: T | null | undefined) {
  return useState<T | null | undefined>(initial);
}
