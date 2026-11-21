import { describe, expect, it } from 'vitest';
import { formFromSetting, settingFromForm } from '../content-integrity-page';

describe('content-integrity settings form (#989)', () => {
  it('reads defaults from a missing setting', () => {
    expect(formFromSetting(null)).toEqual({
      enabled: true, action: 'notify', allowedHosts: '', burstThreshold: '25', burstWindowMinutes: '10',
      firstPublishSignal: true, weeklyDigest: true,
    });
  });

  it('round-trips a stored value and keeps keys the form does not edit', () => {
    const stored = { action: 'unpublish', allowedHosts: ['cdn.example.com'], weeklyDigest: false, future: 1 };
    const form = formFromSetting(stored);
    expect(form).toMatchObject({ action: 'unpublish', allowedHosts: 'cdn.example.com', weeklyDigest: false });
    const out = settingFromForm({ ...form, allowedHosts: 'CDN.example.com\nimg.example.com, a.example.org' }, stored);
    expect(out).toEqual({
      value: {
        future: 1, enabled: true, action: 'unpublish', allowedHosts: ['cdn.example.com', 'img.example.com', 'a.example.org'],
        burstThreshold: 25, burstWindowMinutes: 10, firstPublishSignal: true, weeklyDigest: false,
      },
    });
  });

  it('refuses URLs, zero thresholds and fractional windows', () => {
    const base = formFromSetting(null);
    expect(settingFromForm({ ...base, allowedHosts: 'https://cdn.example.com/x' }, null)).toHaveProperty('error');
    expect(settingFromForm({ ...base, burstThreshold: '0' }, null)).toHaveProperty('error');
    expect(settingFromForm({ ...base, burstWindowMinutes: '1.5' }, null)).toHaveProperty('error');
  });
});
