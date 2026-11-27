import { scrypt as nodeScrypt } from 'node:crypto';
import { scrypt as scryptJs } from '@noble/hashes/scrypt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashPassword,
  passwordNeedsRehash,
  SCRYPT_PARAMS,
  targetPasswordPolicy,
  verifyPassword,
} from '../password';

/**
 * B230: a portable, memory-hard KDF (scrypt) for new password hashes, and no
 * lockout when a database hashed on Node/Docker is served by Workers.
 */

const onWorkers = () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
afterEach(() => vi.unstubAllGlobals());

describe('scrypt password hashes (B230)', () => {
  it('hashes in the documented format and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse', { scheme: 'scrypt', ...SCRYPT_PARAMS });
    const parts = hash.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '3']);
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('native Node scrypt and the portable implementation agree byte for byte', async () => {
    const salt = new Uint8Array(16).fill(7);
    const params = { N: 2 ** 12, r: 8, p: 1 };
    const native = await new Promise<Buffer>((resolve, reject) =>
      nodeScrypt('pw', salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))));
    const js = scryptJs(new TextEncoder().encode('pw'), salt, { ...params, dkLen: 32 });
    expect(Buffer.from(js).toString('hex')).toBe(native.toString('hex'));
  });

  it('a hash made on Node verifies on Workers (portable path)', async () => {
    const hash = await hashPassword('portable', { scheme: 'scrypt', N: 2 ** 12, r: 8, p: 1 });
    onWorkers();
    expect(await verifyPassword('portable', hash)).toBe(true);
    expect(await verifyPassword('nope', hash)).toBe(false);
  });

  it('refuses forged parameters instead of burning memory', async () => {
    const salt = '00'.repeat(16);
    const hash = '00'.repeat(32);
    for (const params of ['3$8$1', `${2 ** 21}$8$1`, '1024$64$1', '1024$8$99', '0$8$1', 'x$8$1']) {
      expect(await verifyPassword('pw', `scrypt$${params}$${salt}$${hash}`)).toBe(false);
    }
    expect(await verifyPassword('pw', 'scrypt$1024$8$1$zz$00')).toBe(false);
  });
});

describe('PBKDF2 above 100,000 iterations on Workers (B230)', () => {
  it('verifies in JavaScript instead of locking the user out', async () => {
    const hash = await hashPassword('moved to workers', 150_000);
    onWorkers();
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    expect(await verifyPassword('moved to workers', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    // Web Crypto (which refuses > 100,000 on Workers) is not used for it.
    expect(deriveBits).not.toHaveBeenCalled();
  });
});

describe('targetPasswordPolicy', () => {
  it('follows PASSWORD_HASH_SCHEME', () => {
    expect(targetPasswordPolicy({ PASSWORD_HASH_SCHEME: 'pbkdf2' })).toEqual({ scheme: 'pbkdf2', iterations: 100_000 });
    expect(targetPasswordPolicy({ PASSWORD_HASH_SCHEME: 'pbkdf2', PASSWORD_PBKDF2_ITERATIONS: '600000' })).toEqual({ scheme: 'pbkdf2', iterations: 600_000 });
    expect(targetPasswordPolicy({ PASSWORD_HASH_SCHEME: 'scrypt' })).toEqual({ scheme: 'scrypt', ...SCRYPT_PARAMS });
  });

  it('defaults to scrypt on Node and pbkdf2 on Workers', () => {
    expect(targetPasswordPolicy({}).scheme).toBe('scrypt');
    onWorkers();
    expect(targetPasswordPolicy({})).toEqual({ scheme: 'pbkdf2', iterations: 100_000 });
    expect(targetPasswordPolicy({ PASSWORD_HASH_SCHEME: 'scrypt' }).scheme).toBe('scrypt');
  });
});

describe('passwordNeedsRehash across schemes', () => {
  const scrypt = { scheme: 'scrypt' as const, ...SCRYPT_PARAMS };
  it('moves PBKDF2 hashes to scrypt, and weaker scrypt to the target', () => {
    expect(passwordNeedsRehash('pbkdf2$100000$aa$bb', scrypt)).toBe(true);
    expect(passwordNeedsRehash('scrypt$32768$8$3$aa$bb', scrypt)).toBe(false);
    expect(passwordNeedsRehash('scrypt$16384$8$3$aa$bb', scrypt)).toBe(true);
    expect(passwordNeedsRehash('scrypt$32768$8$1$aa$bb', scrypt)).toBe(true);
  });
  it('moves scrypt back to PBKDF2 only when that is the target, and keeps iteration checks', () => {
    expect(passwordNeedsRehash('scrypt$32768$8$3$aa$bb', 100_000)).toBe(true);
    expect(passwordNeedsRehash('pbkdf2$100000$aa$bb', 100_000)).toBe(false);
    expect(passwordNeedsRehash('pbkdf2$100000$aa$bb', 150_000)).toBe(true);
  });
  it('ignores malformed hashes', () => {
    expect(passwordNeedsRehash('scrypt$x$8$3$aa$bb', scrypt)).toBe(false);
    expect(passwordNeedsRehash('bcrypt$whatever', scrypt)).toBe(false);
    expect(passwordNeedsRehash(null, scrypt)).toBe(false);
  });
});
