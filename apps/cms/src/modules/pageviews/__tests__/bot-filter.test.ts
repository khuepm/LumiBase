import { describe, expect, it } from 'vitest';
import { shouldRecord } from '../bot-filter';

describe('shouldRecord (bot filter)', () => {
  it('records a normal browser UA', () => {
    const r = shouldRecord({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    });
    expect(r.record).toBe(true);
  });

  it.each([
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'python-requests/2.31',
    'curl/8.4.0',
    'HeadlessChrome/120.0',
    'SomeCrawler spider',
  ])('drops bot UA %s', (ua) => {
    const r = shouldRecord({ userAgent: ua });
    expect(r.record).toBe(false);
    expect(r.reason).toBe('bot-ua');
  });

  it('drops an empty UA', () => {
    expect(shouldRecord({ userAgent: '' }).reason).toBe('empty-ua');
    expect(shouldRecord({ userAgent: undefined }).reason).toBe('empty-ua');
  });

  it('honours DNT and GPC opt-out before UA checks', () => {
    expect(shouldRecord({ userAgent: 'Mozilla/5.0', dnt: '1' }).reason).toBe('dnt');
    expect(shouldRecord({ userAgent: 'Mozilla/5.0', gpc: '1' }).reason).toBe('gpc');
  });
});
