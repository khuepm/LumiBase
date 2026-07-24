// @vitest-environment jsdom
// jsdom gives us a working `localStorage` (installed by src/test/setup.ts) so
// the runtime API-base override can be exercised; the env-var cases are
// environment-agnostic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeApiBaseUrl,
  getApiBaseUrl,
  getRuntimeApiBaseUrl,
  setRuntimeApiBaseUrl,
} from '../api-base';

/**
 * `getApiBaseUrl` centralizes how the Studio resolves the CMS origin so the
 * SPA works same-origin (dev proxy / Docker), cross-origin (Cloudflare Pages →
 * api.lumibase.dev), and inside the bundled desktop/mobile shell where the
 * user picks the server at runtime. See `lib/api-base.ts`.
 */
describe('getApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearRuntimeApiBaseUrl();
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

  it('prefers a persisted runtime override over the build-time value', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.lumibase.dev');
    setRuntimeApiBaseUrl('https://my-cms.example.com/');
    expect(getApiBaseUrl()).toBe('https://my-cms.example.com');
  });

  it('normalizes and round-trips the runtime override', () => {
    setRuntimeApiBaseUrl('  https://my-cms.example.com//  ');
    expect(getRuntimeApiBaseUrl()).toBe('https://my-cms.example.com');
  });

  it('clears the runtime override', () => {
    setRuntimeApiBaseUrl('https://my-cms.example.com');
    clearRuntimeApiBaseUrl();
    expect(getRuntimeApiBaseUrl()).toBeNull();
  });

  it('ignores an empty runtime override', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.lumibase.dev');
    setRuntimeApiBaseUrl('   ');
    expect(getRuntimeApiBaseUrl()).toBeNull();
    expect(getApiBaseUrl()).toBe('https://api.lumibase.dev');
  });
});
