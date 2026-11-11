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
 * Mirrors `REQUIRED_PRODUCTION_VARS` in `apps/cms/src/config/production.ts`.
 * The server validates these itself; checking here as well only moves the
 * failure ahead of the migration step so a deploy with a missing secret fails
 * in seconds with a message naming the variable, instead of after a migration
 * run against a database it should not have touched yet.
 */
export const REQUIRED_PRODUCTION_VARS = Object.freeze([
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'CORS_ALLOWED_ORIGINS',
]);

export function isProduction(env) {
  return env.NODE_ENV === 'production' || env.LUMIBASE_ENV === 'production';
}

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

/**
 * The public origin of this deployment, from an explicit setting or from the
 * variable the hosting platform injects at runtime. `undefined` when none is
 * known (plain `docker run`, Compose).
 *
 * - `LUMIBASE_PUBLIC_URL` — explicit, always wins.
 * - `RENDER_EXTERNAL_URL` — Render web services (`https://<name>.onrender.com`).
 * - `RAILWAY_PUBLIC_DOMAIN` — Railway, host only, set once a domain exists.
 * - `FLY_APP_NAME` — Fly.io; the default hostname is `<app>.fly.dev`.
 */
export function resolvePublicUrl(env) {
  const candidates = [
    env.LUMIBASE_PUBLIC_URL,
    env.RENDER_EXTERNAL_URL,
    env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined,
    env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // ignore malformed values and keep looking
    }
  }
  return undefined;
}

/**
 * Default `CORS_ALLOWED_ORIGINS` to the deployment's own origin when it is
 * unset and the origin is known. The image serves the Studio from the same
 * origin as the API, so this is the only origin a one-click deploy needs, and
 * production refuses to start without the variable. An explicit value —
 * including one that lists other origins — is never touched.
 * @returns {string | undefined} the origin applied, if any
 */
export function applyDefaultCorsOrigin(env, publicUrl) {
  if (env.CORS_ALLOWED_ORIGINS?.trim() || !publicUrl) return undefined;
  env.CORS_ALLOWED_ORIGINS = publicUrl;
  return publicUrl;
}

/**
 * Accept an AES key that is valid key material but encoded with the URL-safe
 * base64 alphabet or without padding, and rewrite it to the standard form the
 * server checks for. The key bytes are identical, so data encrypted before and
 * after is unaffected. Anything that does not decode to 16, 24 or 32 bytes is
 * left untouched for the server's own validation to reject.
 * @returns {boolean} whether the value was rewritten
 */
export function normalizeEncryptionKey(env, key = 'ENCRYPTION_KEY') {
  const value = env[key]?.trim();
  if (!value) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (![16, 24, 32].includes(raw.byteLength)) return false;
  const standard = raw.toString('base64');
  // Re-encoding must reproduce the input up to alphabet and padding, or the
  // value carried bits the decoder dropped and is not a clean key.
  const comparable = (s) => s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (comparable(standard) !== comparable(value)) return false;
  if (standard === env[key]) return false;
  env[key] = standard;
  return true;
}

/** Required production variables that are still empty. */
export function missingProductionVars(env) {
  if (!isProduction(env)) return [];
  return REQUIRED_PRODUCTION_VARS.filter((key) => !env[key]?.trim());
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
