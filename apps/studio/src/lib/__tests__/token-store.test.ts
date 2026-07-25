// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri IPC bridge and the shell detector. The closures are defined
// once and survive `vi.resetModules()`, so fresh imports of token-store still
// see them.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const isDesktopShell = vi.fn();
vi.mock('../shell', () => ({ isDesktopShell: () => isDesktopShell() }));

async function freshStore() {
  vi.resetModules();
  return import('../token-store');
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  isDesktopShell.mockReset();
});

describe('token-store', () => {
  it('uses localStorage in the browser (no shell)', async () => {
    isDesktopShell.mockReturnValue(false);
    const store = await freshStore();
    await store.hydrateTokens();

    store.writeToken('access_1');
    store.writeRefresh('refresh_1');

    expect(store.readToken()).toBe('access_1');
    expect(store.readRefresh()).toBe('refresh_1');
    expect(localStorage.getItem('lumibase.dev.token')).toBe('access_1');
    expect(invoke).not.toHaveBeenCalled();

    store.clearTokens();
    expect(store.readToken()).toBe('');
    expect(localStorage.getItem('lumibase.dev.token')).toBeNull();
  });

  it('routes tokens through the keychain in the shell', async () => {
    isDesktopShell.mockReturnValue(true);
    invoke.mockImplementation((cmd: string) =>
      cmd === 'secure_get' ? Promise.resolve(null) : Promise.resolve(),
    );
    const store = await freshStore();
    await store.hydrateTokens();

    store.writeToken('access_1');
    expect(store.readToken()).toBe('access_1');
    expect(invoke).toHaveBeenCalledWith('secure_set', { key: 'token', value: 'access_1' });
    // Nothing leaks into plaintext localStorage.
    expect(localStorage.getItem('lumibase.dev.token')).toBeNull();

    store.clearTokens();
    expect(store.readToken()).toBe('');
    expect(invoke).toHaveBeenCalledWith('secure_delete', { key: 'token' });
  });

  it('migrates legacy localStorage tokens into the keychain once', async () => {
    isDesktopShell.mockReturnValue(true);
    localStorage.setItem('lumibase.dev.token', 'legacy_access');
    localStorage.setItem('lumibase.dev.refresh', 'legacy_refresh');
    invoke.mockImplementation((cmd: string) =>
      cmd === 'secure_get' ? Promise.resolve(null) : Promise.resolve(),
    );
    const store = await freshStore();
    await store.hydrateTokens();

    expect(store.readToken()).toBe('legacy_access');
    expect(store.readRefresh()).toBe('legacy_refresh');
    expect(invoke).toHaveBeenCalledWith('secure_set', { key: 'token', value: 'legacy_access' });
    expect(invoke).toHaveBeenCalledWith('secure_set', { key: 'refresh', value: 'legacy_refresh' });
    // Legacy plaintext copies are removed after migration.
    expect(localStorage.getItem('lumibase.dev.token')).toBeNull();
    expect(localStorage.getItem('lumibase.dev.refresh')).toBeNull();
  });

  it('falls back to localStorage when the keychain is unavailable', async () => {
    isDesktopShell.mockReturnValue(true);
    invoke.mockRejectedValue(new Error('no secret service'));
    const store = await freshStore();
    await store.hydrateTokens();

    store.writeToken('access_1');
    expect(store.readToken()).toBe('access_1');
    expect(localStorage.getItem('lumibase.dev.token')).toBe('access_1');
  });
});
