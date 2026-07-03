import { describe, expect, it } from 'vitest';
import { codeToToken, eventToChord, formatChord } from '../chord';

/**
 * Chord normalization tests — the cross-platform / layout-independence
 * guarantees that make Cmd+S handling robust (the Directus failure mode).
 */

type KeyEventLike = Parameters<typeof eventToChord>[0];
function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    code: 'KeyS',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  };
}

describe('codeToToken', () => {
  it('normalizes letters, digits, f-keys and named keys', () => {
    expect(codeToToken('KeyS')).toBe('s');
    expect(codeToToken('Digit1')).toBe('1');
    expect(codeToToken('Numpad1')).toBe('1');
    expect(codeToToken('F5')).toBe('f5');
    expect(codeToToken('Slash')).toBe('slash');
    expect(codeToToken('Escape')).toBe('escape');
  });
  it('returns null for unmapped codes', () => {
    expect(codeToToken('MediaPlayPause')).toBeNull();
  });
});

describe('eventToChord — mod abstraction', () => {
  it('maps Cmd+S to mod+s on macOS', () => {
    expect(eventToChord(ev({ metaKey: true }), 'mac')).toBe('mod+s');
  });
  it('maps Ctrl+S to mod+s on Windows/Linux', () => {
    expect(eventToChord(ev({ ctrlKey: true }), 'windows')).toBe('mod+s');
    expect(eventToChord(ev({ ctrlKey: true }), 'linux')).toBe('mod+s');
  });
  it('does NOT treat bare Ctrl+S as a chord on macOS (mod is Cmd there)', () => {
    // ctrl alone on mac is not the accelerator → no `mod`
    expect(eventToChord(ev({ ctrlKey: true }), 'mac')).toBe('s');
  });
  it('orders modifiers mod → alt → shift', () => {
    expect(
      eventToChord(ev({ metaKey: true, altKey: true, shiftKey: true }), 'mac'),
    ).toBe('mod+alt+shift+s');
  });
});

describe('eventToChord — layout independence (the crux)', () => {
  it('uses event.code, ignoring the remapped event.key from Opt/AltGr', () => {
    // macOS Opt+S emits the character "ß" in event.key, but code stays KeyS.
    // We never read event.key, so the chord is stable.
    expect(eventToChord(ev({ code: 'KeyS', metaKey: true, altKey: true }), 'mac')).toBe(
      'mod+alt+s',
    );
  });
  it('returns null for a bare modifier press', () => {
    expect(eventToChord(ev({ code: 'MetaLeft', metaKey: true }), 'mac')).toBeNull();
  });
});

describe('formatChord', () => {
  it('packs glyphs with no separator on macOS', () => {
    expect(formatChord('mod+s', 'mac')).toBe('⌘S');
    expect(formatChord('mod+alt+s', 'mac')).toBe('⌘⌥S');
  });
  it('uses +-joined labels on Windows/Linux', () => {
    expect(formatChord('mod+s', 'windows')).toBe('Ctrl+S');
    expect(formatChord('mod+alt+s', 'linux')).toBe('Ctrl+Alt+S');
  });
  it('renders named keys and sequences', () => {
    expect(formatChord('shift+slash', 'windows')).toBe('Shift+/');
    expect(formatChord('mod+k mod+s', 'mac')).toBe('⌘K then ⌘S');
  });
});
