import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP,
  buildChordLookup,
  findConflicts,
  resolveKeymap,
} from '../actions';

describe('resolveKeymap — default + user override merge', () => {
  it('returns defaults when there are no overrides', () => {
    expect(resolveKeymap(undefined)).toEqual(DEFAULT_KEYMAP);
    expect(resolveKeymap({})).toEqual(DEFAULT_KEYMAP);
  });
  it('lets a user override replace a default chord', () => {
    const resolved = resolveKeymap({ 'editor.save': 'mod+shift+s' });
    expect(resolved['editor.save']).toBe('mod+shift+s');
    // other defaults untouched
    expect(resolved['palette.open']).toBe(DEFAULT_KEYMAP['palette.open']);
  });
  it('treats an empty-string override as "unbound"', () => {
    const resolved = resolveKeymap({ 'editor.save': '' });
    expect(resolved['editor.save']).toBeUndefined();
  });
  it('can assign a chord to an action that ships unassigned', () => {
    expect(DEFAULT_KEYMAP['palette.openAlt']).toBeUndefined();
    const resolved = resolveKeymap({ 'palette.openAlt': 'mod+p' });
    expect(resolved['palette.openAlt']).toBe('mod+p');
  });
  it('ignores overrides for unknown action ids', () => {
    const resolved = resolveKeymap({ 'bogus.action': 'mod+j' });
    expect(resolved['bogus.action']).toBeUndefined();
  });
});

describe('buildChordLookup', () => {
  it('inverts the keymap to chord → actionId', () => {
    const lookup = buildChordLookup(resolveKeymap(undefined));
    expect(lookup.get('mod+s')).toBe('editor.save');
    expect(lookup.get('mod+k')).toBe('palette.open');
    expect(lookup.get('mod+alt+s')).toBe('nav.settings');
  });
});

describe('findConflicts', () => {
  it('reports chords bound to more than one action', () => {
    const conflicts = findConflicts({ a: 'mod+s', b: 'mod+s', c: 'mod+k' });
    expect(conflicts.has('mod+s')).toBe(true);
    expect(conflicts.get('mod+s')).toEqual(['a', 'b']);
    expect(conflicts.has('mod+k')).toBe(false);
  });
  it('returns no conflicts for the default keymap', () => {
    expect(findConflicts(DEFAULT_KEYMAP).size).toBe(0);
  });
});
