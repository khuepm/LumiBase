import { describe, expect, it } from 'vitest';
import { CF_BEACON_SRC, cfBeaconTag, cfWebAnalyticsPlugin, injectCfBeacon } from '../cf-web-analytics';

const HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const TOKEN = '9c5df9a6053a4038897cb91c143cc109';

function transform(token: string | undefined): string {
  return injectCfBeacon(HTML, token);
}

describe('cfWebAnalyticsPlugin (#1045)', () => {
  it('leaves the page alone without a token, so self-hosted builds carry no beacon', () => {
    expect(transform(undefined)).toBe(HTML);
    expect(transform('  ')).toBe(HTML);
  });

  it('injects the beacon before </body> when a token is set', () => {
    const out = transform(TOKEN);
    expect(out).toContain(`src="${CF_BEACON_SRC}"`);
    expect(out).toContain(`data-cf-beacon='{"token": "${TOKEN}"}'`);
    expect(out.indexOf('beacon.min.js')).toBeLessThan(out.indexOf('</body>'));
  });

  it('only runs for production builds', () => {
    expect(cfWebAnalyticsPlugin(TOKEN).apply).toBe('build');
  });

  it('rejects a token that could inject markup', () => {
    expect(() => cfBeaconTag(`${TOKEN.slice(0, 30)}'>`)).toThrow(/32 lowercase hex/);
    expect(() => cfWebAnalyticsPlugin('not-a-token')).toThrow(/32 lowercase hex/);
  });
});
