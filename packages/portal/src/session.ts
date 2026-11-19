/**
 * Session storage and the magic-link landing. Storage access is wrapped:
 * Safari private mode, sandboxed iframes and disabled storage throw on
 * `localStorage`, and the widget must keep working (in memory) instead.
 */

import type { PortalSession } from './api';

export const TOKEN_PARAM = 'lumi_member_token';

const memory = new Map<string, string>();

function key(siteId: string): string {
  return `lumi-portal:${siteId}`;
}

export function loadSession(siteId: string): PortalSession | null {
  let raw: string | null = memory.get(key(siteId)) ?? null;
  try {
    raw = globalThis.localStorage?.getItem(key(siteId)) ?? raw;
  } catch {
    /* storage unavailable */
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PortalSession>;
    return typeof parsed.token === 'string' && parsed.token ? { token: parsed.token, ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}) } : null;
  } catch {
    return null;
  }
}

export function saveSession(siteId: string, session: PortalSession | null): void {
  const k = key(siteId);
  if (!session) {
    memory.delete(k);
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* ignore */
    }
    return;
  }
  const raw = JSON.stringify({ token: session.token, refreshToken: session.refreshToken });
  memory.set(k, raw);
  try {
    globalThis.localStorage?.setItem(k, raw);
  } catch {
    /* in-memory only */
  }
}

/**
 * Read the one-time token from a landing URL. Returns the token and the URL
 * without it (to `replaceState`, so a reload or a shared link never reuses
 * it). Malformed URLs and repeated params resolve to `null`, never a throw.
 */
export function takeTokenFromUrl(href: unknown): { token: string; cleanUrl: string } | null {
  if (typeof href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let values: string[];
  try {
    values = url.searchParams.getAll(TOKEN_PARAM);
  } catch {
    return null;
  }
  if (values.length !== 1) return null;
  const token = values[0]!;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  url.searchParams.delete(TOKEN_PARAM);
  return { token, cleanUrl: url.toString() };
}
