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

import { type ComponentType, lazy, Suspense } from 'react';
import { getApiClient } from '@/lib/api';

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
      manifest: Record<string, string>;
    }>;

    for (const ext of exts) {
      if (!ext.enabled || !ext.bundleUrl) continue;
      if (!['interface', 'display', 'layout', 'panel', 'module'].includes(ext.type)) continue;

      const bundleUrl = ext.bundleUrl;
      const name = ext.name;

      // Create a lazy component from the bundle's default export.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const LazyComponent = lazy(async (): Promise<{ default: ComponentType<any> }> => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const mod = await import(/* @vite-ignore */ bundleUrl) as Record<string, unknown>;
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
  return Array.from(cache.values());
}

/** Clear the extension cache (forces a reload on next call). */
export function clearExtensionCache(): void {
  cache.clear();
  loaded = false;
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
  const entry = cache.get(name);
  if (!entry) return null;

  const Component = entry.component;
  return (
    <ExtensionErrorBoundary name={name}>
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
