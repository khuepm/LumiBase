/**
 * Studio side of extension hot reload (#754) — DEV SERVER ONLY.
 *
 * `lumibase-ext dev` prints a Studio link carrying the hub URL and the
 * per-session token in the URL FRAGMENT (`#lumibase-ext-dev=…`), which is never
 * sent to any server. On load we move it to sessionStorage, strip it from the
 * address bar, subscribe to the hub's SSE stream and, on every UI `reload`
 * event, `import()` the bundle at a cache-busting `?v=<version>` URL and swap
 * the component in place (see `hotSwapExtension`). No page reload: routing,
 * query cache and host form state survive; only the extension subtree
 * remounts.
 *
 * Safety: `startExtensionDevClient` is a no-op unless `import.meta.env.DEV`
 * (Vite dev server) — production builds dead-code-eliminate it — and it only
 * ever talks to a loopback hub URL.
 */
import React, { type ComponentType } from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import {
  extensionDevBundlePath,
  isExtensionDevServerType,
  isLoopbackUrl,
  parseExtensionDevReloadEvent,
  type ExtensionDevReloadEvent,
} from '@lumibase/contracts/extensions';
import { hotSwapExtension, type ExtensionSlot } from './extension-loader';

export const DEV_SESSION_KEY = 'lumibase-ext-dev';

export interface DevSession {
  url: string;
  token: string;
}

function parseSession(raw: string | null): DevSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return null;
    if (!isLoopbackUrl(parsed.url) || parsed.token.length < 32) return null;
    return { url: parsed.url.replace(/\/+$/, ''), token: parsed.token };
  } catch {
    return null;
  }
}

/**
 * Read the dev session from the URL fragment (then persist + strip it) or from
 * sessionStorage. Non-loopback hub URLs are rejected.
 */
export function readDevSession(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  replaceUrl: (url: string) => void,
): DevSession | null {
  const prefix = `#${DEV_SESSION_KEY}=`;
  if (loc.hash.startsWith(prefix)) {
    const raw = decodeURIComponent(loc.hash.slice(prefix.length));
    replaceUrl(`${loc.pathname}${loc.search}`);
    const session = parseSession(raw);
    if (session) {
      try {
        storage?.setItem(DEV_SESSION_KEY, JSON.stringify(session));
      } catch {
        /* storage unavailable — session lives for this page only */
      }
    }
    return session;
  }
  try {
    return parseSession(storage?.getItem(DEV_SESSION_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Pick the React component out of a UI bundle's exports. */
export function resolveUiComponent(mod: Record<string, unknown>): ComponentType<unknown> | null {
  const candidate = mod.default ?? mod.component;
  if (typeof candidate === 'function') return candidate as ComponentType<unknown>;
  const nested = (candidate as { component?: unknown } | undefined)?.component;
  if (typeof nested === 'function') return nested as ComponentType<unknown>;
  return typeof mod.component === 'function' ? (mod.component as ComponentType<unknown>) : null;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void;
  close(): void;
}

export interface HubConnectionOptions {
  session: DevSession;
  createEventSource?: (url: string) => EventSourceLike;
  importModule?: (url: string) => Promise<Record<string, unknown>>;
  onSwapped?: (event: ExtensionDevReloadEvent) => void;
  onError?: (message: string) => void;
}

const defaultImport = (url: string) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

/** Subscribe to the hub and hot-swap UI extensions. Returns a disconnect fn. */
export function connectExtensionDevHub(options: HubConnectionOptions): () => void {
  const { session } = options;
  const importModule = options.importModule ?? defaultImport;
  const onError = options.onError ?? ((m: string) => console.warn(`[extension-dev] ${m}`));
  const tokenQs = `token=${encodeURIComponent(session.token)}`;
  const source = (options.createEventSource ?? ((u: string) => new EventSource(u)))(
    `${session.url}/events?${tokenQs}`,
  );

  const apply = async (event: ExtensionDevReloadEvent): Promise<void> => {
    if (isExtensionDevServerType(event.type)) return; // CMS-side extension
    const url = `${session.url}${extensionDevBundlePath(event.name, event.version)}&${tokenQs}`;
    try {
      const mod = await importModule(url);
      const component = resolveUiComponent(mod);
      if (!component) {
        onError(`"${event.name}" v${event.version} does not export a component`);
        return;
      }
      if (hotSwapExtension({ name: event.name, slot: event.type as ExtensionSlot, component, session: event.session, version: event.version })) {
        options.onSwapped?.(event);
      }
    } catch (err) {
      onError(`reload of "${event.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  source.addEventListener('hello', (e) => {
    try {
      const list = (JSON.parse(e.data) as { extensions?: unknown }).extensions;
      for (const raw of Array.isArray(list) ? list : []) {
        const ev = parseExtensionDevReloadEvent(raw);
        if (ev) void apply(ev);
      }
    } catch {
      /* malformed hello — ignore */
    }
  });
  source.addEventListener('reload', (e) => {
    try {
      const ev = parseExtensionDevReloadEvent(JSON.parse(e.data));
      if (ev) void apply(ev);
    } catch {
      /* malformed event — ignore */
    }
  });
  source.addEventListener('build-error', (e) => {
    try {
      const { name, message } = JSON.parse(e.data) as { name?: string; message?: string };
      onError(`build of "${name ?? '?'}" failed — keeping the previous version\n${message ?? ''}`);
    } catch {
      /* ignore */
    }
  });

  return () => source.close();
}

/** Expose Studio's React to UI bundles (the CLI shims `react` to this). */
export function provideSharedModules(target: Record<string, unknown> = globalThis as Record<string, unknown>): void {
  target.__lumibaseShared = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': ReactDOM,
  };
}

/** Entry point from `main.tsx`. Dev server only; returns a stop fn. */
export function startExtensionDevClient(): () => void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => undefined;
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  const session = readDevSession(window.location, storage, (url) => window.history.replaceState(window.history.state, '', url));
  if (!session) return () => undefined;
  provideSharedModules();
  console.info(`[extension-dev] hot reload connected to ${session.url} (dev only)`);
  return connectExtensionDevHub({
    session,
    onSwapped: (ev) => console.info(`[extension-dev] ${ev.name} → v${ev.version}`),
  });
}
