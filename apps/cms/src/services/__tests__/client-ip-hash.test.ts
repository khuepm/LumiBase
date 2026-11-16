import { describe, expect, it } from 'vitest';
import { clientHashSecret, hashClientIdentifier } from '../client-ip-hash';

/** #564: refusal counters and audit rows carry this hash, never the IP. */
describe('hashClientIdentifier', () => {
  const HEX16 = /^[0-9a-f]{16}$/;

  it('returns 16 lowercase hex characters and is stable for the same input', async () => {
    const a = await hashClientIdentifier('site_1', '203.0.113.7', 'secret');
    expect(a).toMatch(HEX16);
    expect(await hashClientIdentifier('site_1', '203.0.113.7', 'secret')).toBe(a);
  });

  it('differs across sites, secrets and address families', async () => {
    const base = await hashClientIdentifier('site_1', '203.0.113.7', 'secret');
    expect(await hashClientIdentifier('site_2', '203.0.113.7', 'secret')).not.toBe(base);
    expect(await hashClientIdentifier('site_1', '203.0.113.7', 'other-secret')).not.toBe(base);
    expect(await hashClientIdentifier('site_1', '2001:db8::7', 'secret')).not.toBe(base);
  });

  it('never contains the input', async () => {
    const hash = await hashClientIdentifier('site_1', '203.0.113.7', 'secret');
    expect(hash).not.toContain('203');
    expect(hash).not.toContain('site_1');
  });

  it('still hashes (with the development key) when there is no secret', async () => {
    const unkeyed = await hashClientIdentifier('site_1', '203.0.113.7', null);
    expect(unkeyed).toMatch(HEX16);
    expect(unkeyed).not.toBe(await hashClientIdentifier('site_1', '203.0.113.7', 'secret'));
  });
});

describe('clientHashSecret', () => {
  it('prefers the binding, then process.env, else null', () => {
    const saved = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = 'from-process';
      expect(clientHashSecret({ JWT_SECRET: 'from-binding' })).toBe('from-binding');
      expect(clientHashSecret({})).toBe('from-process');
      delete process.env.JWT_SECRET;
      expect(clientHashSecret(undefined)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = saved;
    }
  });
});
