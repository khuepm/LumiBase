import type { KeyProvider } from '../../interfaces/keys';
import { collectKeys, resolveActiveKeyId, EnvKeyProvider } from '../shared-keys';

/**
 * Creates a {@link KeyProvider} for Cloudflare Workers.
 *
 * Key material is read from the Worker `env` bindings, which is where Workers
 * Secrets (`wrangler secret put ENCRYPTION_KEY[_<id>]`) are surfaced. The same
 * versioned-key convention as the Docker adapter applies, so business logic is
 * identical across runtimes.
 */
export function createCloudflareKeyProvider(env: Record<string, unknown>): KeyProvider {
  const record = env as Record<string, string | undefined>;
  const keys = collectKeys(record);
  const activeKeyId = resolveActiveKeyId(record, keys);
  return new EnvKeyProvider(keys, activeKeyId);
}
