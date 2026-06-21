/**
 * Status of an encryption key.
 *
 * - `active`  → used to encrypt new ciphertext (exactly one per provider).
 * - `retired` → only used to decrypt existing ciphertext (any number).
 */
export type KeyStatus = 'active' | 'retired';

/**
 * Metadata describing a configured encryption key. Never carries the key
 * material itself — only the version id, status and algorithm.
 */
export interface KeyMeta {
  /** Version identifier embedded in the ciphertext envelope (e.g. `v0`, `v1`). */
  keyId: string;
  /** Whether the key is `active` (encrypt) or `retired` (decrypt-only). */
  status: KeyStatus;
  /** Symmetric algorithm the key is intended for. */
  algo: 'AES-GCM';
}

/** Key material resolved for a given version, base64-encoded. */
export interface ResolvedKey {
  /** Version identifier of the resolved key. */
  keyId: string;
  /** Base64-encoded raw key material (AES-GCM 128/192/256-bit). */
  key: string;
}

/**
 * Runtime-agnostic provider of symmetric encryption keys.
 *
 * Implementations resolve key material from the underlying platform
 * (Workers Secrets / KV on Cloudflare, env + `*_FILE` on Docker) so business
 * logic can request keys without importing platform bindings.
 */
export interface KeyProvider {
  /** Resolve the single active key used to encrypt new data. */
  getActiveKey(): Promise<ResolvedKey>;
  /** Resolve key material for a specific version id (active or retired). */
  getKey(keyId: string): Promise<string>;
  /** List metadata for all configured keys. */
  listKeys(): Promise<KeyMeta[]>;
}
