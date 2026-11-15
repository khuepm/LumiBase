/**
 * Field focus + locale selection for intent links (issue #759).
 *
 * An intent such as `/intent/edit?collection=posts&id=p1&locale=vi&field=title`
 * lands on the item editor with `?locale=vi&field=title`. This module turns
 * those two hints into editor state:
 *
 *  - {@link planIntentLocale} picks the editor tab / target locale, respecting
 *    which locales the site enables and which fields are translatable.
 *  - {@link useIntentFieldFocus} reveals the field's containers (collapsed
 *    accordion groups today; form-layout tabs once they land — see below),
 *    scrolls the field into view and focuses its editor.
 *
 * Containers opt into reveal through {@link useRevealContainer}. A container
 * is keyed by the name of the field that owns it (`group-*` interfaces use
 * their own field name). A future layout container (e.g. the form-layout tabs
 * of #826) can either register under its own key — passing it to
 * `fieldContainerChain` via `extraParents` — or read {@link useFieldReveal}
 * and open itself when `target` is one of its fields.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldResource } from '@lumibase/sdk';

// ─── Reveal context ─────────────────────────────────────────────────────────

export interface FieldRevealState {
  /** Field the intent asked to focus, or null. */
  target: string | null;
  /** Container keys (outermost first) that must be open to show `target`. */
  containers: ReadonlySet<string>;
}

const EMPTY: FieldRevealState = { target: null, containers: new Set() };

export const FieldRevealContext = createContext<FieldRevealState>(EMPTY);

export function useFieldReveal(): FieldRevealState {
  return useContext(FieldRevealContext);
}

/** True when the container keyed `key` must be open for the focus target. */
export function useRevealContainer(key: string): boolean {
  return useContext(FieldRevealContext).containers.has(key);
}

/**
 * Group-container chain (outermost first) that holds `name`, or `null` when
 * the field is not in `fields`. `extraParents` lets a layout (tabs) add
 * container keys that are not fields.
 */
export function fieldContainerChain(
  fields: readonly Pick<FieldResource, 'name' | 'group'>[],
  name: string,
  extraParents: (fieldName: string) => string | null | undefined = () => null,
): string[] | null {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const field = byName.get(name);
  if (!field) return null;
  const chain: string[] = [];
  const seen = new Set<string>([name]);
  let current: string | null | undefined = field.group ?? extraParents(name);
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    const parent = byName.get(current);
    current = parent?.group ?? extraParents(current);
  }
  return chain;
}

// ─── Locale planning ───────────────────────────────────────────────────────

export type LocaleNotice = 'locale_unavailable' | 'no_translatable_fields' | 'field_not_translatable';

export interface LocalePlan {
  tab: 'fields' | 'translation';
  targetLocale?: string;
  notice?: LocaleNotice;
}

function normalizeLocale(locale: string): string {
  return locale.replace(/_/g, '-').toLowerCase();
}

/**
 * Where a requested locale should land. The source (first) locale is edited
 * on the Fields tab; any other enabled locale opens Translation mode with that
 * target — unless nothing is translatable, or the focused field is not, in
 * which case the Fields tab opens with a notice instead of a silent drop.
 */
export function planIntentLocale(input: {
  requested: string | undefined;
  locales: readonly string[];
  translatable: readonly string[];
  field?: string;
}): LocalePlan | null {
  const { requested, locales, translatable, field } = input;
  if (!requested) return null;
  const match = locales.find((l) => normalizeLocale(l) === normalizeLocale(requested));
  if (!match) return { tab: 'fields', notice: 'locale_unavailable' };
  if (match === locales[0]) return { tab: 'fields' };
  if (translatable.length === 0) return { tab: 'fields', notice: 'no_translatable_fields' };
  if (field && !translatable.includes(field)) return { tab: 'fields', notice: 'field_not_translatable' };
  return { tab: 'translation', targetLocale: match };
}

export function localeNoticeMessage(notice: LocaleNotice, locale: string): string {
  switch (notice) {
    case 'locale_unavailable':
      return `The link asked for locale “${locale}”, which this site does not enable. Showing the default locale.`;
    case 'no_translatable_fields':
      return `This collection has no translatable fields, so there is no “${locale}” version. Showing the default locale.`;
    case 'field_not_translatable':
      return `The linked field is not translatable, so it has no “${locale}” version. Showing it in the default locale.`;
  }
}

// ─── DOM focus ─────────────────────────────────────────────────────────────

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function anchorFor(root: ParentNode, name: string): HTMLElement | null {
  const anchors = root.querySelectorAll<HTMLElement>('[data-field-anchor]');
  for (const el of Array.from(anchors)) {
    if (el.dataset.fieldAnchor === name) return el;
  }
  return null;
}

/**
 * Scroll the field's anchor into view and focus its editor. Prefers an
 * element marked `data-field-focus` (e.g. the target textarea in Translation
 * mode), then the first focusable control, then the anchor itself.
 */
export function focusFieldElement(root: ParentNode, name: string): boolean {
  const anchor = anchorFor(root, name);
  if (!anchor) return false;
  if (typeof anchor.scrollIntoView === 'function') {
    anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const preferred = anchor.querySelector<HTMLElement>('[data-field-focus]');
  const control = preferred ?? anchor.querySelector<HTMLElement>(FOCUSABLE);
  if (control) {
    control.focus({ preventScroll: true });
  } else {
    if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1');
    anchor.focus({ preventScroll: true });
  }
  anchor.setAttribute('data-field-focused', 'true');
  return true;
}

export type FieldFocusStatus = 'idle' | 'pending' | 'focused' | 'missing';

/**
 * Drives the focus once the editor is ready. `fields` is the list the user can
 * actually see (hidden / unreadable fields are already filtered out) — a field
 * outside it reports `missing` so the editor can say so instead of failing
 * silently. Interfaces load lazily, so the DOM is polled for a short while.
 */
export function useIntentFieldFocus(input: {
  field: string | undefined;
  fields: readonly Pick<FieldResource, 'name' | 'group'>[];
  ready: boolean;
  attempts?: number;
  intervalMs?: number;
}): { status: FieldFocusStatus; reveal: FieldRevealState } {
  const { field, fields, ready, attempts = 40, intervalMs = 50 } = input;
  const chain = useMemo(
    () => (field ? fieldContainerChain(fields, field) : null),
    [field, fields],
  );
  const reveal = useMemo<FieldRevealState>(
    () => (field && chain ? { target: field, containers: new Set(chain) } : EMPTY),
    [field, chain],
  );
  const [status, setStatus] = useState<FieldFocusStatus>(field ? 'pending' : 'idle');
  // One-shot: once the link's field was focused (or reported missing), later
  // tab switches by the user must not yank focus back to it.
  const settled = useRef(false);

  useEffect(() => {
    if (!field) {
      setStatus('idle');
      return;
    }
    if (!ready || settled.current) return;
    if (!chain) {
      settled.current = true;
      setStatus('missing');
      return;
    }
    let left = attempts;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (typeof document !== 'undefined' && focusFieldElement(document, field)) {
        settled.current = true;
        setStatus('focused');
        return;
      }
      left -= 1;
      if (left <= 0) {
        settled.current = true;
        setStatus('missing');
        return;
      }
      timer = setTimeout(tick, intervalMs);
    };
    setStatus('pending');
    timer = setTimeout(tick, 0);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [field, chain, ready, attempts, intervalMs]);

  return { status, reveal };
}
