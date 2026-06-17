import { readFileSync } from 'node:fs';
import type { KeyProvider } from '../../interfaces/keys';
import {
  collectKeys,
  resolveActiveKeyId,
  EnvKeyProvider,
  LEGACY_KEY_VAR,
  KEY_PREFIX,
} from '../shared-keys';

const FILE_SUFFIX = '_FILE';

/**
 * Resolve `ENCRYPTION_KEY[_<id>]_FILE` indirections into their target vars,
 * mirroring the secret-file mechanism in `apps/cms/src/config/production.ts`.
 * The direct var always wins over its `*_FILE` counterpart.
 */
function resolveSecretFiles(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...env };

  for (const [name, value] of Object.entries(env)) {
    if (!value || !name.endsWith(FILE_SUFFIX)) continue;
    const target = name.slice(0, -FILE_SUFFIX.length);
    const isKeyVar = target === LEGACY_KEY_VAR || target.startsWith(KEY_PREFIX);
    if (!isKeyVar || resolved[target]) continue;
    try {
      resolved[target] = readFileSync(value, 'utf8').trim();
    } catch {
      // A missing/unreadable secret file is treated as an unconfigured key;
      // production validation surfaces the error at startup.
    }
  }

  return resolved;
}

/**
 * Creates a {@link KeyProvider} for Docker/Node.js environments, reading key
 * material from environment variables and `*_FILE` secret files.
 */
export function createDockerKeyProvider(env: Record<string, unknown>): KeyProvider {
  const resolved = resolveSecretFiles(env as Record<string, string | undefined>);
  const keys = collectKeys(resolved);
  const activeKeyId = resolveActiveKeyId(resolved, keys);
  return new EnvKeyProvider(keys, activeKeyId);
}
