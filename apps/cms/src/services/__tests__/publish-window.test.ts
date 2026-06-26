import { describe, it, expect } from 'vitest';
import { normalizePublishWindow, ItemServiceError } from '../item-service';

describe('normalizePublishWindow (Req 7.2)', () => {
  it('returns nulls when unset', () => {
    expect(normalizePublishWindow(null, undefined)).toEqual({
      publishAt: null,
      unpublishAt: null,
    });
  });

  it('coerces ISO strings to Date', () => {
    const r = normalizePublishWindow('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    expect(r.publishAt).toBeInstanceOf(Date);
    expect(r.unpublishAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rejects unpublishAt <= publishAt', () => {
    expect(() =>
      normalizePublishWindow('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    ).toThrowError(ItemServiceError);
    try {
      normalizePublishWindow('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    } catch (e) {
      expect((e as ItemServiceError).code).toBe('INVALID_PUBLISH_WINDOW');
      expect((e as ItemServiceError).status).toBe(422);
    }
  });

  it('rejects invalid dates', () => {
    expect(() => normalizePublishWindow('not-a-date', null)).toThrowError(ItemServiceError);
  });

  it('allows a single bound', () => {
    expect(normalizePublishWindow('2026-01-01T00:00:00.000Z', null).unpublishAt).toBeNull();
    expect(normalizePublishWindow(null, '2026-01-01T00:00:00.000Z').publishAt).toBeNull();
  });
});
