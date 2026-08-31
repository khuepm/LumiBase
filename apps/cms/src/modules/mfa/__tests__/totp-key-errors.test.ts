import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from '@lumibase/runtime';
import type { CacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { beginTotpSetup, verifyUserTotpCode, TotpError } from '../totp-service';

/**
 * A missing encryption key used to escape as a plain `Error`, which the global
 * boundary turned into `500 INTERNAL` on every 2FA path — enrollment, login
 * verification, disable and recovery-code regeneration alike. Fail-closed was
 * correct (no seed is ever handled in plaintext) but the response told neither
 * the user nor the operator that `ENCRYPTION_KEY` was the problem, and a
 * rotation that retired an old key left enrolled users unable to remove the
 * dead factor.
 *
 * These tests pin the two typed codes. They fail if the translation in
 * `withKeyErrors` is removed, which is what would silently restore the 500s.
 * See issue #429 and `docs/en/operations/encryption-keys.md`.
 */

const KEK = Buffer.alloc(32, 7).toString('base64');

/** Minimal stand-in for the one query shape `loadCredential` issues. */
function dbReturning(rows: unknown[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  } as unknown as Database;
}

const noopCache = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
} as unknown as CacheProvider;

describe('TOTP key availability surfaces as a typed error', () => {
  it('enrollment with no key configured reports ENCRYPTION_NOT_CONFIGURED', async () => {
    const noKeys = new EnvKeyProvider(new Map(), 'v0');

    const err = await beginTotpSetup(
      dbReturning([]),
      noopCache,
      noKeys,
      'user_1',
      'admin@example.com',
      'LumiBase',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TotpError);
    expect((err as TotpError).code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect((err as TotpError).message).toMatch(/ENCRYPTION_KEY/);
  });

  it('verifying a code whose key was retired reports TFA_KEY_UNAVAILABLE', async () => {
    // Enrolled under `v9`; the deployment now only configures `v0` — the shape
    // left behind by rotating and dropping the old key.
    const rotatedKeys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
    const db = dbReturning([
      {
        userId: 'user_1',
        secretCiphertext: 'v9:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        secretKeyId: 'v9',
        digits: 6,
        periodSeconds: 30,
        lastUsedStep: null,
        verifiedAt: new Date(),
      },
    ]);

    const err = await verifyUserTotpCode(db, rotatedKeys, 'user_1', '123456').catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TotpError);
    expect((err as TotpError).code).toBe('TFA_KEY_UNAVAILABLE');
    // The message has to name the key id, otherwise the operator cannot tell
    // which key to restore.
    expect((err as TotpError).message).toContain('v9');
    expect((err as TotpError).message).toMatch(/recovery code/i);
  });

  it('leaves an unrelated failure alone rather than mislabelling it', async () => {
    const keys = {
      getActiveKey: async () => {
        throw new Error('redis exploded');
      },
      getKey: async () => KEK,
      listKeys: async () => [],
    } as unknown as EnvKeyProvider;

    const err = await beginTotpSetup(
      dbReturning([]),
      noopCache,
      keys,
      'user_1',
      'admin@example.com',
      'LumiBase',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TotpError);
    expect((err as Error).message).toBe('redis exploded');
  });
});
