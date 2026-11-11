/**
 * Pure helpers for the production image entrypoint (`entrypoint.mjs`).
 *
 * The runtime image is distroless (#734): there is no shell, so the old
 * `entrypoint.sh` could not run in it. Everything it did now lives in Node,
 * split so the decisions below are unit-tested (`scripts/__tests__/
 * docker-entrypoint.test.mjs`) without spawning a server.
 *
 * Nothing in this file writes to disk. The image runs with a read-only root
 * filesystem, and these helpers only read files and mutate the `env` object
 * they are handed.
 */
import { readFileSync } from 'node:fs';

/**
 * Variables that may instead be supplied as `<NAME>_FILE` (Docker/Kubernetes
 * secrets). The direct variable wins when both are set — same rule as the
 * shell entrypoint and `apps/cms/src/config/production.ts`.
 */
export const SECRET_FILE_VARS = Object.freeze([
  'DATABASE_URL',
  'DATABASE_SYSTEM_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'MEILISEARCH_API_KEY',
  'IMGPROXY_KEY',
  'IMGPROXY_SALT',
]);

/**
 * Load `<NAME>_FILE` into `<NAME>` when only the file form is set.
 * @returns {string[]} names that were loaded
 * @throws when a referenced file is unreadable (the deploy is misconfigured)
 */
export function loadSecretFiles(env, read = (path) => readFileSync(path, 'utf8')) {
  const loaded = [];
  for (const key of SECRET_FILE_VARS) {
    const filePath = env[`${key}_FILE`];
    if (!filePath || env[key]) continue;
    let value;
    try {
      value = read(filePath);
    } catch {
      throw new Error(`${key}_FILE points to an unreadable file: ${filePath}`);
    }
    env[key] = String(value).replace(/[\r\n]+/g, '');
    loaded.push(key);
  }
  return loaded;
}

/** The port the health probe should hit for this process role. */
export function healthPort(env) {
  const port = Number.parseInt(env.PORT || '1989', 10);
  const role = (env.LUMIBASE_PROCESS_ROLE || 'all').toLowerCase();
  if (role !== 'worker') return port;
  // Same default as serve.ts: 1988 next to the default 1989, otherwise PORT+1.
  return Number.parseInt(
    env.LUMIBASE_WORKER_HEALTH_PORT || String(port === 1989 ? 1988 : port + 1),
    10,
  );
}
