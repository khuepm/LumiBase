/**
 * Registry of first-party `lumibase-*` extensions eligible for auto-install.
 *
 * Data only — the actual signature/keyId/bundleUrl come from the published
 * marketplace rows at reconcile time. An entry here just says "if a published,
 * officially-signed row for this slug exists, install it for the site (enabled
 * per `enabledByDefault`)". Missing rows are skipped, never fatal.
 */
export interface OfficialExtensionEntry {
  /** Extension name (must be in the `lumibase-` namespace). */
  name: string;
  /** Marketplace listing slug used to find the published source row. */
  marketplaceSlug: string;
  type: 'hook' | 'endpoint' | 'operation' | 'interface' | 'display' | 'layout' | 'panel' | 'module';
  autoInstall: boolean;
  enabledByDefault: boolean;
}

export const OFFICIAL_EXTENSIONS: readonly OfficialExtensionEntry[] = [
  {
    name: 'lumibase-pageview-counter',
    marketplaceSlug: 'lumibase-pageview-counter',
    type: 'panel',
    autoInstall: true,
    enabledByDefault: true,
  },
];

/** Key id of the official LumiBase signing key (seeded into publisher_keys). */
export const OFFICIAL_KEY_ID = 'lumibase-official-v1';
