import { describe, expect, it } from 'vitest';
import { resolveRoomName, subjectBucket } from '../shard-config';

describe('resolveRoomName', () => {
  it('defaults to the plain siteId for the studio plane', () => {
    expect(resolveRoomName('site-1')).toBe('site-1');
    expect(resolveRoomName('site-1', { plane: 'studio' })).toBe('site-1');
  });

  it('applies a region shard key for studio multi-region', () => {
    expect(resolveRoomName('site-1', { plane: 'studio', region: 'apac' })).toBe('site-1:apac');
  });

  it('uses a dedicated audience room name for the public plane', () => {
    expect(resolveRoomName('site-1', { plane: 'public' })).toBe('site-1:aud');
  });

  it('buckets the audience room deterministically by subject', () => {
    const a = resolveRoomName('site-1', { plane: 'public', subjectId: 'citizen-42', buckets: 8 });
    const b = resolveRoomName('site-1', { plane: 'public', subjectId: 'citizen-42', buckets: 8 });
    expect(a).toBe(b); // stable — connect and publish land on the same room
    expect(a).toMatch(/^site-1:aud:\d+$/);
  });

  it('single bucket collapses to the base audience room', () => {
    expect(resolveRoomName('site-1', { plane: 'public', subjectId: 'x', buckets: 1 })).toBe('site-1:aud');
  });
});

describe('subjectBucket', () => {
  it('is stable and within range', () => {
    for (const subject of ['a', 'citizen-1', 'citizen-2', 'long-subject-id-xyz']) {
      const v = subjectBucket(subject, 16);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(16);
      expect(subjectBucket(subject, 16)).toBe(v);
    }
  });

  it('returns 0 for a single bucket', () => {
    expect(subjectBucket('anything', 1)).toBe(0);
  });
});
