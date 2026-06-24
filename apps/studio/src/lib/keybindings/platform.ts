/**
 * Platform detection + the list of chords the OS/browser hold so tightly that
 * binding them in Studio is pointless or harmful. Used by both the live
 * dispatcher (ignore reserved chords) and the rebinding UI (block/warn).
 */

export type Platform = 'mac' | 'windows' | 'linux';

/**
 * Best-effort platform detection. Prefers the modern `userAgentData` (which is
 * not spoofed by the legacy `platform` quirks) and falls back to UA string.
 * SSR-safe: returns `linux` when there is no `navigator`.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const uaData = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData;
  const raw = (uaData?.platform || navigator.platform || navigator.userAgent || '')
    .toLowerCase();
  if (raw.includes('mac') || raw.includes('iphone') || raw.includes('ipad')) {
    return 'mac';
  }
  if (raw.includes('win')) return 'windows';
  return 'linux';
}

export function isMac(platform: Platform = detectPlatform()): boolean {
  return platform === 'mac';
}

/**
 * Canonical chords that must never be assigned. These are intercepted by the
 * OS or browser before (or regardless of) `preventDefault`, so a binding here
 * is either dead or actively breaks the user's environment.
 *
 * `mod` = Cmd on macOS / Ctrl elsewhere (see `chord.ts`). Tab-switching,
 * window/tab lifecycle, and the macOS hide/minimize/quit set live here.
 */
export const HARD_RESERVED_CHORDS: ReadonlySet<string> = new Set([
  'mod+w', // close tab
  'mod+t', // new tab
  'mod+n', // new window
  'mod+q', // quit (mac)
  'mod+tab', // switch tab
  'mod+shift+tab',
  'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5',
  'mod+6', 'mod+7', 'mod+8', 'mod+9',
  'mod+m', // minimize (mac)
  'mod+h', // hide (mac)
  'mod+r', // reload
  'mod+shift+r',
]);

/**
 * Chords the browser owns but that `preventDefault` on keydown reliably
 * overrides in practice (Print, Save page, Bookmark, address bar, Find). We
 * allow binding these — that is the whole point of capturing Cmd+S — but the
 * rebinding UI surfaces a soft warning so the operator knows they are taking
 * the key away from the browser.
 */
export const SOFT_RESERVED_CHORDS: ReadonlyMap<string, string> = new Map([
  ['mod+s', 'Overrides the browser "Save page" shortcut'],
  ['mod+p', 'Overrides the browser "Print" shortcut'],
  ['mod+d', 'Overrides the browser "Bookmark" shortcut'],
  ['mod+l', 'Overrides the browser "focus address bar" shortcut'],
  ['mod+f', 'Overrides the browser "Find" shortcut'],
  ['mod+k', 'Overrides the browser address-bar search on some browsers'],
]);

/**
 * `mod+alt+<letter>` on Windows can collide with AltGr on some European
 * layouts (AltGr is emitted as Ctrl+Alt). Used to warn — not block — since the
 * default "open settings" binding is `mod+alt+s`.
 */
export function isAltGrRisk(chord: string, platform: Platform): boolean {
  if (platform === 'mac') return false;
  return /^mod\+alt\+[a-z]$/.test(chord);
}

/** True for chords that can never be assigned. */
export function isReserved(chord: string): boolean {
  return HARD_RESERVED_CHORDS.has(chord);
}
