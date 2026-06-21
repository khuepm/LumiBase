import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVELOPE_SETTING, parseEnvelopeSetting } from '../envelope-settings';

/**
 * Envelope-setting parser unit tests (task 3.6; Req 4.5).
 */
describe('parseEnvelopeSetting', () => {
  it('coerces empty/garbage into the safe default (disabled/idle)', () => {
    expect(parseEnvelopeSetting(undefined)).toEqual(DEFAULT_ENVELOPE_SETTING);
    expect(parseEnvelopeSetting(null)).toEqual(DEFAULT_ENVELOPE_SETTING);
    expect(parseEnvelopeSetting({ enabled: 'yes' }).enabled).toBe(false);
  });

  it('treats enabled only when strictly true', () => {
    expect(parseEnvelopeSetting({ enabled: true }).enabled).toBe(true);
    expect(parseEnvelopeSetting({ enabled: 1 }).enabled).toBe(false);
  });

  it('preserves a well-formed migration block', () => {
    const parsed = parseEnvelopeSetting({
      enabled: true,
      migration: {
        direction: 'to_envelope',
        status: 'running',
        cursor: 'item_42',
        processed: 12,
        startedAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:01:00.000Z',
      },
    });
    expect(parsed.migration).toMatchObject({
      direction: 'to_envelope',
      status: 'running',
      cursor: 'item_42',
      processed: 12,
    });
  });

  it('rejects unknown direction/status values', () => {
    const parsed = parseEnvelopeSetting({
      migration: { direction: 'sideways', status: 'exploded' },
    });
    expect(parsed.migration.direction).toBeNull();
    expect(parsed.migration.status).toBe('idle');
  });
});
