import { describe, expect, it } from 'vitest';
import { expectedVersionsFrom, formatItemEtag, parseIfMatch } from '../item-etag';

/**
 * **Validates: content-environments Req 6.1-6.3** — strong ETag format and
 * RFC 9110 `If-Match` parsing (strong comparison; weak tags never match).
 */
describe('item ETag', () => {
  it('formats the version as a strong quoted tag', () => {
    expect(formatItemEtag(0)).toBe('"0"');
    expect(formatItemEtag(42)).toBe('"42"');
  });

  it('absent or blank header means no precondition', () => {
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch(null)).toBeNull();
    expect(parseIfMatch('   ')).toBeNull();
    expect(expectedVersionsFrom(parseIfMatch(undefined))).toBeUndefined();
  });

  it('`*` accepts any current version', () => {
    expect(parseIfMatch(' * ')).toEqual({ any: true });
    expect(expectedVersionsFrom(parseIfMatch('*'))).toBeUndefined();
  });

  it('parses one or more strong tags', () => {
    expect(expectedVersionsFrom(parseIfMatch('"3"'))).toEqual([3]);
    expect(expectedVersionsFrom(parseIfMatch('"3", "7"'))).toEqual([3, 7]);
  });

  it('weak and malformed tags never match', () => {
    // An empty list is a precondition that can never be met → 412, not a bypass.
    expect(expectedVersionsFrom(parseIfMatch('W/"3"'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('3'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('"abc"'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('"-1"'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('"01"'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('"99999999999"'))).toEqual([]);
    expect(expectedVersionsFrom(parseIfMatch('W/"3", "4"'))).toEqual([4]);
  });
});
