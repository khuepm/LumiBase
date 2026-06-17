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
