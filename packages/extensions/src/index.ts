/**
 * `@lumibase/extensions` — extension discovery + loading.
 *
 * Inspired by Directus's `@directus/extensions` shared utilities: a single
 * place that knows how to find extensions on disk, validate their manifests,
 * and resolve their entrypoints. Consumed by the CMS (hook/endpoint types) and
 * Studio (UI slot types). The authoring SDK is `@lumibase/extension-sdk`.
 */
export {
  discoverExtensions,
  discoverExtensionAt,
} from './discovery';

export {
  MANIFEST_FILENAME,
  type DiscoveredExtension,
  type DiscoveryError,
  type DiscoveryResult,
  type DiscoverOptions,
} from './types';

// Re-export the manifest schema/types so consumers have one import surface.
export {
  ExtensionManifestSchema,
  UI_EXTENSION_TYPES,
  isUiExtensionType,
  type ExtensionManifest,
  type ExtensionType,
  type UiExtensionType,
} from '@lumibase/shared/schemas';
