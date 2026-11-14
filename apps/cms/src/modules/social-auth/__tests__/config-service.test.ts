import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { SocialProviderConfigService } from '../config-service';
import { SocialAuthError } from '../errors';
import { makeAppleKey } from './fixtures';

const KEK = Buffer.alloc(32, 9).toString('base64');
const keys = () => new EnvKeyProvider(new Map([['v1', KEK]]), 'v1');

/**
 * Single-row fake: every test touches one provider of one site, so the row
 * store needs no predicate evaluation. Captures what is written.
 */
function fakeDb() {
  let row: Record<string, unknown> | undefined;
  const chain = (result: () => unknown) => {
    const p = {
      where: () => p,
      limit: () => p,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return p;
  };
  const db = {
    select: () => ({ from: () => chain(() => (row ? [row] : [])) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            row = row ? { ...row, ...set } : { id: 'cfg_1', createdAt: new Date(), ...v };
            return [row];
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          const had = !!row;
          row = undefined;
          return had ? [{ id: 'cfg_1' }] : [];
        },
      }),
    }),
  };
  return { db: db as unknown as Database, stored: () => row };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SocialAuthError);
    return (err as SocialAuthError).code;
  }
  throw new Error('expected rejection');
}

describe('SocialProviderConfigService', () => {
  it('stores the client secret only as a KeyProvider envelope and never returns it', async () => {
    const { db, stored } = fakeDb();
    const svc = new SocialProviderConfigService(db, keys(), 'site_a');
    const { view, changed } = await svc.upsert('google', {
      enabled: true,
      clientId: 'g-client',
      clientSecret: 'super-secret-value',
      allowedRedirectUris: ['https://app.example.com/cb'],
    });
    expect(view).toMatchObject({ provider: 'google', enabled: true, clientId: 'g-client', hasClientSecret: true });
    expect(JSON.stringify(view)).not.toContain('super-secret-value');
    expect(changed).toContain('clientSecret');
    const ciphertext = stored()!.clientSecretCiphertext as string;
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(ciphertext).not.toContain('super-secret-value');

    const runtime = await svc.runtime('google');
    expect(runtime?.config.clientSecret).toBe('super-secret-value');
    expect(runtime?.allowedRedirectUris).toEqual(['https://app.example.com/cb']);
  });

  it('binds the envelope to its site: a row copied to another site does not decrypt', async () => {
    const { db } = fakeDb();
    await new SocialProviderConfigService(db, keys(), 'site_a').upsert('github', {
      enabled: true,
      clientId: 'id',
      clientSecret: 's3cret',
      allowedRedirectUris: ['https://a.io/cb'],
    });
    expect(await code(new SocialProviderConfigService(db, keys(), 'site_b').runtime('github'))).toBe('SOCIAL_PROVIDER_KEY_UNAVAILABLE');
  });

  it('keeps the stored secret when an update omits it', async () => {
    const { db } = fakeDb();
    const svc = new SocialProviderConfigService(db, keys(), 'site_a');
    await svc.upsert('github', { clientId: 'id', clientSecret: 'first', allowedRedirectUris: ['https://a.io/cb'] });
    const { changed } = await svc.upsert('github', { enabled: true, clientId: 'id2', allowedRedirectUris: ['https://a.io/cb'] });
    expect(changed).not.toContain('clientSecret');
    expect((await svc.runtime('github'))?.config).toMatchObject({ clientId: 'id2', clientSecret: 'first' });
  });

  it('refuses to enable an incomplete provider', async () => {
    const svc = new SocialProviderConfigService(fakeDb().db, keys(), 'site_a');
    expect(await code(svc.upsert('google', { enabled: true, clientId: 'x', allowedRedirectUris: ['https://a.io/cb'] }))).toBe(
      'PROVIDER_INCOMPLETE',
    );
    expect(await code(svc.upsert('google', { enabled: true, clientId: 'x', clientSecret: 'y' }))).toBe('PROVIDER_INCOMPLETE');
  });

  it('rejects a wildcard / non-https redirect entry', async () => {
    const svc = new SocialProviderConfigService(fakeDb().db, keys(), 'site_a');
    expect(await code(svc.upsert('google', { clientId: 'x', allowedRedirectUris: ['https://*.a.io/cb'] }))).toBe('INVALID_REDIRECT_URI');
    expect(await code(svc.upsert('google', { clientId: 'x', allowedRedirectUris: ['http://a.io/cb'] }))).toBe('INVALID_REDIRECT_URI');
  });

  it('Apple: validates and seals the .p8 key; runtime yields team/key ids', async () => {
    const { db, stored } = fakeDb();
    const svc = new SocialProviderConfigService(db, keys(), 'site_a');
    expect(
      await code(svc.upsert('apple', { clientId: 'com.ex.web', appleTeamId: 'T', appleKeyId: 'K', applePrivateKey: 'nope' })),
    ).toBe('INVALID_APPLE_KEY');
    const key = await makeAppleKey();
    await svc.upsert('apple', {
      enabled: true,
      clientId: 'com.ex.web',
      appleTeamId: 'TEAM',
      appleKeyId: 'KEY',
      applePrivateKey: key.pem,
      allowedRedirectUris: ['https://a.io/cb'],
    });
    expect(String(stored()!.applePrivateKeyCiphertext)).not.toContain('PRIVATE KEY');
    expect(stored()!.clientSecretCiphertext).toBeNull();
    const runtime = await svc.runtime('apple');
    expect(runtime?.config.apple).toMatchObject({ teamId: 'TEAM', keyId: 'KEY', privateKeyPem: key.pem });
  });

  it('reports ENCRYPTION_NOT_CONFIGURED when no key exists', async () => {
    const noKeys = new EnvKeyProvider(new Map(), 'v1');
    const svc = new SocialProviderConfigService(fakeDb().db, noKeys, 'site_a');
    expect(await code(svc.upsert('google', { clientId: 'x', clientSecret: 'y' }))).toBe('ENCRYPTION_NOT_CONFIGURED');
  });

  it('returns null runtime for a disabled provider', async () => {
    const { db } = fakeDb();
    const svc = new SocialProviderConfigService(db, keys(), 'site_a');
    await svc.upsert('google', { clientId: 'x', clientSecret: 'y', allowedRedirectUris: [] });
    expect(await svc.runtime('google')).toBeNull();
  });
});
