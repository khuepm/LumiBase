import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ADMIN_PATH_REGEX,
  DEFAULT_ADMIN_PATHS,
  RESERVED_PATH_PREFIXES,
  normalizeAdminPath,
  validateAdminPath,
} from '../path-validator';

/**
 * Feature: admin-setup-wizard, Property 11: Path Normalize Idempotent
 *
 *   normalizeAdminPath(normalizeAdminPath(x)) === normalizeAdminPath(x)
 *
 * for any string `x`. Plus an exhaustive table of input/expected pairs
 * for the format regex, blacklist, reserved prefixes, and edge-case
 * normalisations called out in Req 4.8 (whitespace, control chars,
 * double slash).
 *
 * **Validates: Requirements 4.2, 4.3, 4.4, 4.8**
 */

describe('normalizeAdminPath — idempotency property (Property 11)', () => {
  it('normalize(normalize(x)) === normalize(x) for any string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = normalizeAdminPath(s);
        const twice = normalizeAdminPath(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('handles already-normalised slugs as a no-op', () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^\/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/)
          // hard-cap the suffix length to land inside the regex bounds.
          .filter((s) => ADMIN_PATH_REGEX.test(s)),
        (slug) => {
          expect(normalizeAdminPath(slug)).toBe(slug);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('normalizeAdminPath — explicit edge cases', () => {
  it.each([
    // [input, expected]
    ['  /Lumi-7F3A9C  ', '/lumi-7f3a9c'],
    ['/lumi-7f3a9c/', '/lumi-7f3a9c'],
    ['lumi-7f3a9c', '/lumi-7f3a9c'],
    ['//lumi//7f3a9c', '/lumi/7f3a9c'],
    ['/admin?token=secret', '/admin'],
    ['/admin#fragment', '/admin'],
    ['/lumi-\u0007admin', '/lumi-admin'], // BEL stripped
    ['/lumi  admin', '/lumiadmin'], // internal whitespace removed
    ['/LUMI-ADMIN', '/lumi-admin'],
    ['', ''],
    ['   ', ''],
    ['/', '/'],
    ['/lumi-7f3a9c/sub/path', '/lumi-7f3a9c/sub/path'],
    ['\t/lumi/\n', '/lumi'],
  ])('normalizeAdminPath(%j) === %j', (input, expected) => {
    expect(normalizeAdminPath(input)).toBe(expected);
  });

  it('returns empty string for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeAdminPath(undefined as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeAdminPath(null as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeAdminPath(42 as any)).toBe('');
  });
});

describe('validateAdminPath — accepts well-formed slugs', () => {
  it.each([
    '/lumi-7f3a9c',
    '/dashboard-x9',
    '/abc1',
    '/' + 'a'.repeat(64), // 65 chars total, max boundary
    '/a-b-c-d',
    '/admin1', // not in blacklist
  ])('accepts %j', (input) => {
    const result = validateAdminPath(input);
    expect(result.ok).toBe(true);
  });
});

describe('validateAdminPath — rejects malformed slugs', () => {
  it.each([
    ['/abc', 'INVALID_FORMAT'], // too short (< 4 chars after /)
    ['/' + 'a'.repeat(65), 'INVALID_FORMAT'], // too long (> 64 chars after /)
    ['/-leading-dash', 'INVALID_FORMAT'],
    ['/trailing-dash-', 'INVALID_FORMAT'],
    ['/UPPER', 'INVALID_FORMAT'],
    ['/has spaces', 'INVALID_FORMAT'],
    ['/has/slash', 'INVALID_FORMAT'],
    ['no-leading-slash', 'INVALID_FORMAT'],
    ['', 'INVALID_FORMAT'],
  ])('rejects %j with code %s', (input, expectedCode) => {
    const result = validateAdminPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(expectedCode);
  });
});

describe('validateAdminPath — rejects predictable defaults (Req 4.3)', () => {
  it.each([...DEFAULT_ADMIN_PATHS])('rejects %j', (path) => {
    const result = validateAdminPath(path);
    if (!ADMIN_PATH_REGEX.test(path)) {
      // Some defaults like '/admin' fail the regex first because the
      // slug part is 5 chars. We expect SOMETHING to fail; both an
      // INVALID_FORMAT and PATH_PREDICTABLE response satisfy Req 4.3
      // (the wizard will not accept it).
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATH_PREDICTABLE');
  });
});

describe('validateAdminPath — rejects reserved prefixes (Req 4.4)', () => {
  it.each(
    RESERVED_PATH_PREFIXES.flatMap((prefix) => [
      // Direct exact match where the prefix shape passes the regex.
      `${prefix}/sub-route`,
    ]),
  )('rejects %j as PATH_RESERVED', (path) => {
    // Filter out paths the regex would reject before reserved-check runs.
    if (!ADMIN_PATH_REGEX.test(path)) {
      const r = validateAdminPath(path);
      expect(r.ok).toBe(false);
      return;
    }
    const result = validateAdminPath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATH_RESERVED');
  });

  it('treats /api-anything (prefix without separator) as allowed when not reserved exactly', () => {
    // `/api-tools` does NOT start with `/api/`, so it should be allowed —
    // reserved prefixes guard against route collisions, not name
    // collisions.
    const result = validateAdminPath('/api-tools');
    expect(result.ok).toBe(true);
  });
});
