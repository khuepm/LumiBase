import { create } from 'zustand';
import type { KeybindingMap } from '@lumibase/contracts/schemas';
import { DEFAULT_KEYMAP, resolveKeymap } from './actions';

/**
 * Global keybindings state.
 *
 * `overrides` is the user's stored map (from `users.preferences.keybindings`).
 * `resolvedKeymap` is `DEFAULT_KEYMAP` merged with those overrides — the map
 * the dispatcher actually reads. The server is the source of truth: loading is
 * done once in `AppShell` (via React Query) and pushed in with `setOverrides`;
 * the settings page edits `overrides` and persists through the SDK.
 *
 * `saveHandler` is the "save and stay" callback the currently-mounted editor
 * registers. It lives here (not in React context) so the single global keydown
 * listener can reach it without re-subscribing on every navigation.
 */
interface KeybindingsState {
  overrides: KeybindingMap;
  resolvedKeymap: KeybindingMap;
  loaded: boolean;

  saveHandler: (() => void) | null;
  saveEnabled: boolean;

  /** Replace overrides wholesale (on load, or after a successful save). */
  setOverrides: (overrides: KeybindingMap) => void;
  /** Mark that the server preferences have been fetched at least once. */
  setLoaded: (loaded: boolean) => void;
  /** Set/clear a single binding locally (does not persist). */
  setBinding: (actionId: string, chord: string | null) => void;
  /** Drop one override so the action falls back to its default. */
  resetBinding: (actionId: string) => void;
  /** Clear all overrides → back to LumiBase defaults. */
  resetAll: () => void;

  registerSaveHandler: (fn: () => void, enabled: boolean) => void;
  clearSaveHandler: (fn: () => void) => void;
  runSave: () => void;
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  overrides: {},
  resolvedKeymap: { ...DEFAULT_KEYMAP },
  loaded: false,

  saveHandler: null,
  saveEnabled: false,

  setOverrides: (overrides) =>
    set({ overrides, resolvedKeymap: resolveKeymap(overrides) }),

  setLoaded: (loaded) => set({ loaded }),

  setBinding: (actionId, chord) => {
    const overrides = { ...get().overrides };
    // `''` is the explicit "unbound" marker the resolver understands.
    overrides[actionId] = chord ?? '';
    set({ overrides, resolvedKeymap: resolveKeymap(overrides) });
  },

  resetBinding: (actionId) => {
    const overrides = { ...get().overrides };
    delete overrides[actionId];
    set({ overrides, resolvedKeymap: resolveKeymap(overrides) });
  },

  resetAll: () => set({ overrides: {}, resolvedKeymap: { ...DEFAULT_KEYMAP } }),

  registerSaveHandler: (fn, enabled) =>
    set({ saveHandler: fn, saveEnabled: enabled }),

  // Only clear if the unmounting editor still owns the slot — guards against a
  // newly-mounted editor's handler being wiped by the previous one's cleanup.
  clearSaveHandler: (fn) =>
    set((state) =>
      state.saveHandler === fn
        ? { saveHandler: null, saveEnabled: false }
        : state,
    ),

  runSave: () => {
    const { saveHandler, saveEnabled } = get();
    if (saveHandler && saveEnabled) saveHandler();
  },
}));
