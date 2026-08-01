import { describe, expect, it } from 'vitest';

import { PasswordSchema, PASSWORD_MIN_LENGTH } from '@lumibase/contracts/schemas';

describe('PasswordSchema (CWE-521) — shared strength policy', () => {
  it('accepts a strong password', () => {
    expect(PasswordSchema.safeParse('CorrectHorseBattery!42').success).toBe(true);
  });

  it('rejects passwords shorter than the minimum length', () => {
    expect(PasswordSchema.safeParse('Ab1!shor').success).toBe(false);
    expect('Ab1!shor'.length).toBeLessThan(PASSWORD_MIN_LENGTH);
  });

  it('rejects the previously-allowed weak 6-char password', () => {
    expect(PasswordSchema.safeParse('abc123').success).toBe(false);
  });

  it('requires each complexity class', () => {
    expect(PasswordSchema.safeParse('alllowercaseletters').success).toBe(false); // no upper/digit/special
    expect(PasswordSchema.safeParse('ALLUPPERCASE12345!').success).toBe(false); // no lowercase
    expect(PasswordSchema.safeParse('NoDigitsHereAtAll!').success).toBe(false); // no digit
    expect(PasswordSchema.safeParse('NoSpecialChars12345').success).toBe(false); // no special
  });
});
