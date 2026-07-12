import { describe, expect, it } from 'vitest';
import { parsePageviewSettings } from '@lumibase/shared/schemas';

describe('parsePageviewSettings', () => {
  it('applies defaults for an empty value', () => {
    const cfg = parsePageviewSettings(undefined);
    expect(cfg).toMatchObject({
      enabled: true,
      strategy: 'db-rollup',
      userTable: 'lumibase_users',
      respectConsent: true,
      botFilter: true,
      flushIntervalS: 300,
    });
  });

  it('falls back to db-rollup on an invalid strategy', () => {
    const cfg = parsePageviewSettings({ strategy: 'nope' });
    expect(cfg.strategy).toBe('db-rollup');
  });

  it('keeps a valid strategy override', () => {
    expect(parsePageviewSettings({ strategy: 'hot-counter' }).strategy).toBe('hot-counter');
    expect(parsePageviewSettings({ strategy: 'hll' }).strategy).toBe('hll');
    expect(parsePageviewSettings({ strategy: 'cdc' }).strategy).toBe('cdc');
  });
});
