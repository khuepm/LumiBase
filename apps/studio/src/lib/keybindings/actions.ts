import type { KeybindingMap } from '@lumibase/contracts/schemas';

/**
 * Static registry of keyboard actions — the single source of truth for
 * LumiBase's *default* keymap. User overrides (stored in `users.preferences`)
 * merge on top of `DEFAULT_KEYMAP` at runtime (see `store.ts`).
 *
 * Adding a shortcut = add an entry here + handle its `id` in `AppShell`'s
 * action dispatcher. Everything else (settings UI row, palette hint, conflict
 * detection) is data-driven off this list.
 */

export type ActionCategory = 'Editing' | 'Navigation' | 'Global';

export interface ActionDef {
  /** Stable id, dotted slug. Also the key in the keybinding map. */
  id: string;
  label: string;
  description: string;
  category: ActionCategory;
  /**
   * Default canonical chord, or null for actions that ship unassigned (the
   * operator can opt in via the settings UI — e.g. the VSCode-style `mod+p`
   * palette alias).
   */
  defaultChord: string | null;
  /**
   * `editor` actions only fire when a screen has registered a handler (e.g. an
   * editor with unsaved changes). `global` actions fire anywhere.
   */
  scope: 'global' | 'editor';
  /**
   * Whether the action should still fire while the user is typing in an
   * input/textarea. Save and the palette do; navigation shortcuts don't, so
   * typing "k" in a search box never yanks focus away.
   */
  runWhileTyping: boolean;
  /**
   * Call `preventDefault()`/`stopPropagation()` whenever this chord matches —
   * even if the action is a no-op right now. True for chords that shadow a
   * browser default we must suppress (Cmd+S "Save page", Cmd+K, Cmd+P).
   */
  preventDefault: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
  {
    id: 'editor.save',
    label: 'Save and stay',
    description: 'Save changes on the current editor without leaving the screen.',
    category: 'Editing',
    defaultChord: 'mod+s',
    scope: 'editor',
    runWhileTyping: true,
    preventDefault: true,
  },
  {
    id: 'palette.open',
    label: 'Open command palette',
    description: 'Jump to any screen or run a command (VSCode-style quick open).',
    category: 'Global',
    defaultChord: 'mod+k',
    scope: 'global',
    runWhileTyping: true,
    preventDefault: true,
  },
  {
    id: 'palette.openAlt',
    label: 'Open command palette (alternate)',
    description: 'Optional second binding for the palette — assign Cmd/Ctrl+P for VSCode muscle memory.',
    category: 'Global',
    defaultChord: null,
    scope: 'global',
    runWhileTyping: true,
    preventDefault: true,
  },
  {
    id: 'nav.settings',
    label: 'Open Settings',
    description: 'Open the Settings screen from anywhere.',
    category: 'Navigation',
    defaultChord: 'mod+alt+s',
    scope: 'global',
    runWhileTyping: false,
    preventDefault: true,
  },
  {
    id: 'help.shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Open the keyboard shortcuts settings.',
    category: 'Global',
    defaultChord: 'shift+slash',
    scope: 'global',
    runWhileTyping: false,
    preventDefault: true,
  },
] as const;

export const ACTIONS_BY_ID: Record<string, ActionDef> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a]),
);

/** The built-in keymap: every action that ships with a default chord. */
export const DEFAULT_KEYMAP: KeybindingMap = Object.fromEntries(
  ACTIONS.filter((a) => a.defaultChord).map((a) => [a.id, a.defaultChord as string]),
);

/**
 * Resolve defaults + user overrides into the effective `actionId → chord` map.
 * An override of `''` (empty string) explicitly unbinds an action. Overrides
 * for unknown action ids are ignored so a stale stored binding can't shadow a
 * renamed action.
 */
export function resolveKeymap(overrides: KeybindingMap | undefined): KeybindingMap {
  const resolved: KeybindingMap = { ...DEFAULT_KEYMAP };
  if (overrides) {
    for (const [id, chord] of Object.entries(overrides)) {
      if (!ACTIONS_BY_ID[id]) continue;
      if (chord === '') delete resolved[id];
      else resolved[id] = chord;
    }
  }
  return resolved;
}

/** Invert a keymap to `chord → actionId` for O(1) dispatch lookup. */
export function buildChordLookup(keymap: KeybindingMap): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [id, chord] of Object.entries(keymap)) {
    if (chord) lookup.set(chord, id);
  }
  return lookup;
}

/**
 * Find action ids that share a chord (conflicts). Returns a map of
 * `chord → actionId[]` for any chord bound to more than one action.
 */
export function findConflicts(keymap: KeybindingMap): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const [id, chord] of Object.entries(keymap)) {
    if (!chord) continue;
    const list = byChord.get(chord) ?? [];
    list.push(id);
    byChord.set(chord, list);
  }
  for (const [chord, ids] of byChord) {
    if (ids.length < 2) byChord.delete(chord);
  }
  return byChord;
}
