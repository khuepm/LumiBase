import { describe, it, expect } from 'vitest';
import { buildAdminLoginUrl, joinAdminPathLogin } from '../step-done';

/**
 * Unit tests for the pure `joinAdminPathLogin` helper used by the Done
 * step of the Setup Wizard.
 *
 * The helper is responsible for producing a URL the bootstrap admin
 * can actually click — `${normalisedAdminPath}/login` — without
 * accidentally building a protocol-relative URL (`//foo/login`) or a
 * doubled slash (`/foo//login`).
 *
 * Spec refs: requirements §4.5; design.md §5.4.
 */

describe('joinAdminPathLogin', () => {
  it('appends /login to a canonical path', () => {
    expect(joinAdminPathLogin('/lumi-7f3a9c')).toBe('/lumi-7f3a9c/login');
  });

  it('drops a trailing slash before appending /login', () => {
    expect(joinAdminPathLogin('/lumi-7f3a9c/')).toBe('/lumi-7f3a9c/login');
  });

  it('rejects a malformed path after collapsing multiple leading slashes', () => {
    // Without normalisation the browser would treat `//host/login` as a
    // protocol-relative URL pointing at `host` — a real hijack risk if
    // a future store migration ever stored a malformed path.
    expect(joinAdminPathLogin('//evil.example')).toBeNull();
  });

  it('trims surrounding whitespace before processing', () => {
    expect(joinAdminPathLogin('  /lumi-7f3a9c  ')).toBe('/lumi-7f3a9c/login');
  });

  it('rejects an empty input', () => {
    expect(joinAdminPathLogin('')).toBeNull();
  });

  it('rejects a whitespace-only input', () => {
    expect(joinAdminPathLogin('   ')).toBeNull();
  });

  it('rejects an input that is only slashes', () => {
    expect(joinAdminPathLogin('//')).toBeNull();
  });

  it('handles a path without a leading slash', () => {
    // The CMS schema guarantees the leading slash, but we are defensive
    // — a client-only consumer of the helper shouldn't have to know
    // that contract.
    expect(joinAdminPathLogin('lumi-7f3a9c')).toBe('/lumi-7f3a9c/login');
  });

  it('preserves valid hyphens and digits in the slug', () => {
    expect(joinAdminPathLogin('/admin-panel-42')).toBe('/admin-panel-42/login');
  });

  it('builds the full absolute login URL from origin and admin path', () => {
    expect(buildAdminLoginUrl('/lumi-7f3a9c', 'http://127.0.0.1:5174')).toBe(
      'http://127.0.0.1:5174/lumi-7f3a9c/login',
    );
  });
});
