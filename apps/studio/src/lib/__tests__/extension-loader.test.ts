import { beforeEach, describe, expect, it, vi } from 'vitest';

const getApiClientMock = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: getApiClientMock,
}));

// The dev-only source-extension virtual module is provided by the Vite plugin
// `lumibase:dev-extensions` at dev time. Under vitest it does not exist, so we
// stub it to an empty list — the loader's API path is what these tests cover.
vi.mock('virtual:lumibase-extensions', () => ({ devExtensions: [] }));

describe('extension-loader access filtering', () => {
  beforeEach(async () => {
    vi.resetModules();
    getApiClientMock.mockReset();
  });

  it('does not list or cache Studio extensions when the principal cannot read extensions', async () => {
    const list = vi.fn();
    getApiClientMock.mockReturnValue({
      permissions: {
        check: vi.fn().mockResolvedValue({ data: { allowed: false } }),
      },
      extensions: { list },
    });
    const { clearExtensionCache, getExtensionsForSlot, loadExtensions } = await import('../extension-loader');
    clearExtensionCache();

    await expect(loadExtensions()).resolves.toEqual([]);

    expect(list).not.toHaveBeenCalled();
    expect(getExtensionsForSlot('module')).toEqual([]);
  });

  it('loads only readable, enabled Studio UI extensions into their slot cache', async () => {
    getApiClientMock.mockReturnValue({
      permissions: {
        check: vi.fn().mockResolvedValue({ data: { allowed: true } }),
      },
      extensions: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'analytics-module',
              type: 'module',
              enabled: true,
              bundleUrl: 'https://cdn.example/analytics.js',
              manifest: { label: 'Analytics' },
            },
            {
              name: 'disabled-module',
              type: 'module',
              enabled: false,
              bundleUrl: 'https://cdn.example/disabled.js',
              manifest: {},
            },
            {
              name: 'endpoint-only',
              type: 'endpoint',
              enabled: true,
              bundleUrl: 'https://cdn.example/endpoint.js',
              manifest: {},
            },
          ],
        }),
      },
    });
    const { clearExtensionCache, getExtensionsForSlot, loadExtensions } = await import('../extension-loader');
    clearExtensionCache();

    const loaded = await loadExtensions();

    expect(loaded.map((ext) => ext.name)).toEqual(['analytics-module']);
    expect(getExtensionsForSlot('module').map((ext) => ext.name)).toEqual(['analytics-module']);
    expect(getExtensionsForSlot('panel')).toEqual([]);
  });
});

describe('bundle integrity (#990)', () => {
  const bytes = new TextEncoder().encode('export default function Panel() { return null; }');
  async function sha256(data: BufferSource): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('accepts a bundle whose bytes match the recorded SHA-256', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })));
    const { assertBundleIntegrity } = await import('../extension-loader');
    await expect(assertBundleIntegrity('panel', 'https://ext.example/p.js', await sha256(bytes))).resolves.toBeUndefined();
  });

  it('refuses a bundle whose content was replaced at its URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('alert(1)', { status: 200 })));
    const { assertBundleIntegrity } = await import('../extension-loader');
    await expect(assertBundleIntegrity('panel', 'https://ext.example/p.js', await sha256(bytes))).rejects.toThrow(/does not match/);
  });

  it('refuses when the bundle cannot be fetched for verification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const { assertBundleIntegrity } = await import('../extension-loader');
    await expect(assertBundleIntegrity('panel', 'https://ext.example/p.js', 'a'.repeat(64))).rejects.toThrow(/404/);
  });

  it('never imports a mismatched bundle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tampered', { status: 200 })));
    const { importVerifiedBundle } = await import('../extension-loader');
    // The URL is not importable in tests; reaching import() would throw a different error.
    await expect(importVerifiedBundle('panel', 'https://ext.example/p.js', await sha256(bytes))).rejects.toThrow(/does not match/);
  });
});
