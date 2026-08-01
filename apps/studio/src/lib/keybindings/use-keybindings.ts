import { useEffect, useMemo, useRef } from 'react';
import type { KeybindingMap } from '@lumibase/contracts/schemas';
import { ACTIONS_BY_ID, buildChordLookup } from './actions';
import { eventToChord } from './chord';
import { isReserved } from './platform';
import { useKeybindingsStore } from './store';

/** Is the event target a field where the user is genuinely typing? */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

/**
 * Mount the single global keydown listener. Call ONCE, high in the tree
 * (`AppShell`). `onAction(actionId)` runs the side effect for a matched action
 * — navigation, opening the palette — while `editor.save` routes through the
 * store's registered handler.
 *
 * Robustness (the Directus "Cmd+S leaks to the browser" failure mode):
 *   - listener is attached to `window` in the CAPTURE phase, so it always
 *     wins before any component-level handler can `stopPropagation`;
 *   - matching is by `event.code` (physical key), immune to layout/`Opt`
 *     remapping of `event.key`;
 *   - `preventDefault()` + `stopPropagation()` are called SYNCHRONOUSLY in the
 *     keydown handler, never behind an await.
 */
export function useGlobalShortcuts(
  resolvedKeymap: KeybindingMap,
  onAction: (actionId: string) => void,
): void {
  const lookup = useMemo(() => buildChordLookup(resolvedKeymap), [resolvedKeymap]);

  // Keep latest callback/lookup in refs so the listener is attached once and
  // never torn down + re-added on every keymap change.
  const lookupRef = useRef(lookup);
  const onActionRef = useRef(onAction);
  lookupRef.current = lookup;
  onActionRef.current = onAction;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const chord = eventToChord(event);
      if (!chord || isReserved(chord)) return;

      const actionId = lookupRef.current.get(chord);
      if (!actionId) return;
      const action = ACTIONS_BY_ID[actionId];
      if (!action) return;

      // Typing in a field: only save / palette may interrupt; let the rest
      // type through (don't preventDefault, don't fire).
      if (isEditableTarget(event.target) && !action.runWhileTyping) return;

      if (action.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
      onActionRef.current(actionId);
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);
}

/**
 * Register a "save and stay" handler for the currently-mounted editor. The
 * global `editor.save` shortcut (Cmd/Ctrl+S) invokes it when `enabled` (e.g.
 * the form is dirty and the user may update). Automatically cleared on unmount.
 *
 * The handler is read fresh on each save via a ref, so an inline closure that
 * captures changing state (draft, isDirty) stays correct without re-registering
 * every render.
 */
export function useSaveHandler(handler: () => void, enabled: boolean): void {
  const register = useKeybindingsStore((s) => s.registerSaveHandler);
  const clear = useKeybindingsStore((s) => s.clearSaveHandler);

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // A stable function identity that always calls the latest closure. Used as
  // the ownership token for clearSaveHandler too.
  const stable = useRef(() => handlerRef.current());

  useEffect(() => {
    const fn = stable.current;
    register(fn, enabled);
    return () => clear(fn);
  }, [register, clear, enabled]);
}
