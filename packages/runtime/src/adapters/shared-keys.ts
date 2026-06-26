import type { KeyMeta, KeyProvider, ResolvedKey } from '../interfaces/keys';

/**
 * Shared, platform-neutral key resolution used by both the Docker and
 * Cloudflare adapters. Keys are configured purely through an env-like record:
 *
 * - `ENCRYPTION_KEY`           → legacy single key, mapped to version `v0`.
 * - `ENCRYPTION_KEY_<keyId>`   → versioned key material (e.g. `ENCRYPTION_KEY_v1`).
 * - `ENCRYPTION_ACTIVE_KEY_ID` → which version is active for new encryption.
 *
 * When only the legacy key is present the provider resolves it as the active
 * `v0` key, preserving compatibility with existing ciphertext (Req 4.4).
 */

export const LEGACY_KEY_VAR = 'ENCRYPTION_KEY';
export const KEY_PREFIX = 'ENCRYPTION_KEY_';
export const ACTIVE_ID_VAR = 'ENCRYPTION_ACTIVE_KEY_ID';
export const DEFAULT_KEY_ID = 'v0';

type EnvRecord = Record<string, string | undefined>;

/**
 * Collect all configured keys from an env-like record, keyed by version id.
 * The legacy `ENCRYPTION_KEY` maps to `v0` unless an explicit `ENCRYPTION_KEY_v0`
 * is provided.
 */
export function collectKeys(env: EnvRecord): Map<string, string> {
  const keys = new Map<string, string>();

  const legacy = env[LEGACY_KEY_VAR]?.trim();
  if (legacy) keys.set(DEFAULT_KEY_ID, legacy);

  for (const [name, value] of Object.entries(env)) {
    if (!value || !name.startsWith(KEY_PREFIX)) continue;
    // Skip `*_FILE` indirections — those are resolved before collection.
    if (name.endsWith('_FILE')) continue;
    const keyId = name.slice(KEY_PREFIX.length);
    if (keyId) keys.set(keyId, value.trim());
  }

  return keys;
}

/**
 * Determine the active key id. Honours an explicit `ENCRYPTION_ACTIVE_KEY_ID`,
 * otherwise falls back to the only configured key, otherwise `v0`.
 */
export function resolveActiveKeyId(env: EnvRecord, keys: Map<string, string>): string {
  const explicit = env[ACTIVE_ID_VAR]?.trim();
  if (explicit) return explicit;
  if (keys.size === 1) return [...keys.keys()][0]!;
  return DEFAULT_KEY_ID;
}

/**
 * KeyProvider backed by an in-memory map of resolved key material.
 */
export class EnvKeyProvider implements KeyProvider {
  constructor(
    private readonly keys: Map<string, string>,
    private readonly activeKeyId: string,
  ) {}

  async getActiveKey(): Promise<ResolvedKey> {
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      throw new Error(
        `KeyProvider: no encryption key configured for active keyId '${this.activeKeyId}'`,
      );
    }
    return { keyId: this.activeKeyId, key };
  }

  async getKey(keyId: string): Promise<string> {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`KeyProvider: no encryption key configured for keyId '${keyId}'`);
    }
    return key;
  }

  async listKeys(): Promise<KeyMeta[]> {
    return [...this.keys.keys()].map((keyId) => ({
      keyId,
      algo: 'AES-GCM' as const,
      status: keyId === this.activeKeyId ? ('active' as const) : ('retired' as const),
    }));
  }
}
