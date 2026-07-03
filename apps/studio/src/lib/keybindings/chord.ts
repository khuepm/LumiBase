import { type Platform, isMac } from './platform';

/**
 * Chord normalization. A *chord* is a canonical, layout-independent string:
 * modifiers in fixed order `mod` → `alt` → `shift`, then one key token, joined
 * by `+` (e.g. `mod+s`, `mod+alt+s`, `shift+slash`).
 *
 *   - `mod` abstracts the primary accelerator: Cmd on macOS, Ctrl elsewhere.
 *   - Key tokens come from `event.code` (physical position), NOT `event.key`.
 *     This is the crux of robust Cmd+S handling: on macOS `Opt+S` emits the
 *     character `ß`, and AltGr layouts remap `event.key` — but `event.code`
 *     stays `KeyS`, so matching never silently misses.
 */

/** Map a physical `event.code` to a canonical key token, or null if unusable. */
export function codeToToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase(); // KeyS → s
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6); // Numpad1 → 1
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase(); // F5 → f5
  const NAMED: Record<string, string> = {
    Enter: 'enter',
    NumpadEnter: 'enter',
    Escape: 'escape',
    Space: 'space',
    Slash: 'slash',
    Backslash: 'backslash',
    Comma: 'comma',
    Period: 'period',
    Semicolon: 'semicolon',
    Quote: 'quote',
    BracketLeft: 'bracketleft',
    BracketRight: 'bracketright',
    Minus: 'minus',
    Equal: 'equal',
    Backquote: 'backquote',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
  };
  return NAMED[code] ?? null;
}

/** A pure modifier code that is never a standalone key in a chord. */
function isModifierCode(code: string): boolean {
  return (
    code === 'ShiftLeft' ||
    code === 'ShiftRight' ||
    code === 'ControlLeft' ||
    code === 'ControlRight' ||
    code === 'AltLeft' ||
    code === 'AltRight' ||
    code === 'MetaLeft' ||
    code === 'MetaRight'
  );
}

/**
 * Build the canonical chord for a keydown event, or null when the event is not
 * a usable shortcut (a bare modifier press, or an unmapped key).
 *
 * `mod` resolves per platform: Cmd (metaKey) on macOS, Ctrl (ctrlKey)
 * elsewhere. The opposite-platform modifier is folded into `mod` too, so a
 * stray Ctrl on macOS does not produce a different, accidentally-matching
 * chord — it just reads as `mod`.
 */
export function eventToChord(
  event: Pick<
    KeyboardEvent,
    'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
  platform?: Platform,
): string | null {
  if (isModifierCode(event.code)) return null;
  const token = codeToToken(event.code);
  if (!token) return null;

  const mac = isMac(platform);
  const mod = mac ? event.metaKey : event.ctrlKey;

  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(token);
  return parts.join('+');
}

const MAC_SYMBOL: Record<string, string> = {
  mod: '⌘',
  alt: '⌥',
  shift: '⇧',
};
const OTHER_LABEL: Record<string, string> = {
  mod: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

const KEY_LABEL: Record<string, string> = {
  slash: '/',
  backslash: '\\',
  comma: ',',
  period: '.',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  minus: '-',
  equal: '=',
  backquote: '`',
  space: 'Space',
  enter: '↵',
  escape: 'Esc',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

function formatKey(token: string): string {
  if (KEY_LABEL[token]) return KEY_LABEL[token];
  if (/^f([1-9]|1[0-2])$/.test(token)) return token.toUpperCase();
  if (/^[a-z0-9]$/.test(token)) return token.toUpperCase();
  return token;
}

function formatSegment(segment: string, mac: boolean): string {
  const parts = segment.split('+');
  const key = parts[parts.length - 1] ?? segment;
  const mods = parts.slice(0, -1);
  const renderedMods = mods.map((m) => (mac ? MAC_SYMBOL[m] ?? m : OTHER_LABEL[m] ?? m));
  const renderedKey = formatKey(key);
  // macOS convention packs glyphs with no separator (⌘S); others use "+".
  return mac
    ? [...renderedMods, renderedKey].join('')
    : [...renderedMods, renderedKey].join('+');
}

/**
 * Render a chord for display. macOS uses glyphs packed together (⌘⌥S);
 * Windows/Linux use `Ctrl+Alt+S`. A two-chord sequence (`g c`) renders as
 * `G then C`.
 */
export function formatChord(chord: string, platform?: Platform): string {
  const mac = isMac(platform);
  return chord
    .split(' ')
    .map((seg) => formatSegment(seg, mac))
    .join(' then ');
}
