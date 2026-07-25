import { invoke } from '@tauri-apps/api/core';
import { isDesktopShell } from './shell';

/**
 * Session-token persistence.
 *
 * In the browser (and Docker/Cloudflare deployments) tokens live in
 * `localStorage`, exactly as before. In the desktop shell they are instead
 * stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux
 * Secret Service) via the shell's `secure_*` commands, so the access/refresh
 * tokens are not left in plaintext webview storage on disk.
 *
 * The public accessors stay synchronous so call sites are unchanged: reads come
 * from an in-memory cache that is populated once at startup by `hydrateTokens()`
 * and writes update the cache immediately while persisting in the background.
 * If the keychain is unavailable (a Linux box without a Secret Service daemon,
 * or mobile where the command is not registered) we transparently fall back to
 * `localStorage`.
 */

const KEY = {
  token: 'lumibase.dev.token',
  refresh: 'lumibase.dev.refresh',
} as const;

type TokenKey = keyof typeof KEY;

let mode: 'keychain' | 'local' = 'local';
const cache: Record<TokenKey, string> = { token: '', refresh: '' };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readToken(): string {
  return mode === 'keychain' ? cache.token : storage()?.getItem(KEY.token) ?? '';
}

export function readRefresh(): string {
  return mode === 'keychain' ? cache.refresh : storage()?.getItem(KEY.refresh) ?? '';
}

export function writeToken(value: string): void {
  if (mode === 'keychain') {
    cache.token = value;
    void persist('token', value);
  } else {
    storage()?.setItem(KEY.token, value);
  }
}

export function writeRefresh(value: string): void {
  if (mode === 'keychain') {
    cache.refresh = value;
    void persist('refresh', value);
  } else {
    storage()?.setItem(KEY.refresh, value);
  }
}

export function clearTokens(): void {
  if (mode === 'keychain') {
    cache.token = '';
    cache.refresh = '';
    void remove('token');
    void remove('refresh');
  } else {
    const s = storage();
    s?.removeItem(KEY.token);
    s?.removeItem(KEY.refresh);
  }
}

async function persist(key: TokenKey, value: string): Promise<void> {
  try {
    await invoke('secure_set', { key, value });
  } catch (error) {
    console.error(`secure_set(${key}) failed`, error);
  }
}

async function remove(key: TokenKey): Promise<void> {
  try {
    await invoke('secure_delete', { key });
  } catch (error) {
    console.error(`secure_delete(${key}) failed`, error);
  }
}

/**
 * Decide where tokens live. In the shell, probe the OS keychain and switch to
 * it on success (migrating any legacy localStorage tokens once). Everywhere
 * else — or when the keychain is unavailable — stay on localStorage. Must be
 * awaited during app bootstrap, before any synchronous token read.
 */
export async function hydrateTokens(): Promise<void> {
  if (!isDesktopShell()) {
    mode = 'local';
    return;
  }
  try {
    cache.token = (await invoke<string | null>('secure_get', { key: 'token' })) ?? '';
    cache.refresh = (await invoke<string | null>('secure_get', { key: 'refresh' })) ?? '';
    mode = 'keychain';
    await migrateLegacyTokens();
  } catch (error) {
    console.warn('OS keychain unavailable; falling back to localStorage', error);
    mode = 'local';
  }
}

/** One-time move of tokens left in localStorage by an older build. */
async function migrateLegacyTokens(): Promise<void> {
  const s = storage();
  if (!s) return;
  const legacyToken = s.getItem(KEY.token);
  const legacyRefresh = s.getItem(KEY.refresh);
  if (!legacyToken && !legacyRefresh) return;

  if (!cache.token && legacyToken) {
    cache.token = legacyToken;
    await persist('token', legacyToken);
  }
  if (!cache.refresh && legacyRefresh) {
    cache.refresh = legacyRefresh;
    await persist('refresh', legacyRefresh);
  }
  s.removeItem(KEY.token);
  s.removeItem(KEY.refresh);
}
