import { describe, expect, it } from 'vitest';
import { defaultSiteUrl } from '../default-site-url';

describe('defaultSiteUrl', () => {
  it('uses the http(s) origin the Studio is served from', () => {
    expect(defaultSiteUrl('https://studio.lumibase.dev')).toBe('https://studio.lumibase.dev');
    expect(defaultSiteUrl('http://localhost:2026')).toBe('http://localhost:2026');
  });

  it('falls back when the origin is not http(s)', () => {
    expect(defaultSiteUrl('tauri://localhost')).toBe('http://localhost:2026');
    expect(defaultSiteUrl('null')).toBe('http://localhost:2026');
    expect(defaultSiteUrl(undefined)).toBe('http://localhost:2026');
  });
});
