import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGINS_METADATA_KEY,
  PUBLISHABLE_TOKEN_PREFIX,
  checkOrigin,
  isPublishablePrefix,
  normalizeOrigin,
  readAllowedOrigins,
  screenPolicyForPublishableKey,
} from '../api-key-publishable';
import { createPlaintextToken } from '../api-key-token';

describe('publishable token minting', () => {
  it('marks a publishable token in its prefix', async () => {
    const token = await createPlaintextToken({ publishable: true });
    expect(token.token.startsWith(PUBLISHABLE_TOKEN_PREFIX)).toBe(true);
    expect(isPublishablePrefix(token.prefix)).toBe(true);
  });

  it('keeps the bare lbk_ prefix for secret keys so existing tokens stay valid', async () => {
    const token = await createPlaintextToken();
    expect(token.token.startsWith('lbk_')).toBe(true);
    expect(isPublishablePrefix(token.prefix)).toBe(false);
  });

  it('does not classify a secret token as publishable by coincidence', async () => {
    // 32 random bytes; a secret prefix is `lbk_` + 12 base64url chars and can
    // never begin `lbk_pub_` because the marker is part of the literal prefix.
    for (let i = 0; i < 50; i += 1) {
      const token = await createPlaintextToken();
      expect(isPublishablePrefix(token.prefix)).toBe(false);
    }
  });

  it('stores a prefix short enough to be non-authenticating', async () => {
    const token = await createPlaintextToken({ publishable: true });
    expect(token.prefix).toHaveLength(16);
    expect(token.token.length).toBeGreaterThan(token.prefix.length);
  });
});

describe('isPublishablePrefix', () => {
  it.each([null, undefined, '', 'lbk_abc', 'pub_lbk_x', 'LBK_PUB_x'])(
    'rejects %p',
    (value) => {
      expect(isPublishablePrefix(value as string | null | undefined)).toBe(false);
    },
  );
});

describe('normalizeOrigin', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['https://example.com/some/path?q=1', 'https://example.com'],
    ['https://EXAMPLE.com', 'https://example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://example.com:443', 'https://example.com'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each(['', '   ', 'example.com', 'not a url', '//example.com'])(
    'returns null for the unparseable %p',
    (input) => {
      expect(normalizeOrigin(input)).toBeNull();
    },
  );
});

describe('readAllowedOrigins', () => {
  it('reads and normalises the stored list', () => {
    expect(
      readAllowedOrigins({ [ALLOWED_ORIGINS_METADATA_KEY]: ['https://a.com/', 'https://B.com'] }),
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  it('drops unparseable entries rather than treating them as a wildcard', () => {
    expect(
      readAllowedOrigins({ [ALLOWED_ORIGINS_METADATA_KEY]: ['https://a.com', 'nonsense', 42] }),
    ).toEqual(['https://a.com']);
  });

  it.each([null, undefined, {}, 'string', { [ALLOWED_ORIGINS_METADATA_KEY]: 'https://a.com' }])(
    'returns an empty list for %p',
    (metadata) => {
      expect(readAllowedOrigins(metadata)).toEqual([]);
    },
  );
});

describe('checkOrigin', () => {
  const allowed = ['https://app.example.com'];

  it('reports no constraint when the allowlist is empty', () => {
    expect(checkOrigin('https://anywhere.test', null, [])).toBe('no_constraint');
  });

  it('allows a matching Origin', () => {
    expect(checkOrigin('https://app.example.com', null, allowed)).toBe('allowed');
  });

  it('allows a matching Origin regardless of case or trailing slash', () => {
    expect(checkOrigin('https://APP.example.com/', null, allowed)).toBe('allowed');
  });

  it('denies a non-matching Origin — the case the control exists for', () => {
    expect(checkOrigin('https://evil.test', null, allowed)).toBe('denied');
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(checkOrigin(null, 'https://app.example.com/page', allowed)).toBe('allowed');
    expect(checkOrigin(null, 'https://evil.test/page', allowed)).toBe('denied');
  });

  it('prefers Origin over Referer when both are present', () => {
    expect(checkOrigin('https://evil.test', 'https://app.example.com', allowed)).toBe('denied');
  });

  it('reports absent when neither header is usable', () => {
    // Treated as allowed by callers: a non-browser client sends no Origin and
    // could set any value anyway, so rejecting adds no security.
    expect(checkOrigin(null, null, allowed)).toBe('absent');
    expect(checkOrigin('', 'garbage', allowed)).toBe('absent');
  });
});

describe('screenPolicyForPublishableKey', () => {
  it('refuses adminAccess', () => {
    expect(screenPolicyForPublishableKey({ adminAccess: true })).toEqual(['adminAccess']);
  });

  it('refuses appAccess', () => {
    expect(screenPolicyForPublishableKey({ appAccess: true })).toEqual(['appAccess']);
  });

  it('reports both flags together', () => {
    expect(screenPolicyForPublishableKey({ adminAccess: true, appAccess: true })).toEqual([
      'adminAccess',
      'appAccess',
    ]);
  });

  it('passes a least-privilege policy', () => {
    expect(screenPolicyForPublishableKey({ adminAccess: false, appAccess: false })).toEqual([]);
    expect(screenPolicyForPublishableKey({})).toEqual([]);
  });
});
