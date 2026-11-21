import { formatSafeError } from "@lumibase/contracts/utils";
/**
 * ExtensionLoader — dynamically loads Studio UI extensions at runtime.
 *
 * UI extensions are ESM modules served from a CDN/R2 URL. They export a
 * `ui.component` (React component) and a `ui.type` declaring the slot they
 * fill: 'interface' | 'display' | 'layout' | 'panel' | 'module'.
 *
 * The loader:
 *  1. Fetches the list of enabled extensions from the CMS API.
 *  2. For each `ui:*` type extension, lazily imports its bundle URL.
 *  3. Registers the component in the appropriate registry.
 *  4. Re-exports the merged registry for use by the Interface/Display registries.
 *
 * Extensions are cached in memory; calling `clearCache()` forces a reload.
 */

import { type ComponentType, lazy, Suspense, useSyncExternalStore } from 'react';
import { supersedesDevBuild } from '@lumibase/contracts/extensions';
import { getApiClient } from '@/lib/api';
import {
  clearIntentHandlers,
  hasIntentCapability,
  registerIntentHandlers,
} from '@/lib/intents/registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtensionSlot = 'interface' | 'display' | 'layout' | 'panel' | 'module';

export interface ExtensionEntry {
  name: string;
  slot: ExtensionSlot;
  /** Lazy-loaded React component. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  /** Raw manifest from the extension DB record. */
  manifest: Record<string, string>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const cache = new Map<string, ExtensionEntry>();
let loaded = false;

/**
 * Extensions granted an `intents:claim:*` capability (issue #759). Their
 * bundles are imported only when an intent link is being resolved, never on a
 * normal Studio boot.
 */
const intentSources = new Map<
  string,
  { capabilities: string[]; load: () => Promise<Record<string, unknown>> }
>();
let intentsLoaded: Promise<void> | null = null;

/**
 * Load all enabled UI extensions from the API and cache them.
 * Safe to call multiple times — subsequent calls return the cache.
 */
/**
 * Dev-only: seed the cache from local source extensions discovered by the
 * `lumibase:dev-extensions` Vite plugin (virtual module). This lets authors
 * iterate on extension SOURCE in the `extensions/` submodule without publishing
 * a bundle or touching the DB — the auto-detect path.
 *
 * In production builds the virtual module resolves to an empty array, and this
 * function is a no-op. The dynamic import is wrapped so a missing virtual
 * module (e.g. under vitest) never breaks the API-backed loader.
 */
async function seedDevExtensions(): Promise<void> {
  if (!import.meta.env.DEV) return;

  try {
    const mod = (await import(/* @vite-ignore */ 'virtual:lumibase-extensions')) as {
      devExtensions?: Array<{ name: string; type: string; load: () => Promise<unknown> }>;
    };
    const devExtensions = mod.devExtensions ?? [];

    for (const ext of devExtensions) {
      if (!['interface', 'display', 'layout', 'panel', 'module'].includes(ext.type)) continue;
      if (cache.has(ext.name)) continue; // API/DB entry wins over dev source

      const load = ext.load;
      const name = ext.name;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const LazyComponent = lazy(async (): Promise<{ default: ComponentType<any> }> => {
        const bundle = (await load()) as Record<string, unknown>;
        const component = (bundle.default ?? bundle.component) as ComponentType<unknown> | undefined;
        // An interface/display extension's default export is a definition
        // object ({ component, ... }), not the component itself.
        const resolved =
          typeof component === 'function'
            ? component
            : ((component as { component?: ComponentType<unknown> } | undefined)?.component ??
              (bundle.component as ComponentType<unknown> | undefined));
        if (!resolved) throw new Error(`Dev extension "${name}" does not export a component.`);
        return { default: resolved };
      });

      cache.set(name, {
        name,
        slot: ext.type as ExtensionSlot,
        component: LazyComponent,
        manifest: {},
      });
    }
  } catch (err) {
    console.warn('[extension-loader] dev source extensions unavailable:', formatSafeError(err));
  }
}

export async function loadExtensions(): Promise<ExtensionEntry[]> {
  if (loaded) return Array.from(cache.values());

  // Dev source extensions are seeded first; API/DB entries (below) take
  // precedence if a name collides (handled by the `cache.has` guard above).
  await seedDevExtensions();

  try {
    const client = getApiClient();
    const readCheck = await client.permissions.check({ collection: 'extensions', action: 'read' });
    if (!readCheck.data.allowed) {
      loaded = true;
      return [];
    }

    const resp = await client.extensions.list();
    const exts = (resp.data ?? []) as Array<{
      name: string;
      type: string;
      enabled: boolean;
      bundleUrl: string;
      bundleSha256?: string | null;
      manifest: Record<string, string>;
      capabilities?: unknown;
    }>;

    for (const ext of exts) {
      if (!ext.enabled || !ext.bundleUrl) continue;
      if (!['interface', 'display', 'layout', 'panel', 'module'].includes(ext.type)) continue;

      const bundleUrl = ext.bundleUrl;
      const name = ext.name;
      const expectedSha256 = typeof ext.bundleSha256 === 'string' ? ext.bundleSha256 : null;
      const load = () => importVerifiedBundle(name, bundleUrl, expectedSha256);

      // GRANTED capabilities (server-side subset of the manifest) scope which
      // intents this extension may claim.
      const capabilities = Array.isArray(ext.capabilities)
        ? ext.capabilities.filter((c): c is string => typeof c === 'string')
        : [];
      if (hasIntentCapability(capabilities)) {
        intentSources.set(name, {
          capabilities,
          load,
        });
      }

      // Create a lazy component from the bundle's default export.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const LazyComponent = lazy(async (): Promise<{ default: ComponentType<any> }> => {
        const mod = await load();
        const component = (mod.default ?? mod.component) as ComponentType<unknown> | undefined;
        if (!component) throw new Error(`Extension "${name}" does not export a default component.`);
        return { default: component };
      });

      cache.set(name, {
        name,
        slot: ext.type as ExtensionSlot,
        component: LazyComponent,
        manifest: ext.manifest,
      });
    }
  } catch (err) {
    console.warn('[extension-loader] failed to load extensions:', formatSafeError(err));
  }

  loaded = true;
  notifyExtensionUpdates();
  return Array.from(cache.values());
}

/** Clear the extension cache (forces a reload on next call). */
export function clearExtensionCache(): void {
  cache.clear();
  hotImpls.clear();
  loaded = false;
  intentSources.clear();
  intentsLoaded = null;
  clearIntentHandlers();
}

/**
 * Import the bundles of extensions allowed to claim intents and register the
 * handlers they export as `intents` (named export, or `default.intents`).
 * Idempotent; a failing bundle is skipped so the built-in handler still runs.
 */
export function loadExtensionIntentHandlers(): Promise<void> {
  if (!intentsLoaded) {
    intentsLoaded = (async () => {
      await loadExtensions();
      for (const [name, source] of intentSources) {
        try {
          const mod = await source.load();
          const fromDefault = (mod.default as { intents?: unknown } | undefined)?.intents;
          registerIntentHandlers(name, source.capabilities, mod.intents ?? fromDefault);
        } catch (err) {
          console.warn(`[extension-loader] intent handlers of "${name}" unavailable:`, formatSafeError(err));
        }
      }
    })();
  }
  return intentsLoaded;
}

// ─── Dev hot reload (#754) ───────────────────────────────────────────────────
//
// `lumibase-ext dev` pushes rebuilt UI bundles; `extension-dev-client.ts`
// imports each one and calls `hotSwapExtension`. The registry entry's
// `component` becomes a STABLE wrapper per extension name that renders the
// latest implementation, so whoever already resolved the component (e.g.
// `resolveInterface`) keeps a valid reference and simply re-renders. Only the
// extension's own subtree remounts on a swap; host state — the form values an
// interface edits via `value`/`onChange`, routing, query cache — is untouched.

interface HotImpl {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  session: string;
  version: number;
}

const hotImpls = new Map<string, HotImpl>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hotWrappers = new Map<string, ComponentType<any>>();
const hotListeners = new Set<() => void>();
/** Bumped whenever the set of resolvable extensions changes. */
let extensionGeneration = 0;

function subscribeHot(listener: () => void): () => void {
  hotListeners.add(listener);
  return () => hotListeners.delete(listener);
}

function notifyExtensionUpdates(): void {
  extensionGeneration += 1;
  for (const listener of [...hotListeners]) listener();
}

/** Subscribe to dev hot-swaps (any extension). Returns an unsubscribe fn. */
export function subscribeExtensionUpdates(listener: () => void): () => void {
  return subscribeHot(listener);
}

const getExtensionGeneration = () => extensionGeneration;

/**
 * Re-render when an extension is loaded or hot-swapped. Components that pick
 * a component through the registry DURING render (`resolveInterface`) call
 * this: otherwise a form drawn before the dev hub's first build arrived keeps
 * its fallback editor until something else happens to re-render it.
 */
export function useExtensionUpdates(): number {
  return useSyncExternalStore(subscribeHot, getExtensionGeneration, getExtensionGeneration);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hotWrapperFor(name: string): ComponentType<any> {
  const existing = hotWrappers.get(name);
  if (existing) return existing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function HotExtension(props: Record<string, any>) {
    const impl = useSyncExternalStore(subscribeHot, () => hotImpls.get(name));
    if (!impl) return null;
    const Impl = impl.component;
    return <Impl {...props} />;
  }
  HotExtension.displayName = `HotExtension(${name})`;
  hotWrappers.set(name, HotExtension);
  return HotExtension;
}

/** Version currently rendered for a hot-reloaded extension (dev only). */
export function getHotExtensionVersion(name: string): number | undefined {
  return hotImpls.get(name)?.version;
}

/**
 * Install (or replace) the implementation of a UI extension at `version`.
 * Out-of-order or duplicate versions are ignored. Returns true when swapped.
 */
export function hotSwapExtension(input: {
  name: string;
  slot: ExtensionSlot;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  /** `lumibase-ext dev` run; versions restart at 1 when the CLI restarts. */
  session: string;
  version: number;
}): boolean {
  if (!supersedesDevBuild(hotImpls.get(input.name), input)) return false;
  hotImpls.set(input.name, { component: input.component, session: input.session, version: input.version });
  const entry = cache.get(input.name);
  cache.set(input.name, {
    name: input.name,
    slot: input.slot,
    component: hotWrapperFor(input.name),
    manifest: entry?.manifest ?? {},
  });
  notifyExtensionUpdates();
  return true;
}

/** Get a cached extension by name. Returns undefined if not loaded. */
export function getExtension(name: string): ExtensionEntry | undefined {
  return cache.get(name);
}

/** Get all extensions for a given slot type. */
export function getExtensionsForSlot(slot: ExtensionSlot): ExtensionEntry[] {
  return Array.from(cache.values()).filter((e) => e.slot === slot);
}

// ─── Wrapper component ───────────────────────────────────────────────────────

import React from 'react';

interface ExtensionComponentProps {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Error boundary isolating a single extension. A buggy or hostile extension
 * that throws during render is contained here instead of crashing the whole
 * Studio shell. Combined with the CSP (`script-src 'self'`) and the server-side
 * `EXTENSION_BUNDLE_ORIGINS` allowlist, this keeps an untrusted bundle from
 * escalating a render error into a denial of the entire admin UI.
 *
 * Note: extensions render their own React tree, so HTML-level sanitisation
 * (DOMPurify) cannot be applied to them from the host — the trust boundary is
 * the origin allowlist + CSP, and this boundary limits blast radius.
 */
class ExtensionErrorBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(
      `[extension-loader] extension "${this.props.name}" crashed during render:`,
      formatSafeError(error),
    );
  }

  render() {
    if (this.state.failed) {
      return (
        <span className="text-xs text-destructive" role="alert">
          Extension “{this.props.name}” failed to render.
        </span>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders a dynamically loaded extension component by name.
 * Shows a loading spinner while the bundle is being fetched.
 * Returns null if the extension is not found. Render errors are contained by
 * an error boundary so one bad extension cannot take down the Studio.
 */
export function ExtensionComponent({ name, ...props }: ExtensionComponentProps) {
  // Subscribed so an extension that first appears via dev hot reload renders.
  const entry = useSyncExternalStore(subscribeHot, () => cache.get(name));
  if (!entry) return null;

  const Component = entry.component;
  return (
    // Keyed by hot version: a fixed build clears a previous render crash.
    <ExtensionErrorBoundary key={hotImpls.get(name)?.version ?? 0} name={name}>
      <Suspense
        fallback={
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent"
              aria-hidden="true"
            />
            Loading extension…
          </span>
        }
      >
        <Component {...props} />
      </Suspense>
    </ExtensionErrorBoundary>
  );
}

/**
 * Import an extension bundle only if its bytes match the SHA-256 the server
 * recorded for it (#990). A bundle whose content was replaced at its URL — a
 * compromised CDN, a swapped file — is refused instead of running inside the
 * admin origin. Rows without a recorded hash (installed under the `warn`
 * signature policy) load as before, with a console warning.
 *
 * Limit: the check fetches the bytes, then `import()`s the same URL, which the
 * browser normally serves from the HTTP cache. It catches a persistent swap,
 * not a server that answers the two requests differently; a blob-URL import
 * would close that gap but needs `blob:` in the Studio CSP `script-src`. See
 * ADR-015.
 */
export async function importVerifiedBundle(
  name: string,
  bundleUrl: string,
  expectedSha256: string | null,
): Promise<Record<string, unknown>> {
  if (expectedSha256) {
    await assertBundleIntegrity(name, bundleUrl, expectedSha256);
  } else {
    console.warn(`[extension-loader] "${name}" has no recorded bundle hash; loading without an integrity check.`);
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return (await import(/* @vite-ignore */ bundleUrl)) as Record<string, unknown>;
}

export async function assertBundleIntegrity(name: string, bundleUrl: string, expectedSha256: string): Promise<void> {
  const res = await fetch(bundleUrl, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Extension "${name}": bundle could not be fetched for verification (${res.status}).`);
  const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`Extension "${name}": bundle content does not match its recorded SHA-256; refusing to load it.`);
  }
}
