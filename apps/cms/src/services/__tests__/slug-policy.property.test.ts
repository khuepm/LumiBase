import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkSlug,
  codePointLength,
  compileSlugPattern,
  slugify,
  type SlugPolicy,
} from '@lumibase/contracts/field';

/**
 * #751 — slug charset policy. Property tests: slugify is idempotent, its
 * output always satisfies its own charset, and the custom-pattern matcher
 * agrees with the native regex engine on the safe subset while staying
 * linear on inputs that make backtracking engines explode.
 */

const policyArb: fc.Arbitrary<SlugPolicy> = fc.record({
  charset: fc.constantFrom('ascii', 'unicode') as fc.Arbitrary<'ascii' | 'unicode'>,
  lowercase: fc.boolean(),
  separator: fc.constantFrom('-', '_', '.') as fc.Arbitrary<'-' | '_' | '.'>,
});

// Mix plain ASCII, Vietnamese, CJK, emoji, combining marks, punctuation.
const textArb = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc
    .array(
      fc.constantFrom(
        'Tiếng', 'Việt', 'Đà', 'Nẵng', 'Phở', 'ưu', 'ơi', 'Ă', 'İstanbul', 'Straße', 'Œuvre',
        '東京', 'Ελλάδα', 'ΣΟΦΟΣ', '😀', 'á', ' ', '--', '__', '..', '/', '!', '9',
      ),
      { maxLength: 12 },
    )
    .map((xs) => xs.join(' ')),
);

describe('slugify — properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(textArb, policyArb, (text, policy) => {
        const once = slugify(text, policy);
        expect(slugify(once, policy)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('output is empty or satisfies its own charset', () => {
    fc.assert(
      fc.property(textArb, policyArb, (text, policy) => {
        const out = slugify(text, policy);
        if (out !== '') expect(checkSlug(out, policy)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it('ascii output contains only [A-Za-z0-9] and the separator', () => {
    fc.assert(
      fc.property(textArb, policyArb, (text, policy) => {
        const out = slugify(text, { ...policy, charset: 'ascii' });
        expect(/^[A-Za-z0-9._-]*$/.test(out)).toBe(true);
        if (policy.lowercase) expect(out).toBe(out.toLowerCase());
      }),
      { numRuns: 500 },
    );
  });

  it('respects maxLength in code points and stays idempotent', () => {
    fc.assert(
      fc.property(textArb, policyArb, fc.integer({ min: 1, max: 20 }), (text, policy, max) => {
        const out = slugify(text, policy, { maxLength: max });
        expect(codePointLength(out)).toBeLessThanOrEqual(max);
        expect(slugify(out, policy, { maxLength: max })).toBe(out);
      }),
      { numRuns: 300 },
    );
  });
});

describe('slugify — Vietnamese and fixed cases', () => {
  it.each([
    ['Tiếng Việt', 'tieng-viet'],
    ['Đà Nẵng', 'da-nang'],
    ['Phở bò & Bún chả', 'pho-bo-bun-cha'],
    ['Người Việt ở nước ngoài', 'nguoi-viet-o-nuoc-ngoai'],
    ['ĐƯỜNG HỒ CHÍ MINH', 'duong-ho-chi-minh'],
    ['Thành phố Hồ Chí Minh 2026', 'thanh-pho-ho-chi-minh-2026'],
    ['Straße', 'strasse'],
    ['İstanbul', 'istanbul'],
    ['  --Hello,  World!--  ', 'hello-world'],
  ])('ascii: %s → %s', (input, expected) => {
    expect(slugify(input, { charset: 'ascii' })).toBe(expected);
  });

  it('default policy (no slug option) is ascii/lowercase/-', () => {
    expect(slugify('Tiếng Việt')).toBe('tieng-viet');
  });

  it('honours separator and lowercase', () => {
    expect(slugify('Tiếng Việt', { charset: 'ascii', separator: '_', lowercase: false })).toBe('Tieng_Viet');
  });

  it('unicode keeps letters of every script (NFC)', () => {
    expect(slugify('Tiếng Việt', { charset: 'unicode' })).toBe('tiếng-việt');
    expect(slugify('Tiếng', { charset: 'unicode' })).toBe('tiếng');
    expect(slugify('東京 タワー!', { charset: 'unicode' })).toBe('東京-タワー');
  });

  it('checkSlug flags non-NFC unicode slugs', () => {
    expect(checkSlug('tiếng', { charset: 'unicode' })).toMatch(/NFC/);
  });
});

describe('custom slug pattern — linear-time matcher', () => {
  const safePatterns = [
    '^[a-z0-9]+$',
    '[a-z]{2}/[a-z0-9-]+',
    '\\d{4}-\\d{2}-[a-z-]*',
    '[\\p{L}\\p{N}-]+',
    'post_?[0-9]{1,5}',
    '[^/ ]+\\.html',
  ];

  it.each(safePatterns)('agrees with the native engine for %s', (pattern) => {
    const compiled = compileSlugPattern(pattern);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
    const native = new RegExp(`^(?:${body})$`, 'u');
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 20 }),
          fc.stringMatching(new RegExp(`^(?:${body})$`)).filter((s) => s.length < 40),
        ),
        (value) => {
          expect(compiled.test(value)).toBe(native.test(value));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('stays fast on adversarial input', () => {
    // a*a*a*a*a*b against "aaaa…" is polynomial for backtracking engines.
    const compiled = compileSlugPattern('a*a*a*a*a*a*a*a*b');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const value = 'a'.repeat(5_000);
    const t0 = performance.now();
    expect(compiled.test(value)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('accepts leading ^ / trailing $ and implies full match', () => {
    const c = compileSlugPattern('[a-z]+');
    expect(c.ok && c.test('abc')).toBe(true);
    expect(c.ok && c.test('abc1')).toBe(false);
  });

  it('accepts escaped punctuation like \\- and \\.', () => {
    const c = compileSlugPattern('[a-z]+\\-[a-z]+\\.x');
    expect(c.ok).toBe(true);
    expect(c.ok && c.test('ab-cd.x')).toBe(true);
  });
});
