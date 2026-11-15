import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  intentActionFromPathname,
  isIntentPathname,
  loginUrlForIntent,
  sanitizeIntentReturnTo,
  toSafeInternalPath,
} from '../paths';
import { getAdminBase, withAdminPrefix } from '@/lib/admin-base';

describe('intent pathnames', () => {
  it.each([
    ['/intent/edit', true],
    ['/intent/open/', true],
    ['/lumi-7f3a9c/intent/create', true],
    ['/intent/delete', false],
    ['/intent/edit/extra', false],
    ['/content/intent/edit', false],
  ])('%s → %s', (pathname, expected) => {
    expect(isIntentPathname(pathname)).toBe(expected);
  });

  it('reads the action segment', () => {
    expect(intentActionFromPathname('/lumi-7f3a9c/intent/edit')).toBe('edit');
    expect(intentActionFromPathname('/content/x')).toBeNull();
  });

  it('treats `intent` as a module segment, not an admin path', () => {
    expect(getAdminBase('/intent/edit')).toBe('');
    expect(withAdminPrefix('/intent/edit', '/lumi-7f3a9c')).toBe('/lumi-7f3a9c/intent/edit');
  });
});

describe('open-redirect refusal', () => {
  it.each([
    'https://evil.example/intent/edit',
    '//evil.example/intent/edit',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/intent/edit#frag',
    '/intent/../../evil',
    '/intent/edit?\nx=1',
    '',
  ])('rejects %j', (candidate) => {
    expect(toSafeInternalPath(candidate)).toBeNull();
    expect(sanitizeIntentReturnTo(candidate)).toBeNull();
  });

  it('only lets intent paths through the login return-to', () => {
    expect(sanitizeIntentReturnTo('/intent/edit?collection=posts&id=p1')).toBe('/intent/edit?collection=posts&id=p1');
    expect(sanitizeIntentReturnTo('/settings/security')).toBeNull();
    expect(sanitizeIntentReturnTo('/intent/delete?collection=x')).toBeNull();
    expect(toSafeInternalPath('/settings/security')).toBe('/settings/security');
  });

  it('property: an accepted path always resolves on the same origin and starts with a single slash', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const safe = toSafeInternalPath(s);
        if (safe === null) return;
        expect(safe.startsWith('/')).toBe(true);
        expect(safe.startsWith('//')).toBe(false);
        expect(new URL(safe, 'https://origin.test').origin).toBe('https://origin.test');
      }),
    );
  });

  it('property: arbitrary prefixes in front of an intent never pass the return-to check', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('https://evil.test', '//evil.test', 'http:', '/\\evil', 'data:text/html,'),
        (prefix) => {
          expect(sanitizeIntentReturnTo(`${prefix}/intent/edit?collection=posts&id=p1`)).toBeNull();
        },
      ),
    );
  });
});

describe('loginUrlForIntent', () => {
  it('keeps the intent as an encoded admin-relative next', () => {
    expect(
      loginUrlForIntent('/lumi-7f3a9c', '/lumi-7f3a9c/intent/edit', '?collection=posts&id=p1&field=title'),
    ).toBe(`/lumi-7f3a9c/login?next=${encodeURIComponent('/intent/edit?collection=posts&id=p1&field=title')}`);
  });

  it('falls back to the bare login page for an unsafe query and needs an admin base', () => {
    expect(loginUrlForIntent('/lumi-7f3a9c', '/lumi-7f3a9c/intent/edit', '?a=1#x')).toBe('/lumi-7f3a9c/login');
    expect(loginUrlForIntent('', '/intent/edit', '?collection=posts')).toBeNull();
  });
});
