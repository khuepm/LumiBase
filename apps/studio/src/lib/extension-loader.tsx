import { formatSafeError } from "@lumibase/shared/utils";
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
export async function loadExtensions(): Promise<ExtensionEntry[]> {
  if (loaded) return Array.from(cache.values());

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
 * Renders a dynamically loaded extension component by name.
 * Shows a loading spinner while the bundle is being fetched.
 * Returns null if the extension is not found.
 */
export function ExtensionComponent({ name, ...props }: ExtensionComponentProps) {
  const entry = cache.get(name);
  if (!entry) return null;

  const Component = entry.component;
  return (
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
  );
}
