import { describe, it, expect } from 'vitest';
import { ephemeralSiteId, remapIds } from '../preview';

describe('preview env helpers', () => {
  it('derives a deterministic ephemeral site id per PR', () => {
    expect(ephemeralSiteId('site_abc', 42)).toBe('site_abc__pr-42');
    expect(ephemeralSiteId('site_abc', 42)).toBe(ephemeralSiteId('site_abc', 42));
    expect(ephemeralSiteId('site_abc', 1)).not.toBe(
      ephemeralSiteId('site_abc', 2),
    );
  });

  it('remaps every source id to a fresh unique id', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const map = remapIds(rows);
    expect(map.size).toBe(3);
    const newIds = [...map.values()];
    expect(new Set(newIds).size).toBe(3); // all unique
    expect(newIds).not.toContain('a'); // not reusing source ids
    expect(map.get('a')).toBeTruthy();
  });
});
