import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl } from '../api-base';

/**
 * `getApiBaseUrl` centralizes how the Studio resolves the CMS origin so the
 * SPA works both same-origin (dev proxy / Docker) and cross-origin
 * (Cloudflare Pages → api.lumibase.dev). See `lib/api-base.ts`.
 */
describe('getApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty string (same-origin) when VITE_API_URL is unset', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(getApiBaseUrl()).toBe('');
  });

  it('returns the configured absolute origin', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.lumibase.dev');
    expect(getApiBaseUrl()).toBe('https://api.lumibase.dev');
  });

  it('strips trailing slashes so callers can append /api/v1/...', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.lumibase.dev/');
    expect(getApiBaseUrl()).toBe('https://api.lumibase.dev');
  });

  it('trims surrounding whitespace', () => {
    vi.stubEnv('VITE_API_URL', '  https://api.lumibase.dev  ');
    expect(getApiBaseUrl()).toBe('https://api.lumibase.dev');
  });
});
