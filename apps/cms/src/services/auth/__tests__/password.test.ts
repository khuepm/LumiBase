import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../password';

describe('password helper', () => {
  it('produces canonical pbkdf2$100000$<salt>$<hash> format', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const parts = stored.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('100000');
    // 16-byte salt → 32 hex chars
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    // 32-byte derived hash → 64 hex chars
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a freshly hashed password', async () => {
    const stored = await hashPassword('SuperSecret!42');
    expect(await verifyPassword('SuperSecret!42', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('SuperSecret!42');
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('uses a fresh random salt per hash invocation', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('verifies hashes produced by the legacy inline implementation', async () => {
    // Pre-computed using the previous routes/auth.ts implementation:
    //   password = 'legacy-password'
    //   salt     = 16 bytes of 0xAB
    //   iter     = 100000
    // This locks in binary compatibility with already-stored user hashes.
    const legacyPassword = 'legacy-password';
    const legacySalt = new Uint8Array(16).fill(0xab);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(legacyPassword),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: legacySalt, iterations: 100000, hash: 'SHA-256' },
        key,
        256,
      ),
    );
    const toHex = (b: Uint8Array) =>
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    const stored = `pbkdf2$100000$${toHex(legacySalt)}$${toHex(derived)}`;

    expect(await verifyPassword(legacyPassword, stored)).toBe(true);
    expect(await verifyPassword('not-the-password', stored)).toBe(false);
  });

  it.each([
    '',
    'plaintext',
    'pbkdf2$',
    'pbkdf2$100000$abcd',
    'pbkdf2$abc$ab$cd',
    'argon2$100000$ab$cd',
    'pbkdf2$100000$nothex!!$cd',
    'pbkdf2$100000$ab$',
  ])('returns false for malformed stored hash %j', async (stored) => {
    expect(await verifyPassword('any', stored)).toBe(false);
  });
});
