import { describe, it, expect } from 'vitest';
import { joinAdminPathLogin } from '../step-done';

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

  it('collapses multiple leading slashes to a single one', () => {
    // Without normalisation the browser would treat `//host/login` as a
    // protocol-relative URL pointing at `host` — a real hijack risk if
    // a future store migration ever stored a malformed path.
    expect(joinAdminPathLogin('//evil.example')).toBe('/evil.example/login');
  });

  it('trims surrounding whitespace before processing', () => {
    expect(joinAdminPathLogin('  /lumi-7f3a9c  ')).toBe('/lumi-7f3a9c/login');
  });

  it('falls back to /login for an empty input', () => {
    expect(joinAdminPathLogin('')).toBe('/login');
  });

  it('falls back to /login for a whitespace-only input', () => {
    expect(joinAdminPathLogin('   ')).toBe('/login');
  });

  it('falls back to /login for an input that is only slashes', () => {
    expect(joinAdminPathLogin('//')).toBe('/login');
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
});
