import { describe, expect, it } from 'vitest';

import { canonicalEmail, emailRoot, isEmailIdentityMode } from '../normalize';
import { EMAIL_ROOT_FIXTURES } from './fixtures';

describe('emailRoot (#794)', () => {
  it.each(EMAIL_ROOT_FIXTURES)('%j → %j', (input, expected) => {
    expect(emailRoot(input)).toBe(expected);
  });

  it('strips +tag on every domain, not only Gmail', () => {
    for (const domain of ['example.com', 'outlook.com', 'fastmail.fm', 'sub.domain.io']) {
      expect(emailRoot(`user+tag@${domain}`)).toBe(`user@${domain}`);
    }
  });

  it('keeps a leading + (local part never empty)', () => {
    expect(emailRoot('+tag@example.com')).toBe('+tag@example.com');
  });

  it('drops dots only for Gmail', () => {
    expect(emailRoot('t.est@gmail.com')).toBe('test@gmail.com');
    expect(emailRoot('t.est@example.com')).toBe('t.est@example.com');
  });

  it('folds googlemail.com to gmail.com', () => {
    expect(emailRoot('t.est+x@googlemail.com')).toBe('test@gmail.com');
  });

  it('only case-folds input without a usable @', () => {
    expect(emailRoot(' NoAt ')).toBe('noat');
    expect(emailRoot(null)).toBe('');
    expect(emailRoot(undefined)).toBe('');
  });

  it('is idempotent', () => {
    for (const [input] of EMAIL_ROOT_FIXTURES) {
      expect(emailRoot(emailRoot(input))).toBe(emailRoot(input));
    }
  });
});

describe('canonicalEmail (#794)', () => {
  it('exact mode only case-folds — aliases stay distinct', () => {
    expect(canonicalEmail(' Test+A@Gmail.com ', 'exact')).toBe('test+a@gmail.com');
    expect(canonicalEmail('t.est@gmail.com', 'exact')).toBe('t.est@gmail.com');
  });

  it('root mode collapses every alias onto the root mailbox', () => {
    const aliases = ['test+a@gmail.com', 'test+b@gmail.com', 't.est@gmail.com', 'TEST@googlemail.com'];
    expect(new Set(aliases.map((a) => canonicalEmail(a, 'root')))).toEqual(new Set(['test@gmail.com']));
  });
});

describe('isEmailIdentityMode', () => {
  it('accepts only exact | root', () => {
    expect(isEmailIdentityMode('exact')).toBe(true);
    expect(isEmailIdentityMode('root')).toBe(true);
    expect(isEmailIdentityMode('strict')).toBe(false);
    expect(isEmailIdentityMode(undefined)).toBe(false);
  });
});
