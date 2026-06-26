import { describe, it, expect, vi } from 'vitest';
import { createCloudflareKeyProvider } from '../adapters/cloudflare/keys';
import { collectKeys, resolveActiveKeyId } from '../adapters/shared-keys';

// Sample base64 AES-256 keys (32 random bytes each).
const KEY_V0 = Buffer.alloc(32, 1).toString('base64');
const KEY_V1 = Buffer.alloc(32, 2).toString('base64');

describe('shared key resolution', () => {
  it('maps the legacy ENCRYPTION_KEY to v0', () => {
    const keys = collectKeys({ ENCRYPTION_KEY: KEY_V0 });
    expect(keys.get('v0')).toBe(KEY_V0);
    expect(resolveActiveKeyId({ ENCRYPTION_KEY: KEY_V0 }, keys)).toBe('v0');
  });

  it('collects versioned keys and ignores *_FILE indirections', () => {
    const env = {
      ENCRYPTION_KEY: KEY_V0,
      ENCRYPTION_KEY_v1: KEY_V1,
      ENCRYPTION_KEY_v1_FILE: '/run/secrets/whatever',
    };
    const keys = collectKeys(env);
    expect(keys.get('v0')).toBe(KEY_V0);
    expect(keys.get('v1')).toBe(KEY_V1);
    expect(keys.size).toBe(2);
  });

  it('honours an explicit active key id', () => {
    const env = { ENCRYPTION_KEY: KEY_V0, ENCRYPTION_KEY_v1: KEY_V1, ENCRYPTION_ACTIVE_KEY_ID: 'v1' };
    const keys = collectKeys(env);
    expect(resolveActiveKeyId(env, keys)).toBe('v1');
  });
});

describe('CloudflareKeyProvider', () => {
  it('resolves the active key and falls back to v0', async () => {
    const provider = createCloudflareKeyProvider({ ENCRYPTION_KEY: KEY_V0 });
    const active = await provider.getActiveKey();
    expect(active).toEqual({ keyId: 'v0', key: KEY_V0 });
  });

  it('resolves keys by id and marks status', async () => {
    const provider = createCloudflareKeyProvider({
      ENCRYPTION_KEY: KEY_V0,
      ENCRYPTION_KEY_v1: KEY_V1,
      ENCRYPTION_ACTIVE_KEY_ID: 'v1',
    });
    expect(await provider.getActiveKey()).toEqual({ keyId: 'v1', key: KEY_V1 });
    expect(await provider.getKey('v0')).toBe(KEY_V0);

    const metas = await provider.listKeys();
    expect(metas).toContainEqual({ keyId: 'v0', algo: 'AES-GCM', status: 'retired' });
    expect(metas).toContainEqual({ keyId: 'v1', algo: 'AES-GCM', status: 'active' });
  });

  it('throws when a key id is not configured', async () => {
    const provider = createCloudflareKeyProvider({ ENCRYPTION_KEY: KEY_V0 });
    await expect(provider.getKey('v9')).rejects.toThrow(/no encryption key configured/);
  });

  it('throws when the active key id has no material', async () => {
    const provider = createCloudflareKeyProvider({ ENCRYPTION_ACTIVE_KEY_ID: 'v5' });
    await expect(provider.getActiveKey()).rejects.toThrow(/active keyId 'v5'/);
  });
});

describe('DockerKeyProvider', () => {
  it('reads key material from *_FILE secret files', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: (path: string) => {
        if (path === '/run/secrets/enc') return `${KEY_V1}\n`;
        throw new Error('ENOENT');
      },
    }));
    const { createDockerKeyProvider } = await import('../adapters/docker/keys');
    const provider = createDockerKeyProvider({ ENCRYPTION_KEY_FILE: '/run/secrets/enc' });
    expect(await provider.getActiveKey()).toEqual({ keyId: 'v0', key: KEY_V1 });
    vi.doUnmock('node:fs');
  });

  it('prefers the direct var over its *_FILE counterpart', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: () => 'should-not-be-used',
    }));
    const { createDockerKeyProvider } = await import('../adapters/docker/keys');
    const provider = createDockerKeyProvider({
      ENCRYPTION_KEY: KEY_V0,
      ENCRYPTION_KEY_FILE: '/run/secrets/enc',
    });
    expect(await provider.getActiveKey()).toEqual({ keyId: 'v0', key: KEY_V0 });
    vi.doUnmock('node:fs');
  });
});
