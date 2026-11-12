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
 * including one that lists other origins — is never touched; a value with no
 * host at all (`https://`, see `corsOriginsHaveNoHost`) is removed first.
 * @returns {string | undefined} the origin applied, if any
 */
export function applyDefaultCorsOrigin(env, publicUrl) {
  if (corsOriginsHaveNoHost(env.CORS_ALLOWED_ORIGINS)) delete env.CORS_ALLOWED_ORIGINS;
  if (env.CORS_ALLOWED_ORIGINS?.trim() || !publicUrl) return undefined;
  env.CORS_ALLOWED_ORIGINS = publicUrl;
  return publicUrl;
}

/**
 * Why the server would reject `ENCRYPTION_KEY`, or `undefined` when it would
 * accept it (or is not in production, where the server does not check it).
 *
 * The same test as `isValidAesGcmKey` in `apps/cms/src/config/production.ts`:
 * standard, canonically padded base64 of 16, 24 or 32 bytes — no stricter,
 * so nothing that boots under `node dist/serve.cjs` is refused here. The
 * value is only read, never rewritten: the CDC registry derives its AES key
 * from the string itself (SHA-256 of its UTF-8 bytes,
 * `apps/cms/src/modules/cdc/registry/encryption.ts`), so re-encoding the same
 * key bytes would still change the key and break every connection string
 * encrypted under the old one.
 */
export function encryptionKeyProblem(env) {
  if (!isProduction(env)) return undefined;
  const value = env.ENCRYPTION_KEY;
  if (!value) return undefined; // reported as missing by missingProductionVars
  const normalized = value.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    const raw = Buffer.from(normalized, 'base64');
    if ([16, 24, 32].includes(raw.byteLength) && raw.toString('base64') === normalized) {
      return undefined;
    }
  }
  return (
    'ENCRYPTION_KEY must be a base64-encoded 128, 192, or 256-bit AES key ' +
    '(standard base64 with padding, e.g. the output of `openssl rand -base64 32`). ' +
    'The entrypoint does not convert it: if this deployment already encrypted ' +
    'data under the current value, keep that value and fix how it is supplied ' +
    'rather than generating a new key.'
  );
}

/**
 * True when `CORS_ALLOWED_ORIGINS` is set but every entry is empty or an
 * origin without a host — e.g. `https://`, which is what a platform template
 * such as Railway's `https://${{RAILWAY_PUBLIC_DOMAIN}}` expands to before a
 * public domain exists. Such a value carries no usable origin, so it is
 * treated as unset: the deployment's own origin may replace it, and if none is
 * known the entrypoint stops with a message instead of starting a server no
 * browser can call.
 */
export function corsOriginsHaveNoHost(value) {
  if (!value?.trim()) return false;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .every((entry) => entry === '' || /^[a-z][a-z0-9+.-]*:\/*$/i.test(entry));
}

/**
 * `MIGRATION_MODE=preflight|dry-run` runs the migration preflight and exits
 * without loading the server — unless preflight is switched off or migrations
 * are skipped, in which case the mode has nothing to do and the server starts
 * as usual (the `entrypoint.sh` behaviour).
 */
export function exitsAfterPreflight(env) {
  return (
    env.SKIP_MIGRATIONS !== 'true' &&
    env.RUN_MIGRATION_PREFLIGHT !== 'false' &&
    (env.MIGRATION_MODE === 'preflight' || env.MIGRATION_MODE === 'dry-run')
  );
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
