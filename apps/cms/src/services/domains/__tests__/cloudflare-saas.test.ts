import { describe, expect, it } from 'vitest';
import { cloudflareSaaSConfig, isHostnameLive } from '../cloudflare-saas';

describe('cloudflareSaaSConfig', () => {
  it('returns null when the token or zone is missing (self-hosted fallback)', () => {
    expect(cloudflareSaaSConfig({})).toBeNull();
    expect(cloudflareSaaSConfig({ CLOUDFLARE_API_TOKEN: 't' })).toBeNull();
    expect(cloudflareSaaSConfig({ CLOUDFLARE_ZONE_ID: 'z' })).toBeNull();
  });

  it('builds a config and defaults the fallback origin', () => {
    expect(cloudflareSaaSConfig({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ZONE_ID: 'z' })).toEqual({
      apiToken: 't',
      zoneId: 'z',
      fallbackOrigin: 'cname.lumibase.dev',
    });
  });

  it('honors an explicit fallback origin', () => {
    expect(
      cloudflareSaaSConfig({
        CLOUDFLARE_API_TOKEN: 't',
        CLOUDFLARE_ZONE_ID: 'z',
        LUMIBASE_SAAS_FALLBACK: 'cname.example.dev',
      })?.fallbackOrigin,
    ).toBe('cname.example.dev');
  });
});

describe('isHostnameLive', () => {
  it('is live only when both status and ssl are active', () => {
    expect(isHostnameLive({ status: 'active', sslStatus: 'active' })).toBe(true);
    expect(isHostnameLive({ status: 'active', sslStatus: 'pending_validation' })).toBe(false);
    expect(isHostnameLive({ status: 'pending', sslStatus: 'active' })).toBe(false);
  });
});
