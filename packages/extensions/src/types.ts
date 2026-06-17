import type { ExtensionManifest, ExtensionType } from '@lumibase/shared/schemas';

/** Filename every extension ships in its source directory. */
export const MANIFEST_FILENAME = 'lumibase-extension.json';

/**
 * A successfully discovered + validated extension on disk.
 *
 * `sourceDir` is the absolute path to the extension folder; `entryPath` is the
 * absolute, resolved path to the module entrypoint (manifest `entry` joined to
 * `sourceDir`). The loader imports `entryPath`.
 */
export interface DiscoveredExtension {
  manifest: ExtensionManifest;
  /** Convenience: same as `manifest.name`. */
  name: string;
  /** Convenience: same as `manifest.type`. */
  type: ExtensionType;
  /** Absolute path to the extension's source folder. */
  sourceDir: string;
  /** Absolute path to the resolved entrypoint module. */
  entryPath: string;
}

/** A folder that looked like an extension but failed validation. */
export interface DiscoveryError {
  sourceDir: string;
  /** Human-readable reason (Zod issues flattened, or IO error). */
  reason: string;
}

export interface DiscoveryResult {
  extensions: DiscoveredExtension[];
  errors: DiscoveryError[];
}

export interface DiscoverOptions {
  /**
   * Only return extensions of these types. Useful for the Studio loader, which
   * only cares about UI slots, vs. the CMS, which cares about hook/endpoint.
   */
  types?: ExtensionType[];
  /** When true, throw on the first invalid manifest instead of collecting. */
  strict?: boolean;
}
