import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SECRET_FILE_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'MEILISEARCH_API_KEY',
  'IMGPROXY_KEY',
  'IMGPROXY_SALT',
] as const;

const REQUIRED_PRODUCTION_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'CORS_ALLOWED_ORIGINS',
] as const;

const DEV_SECRET_VALUES = new Set([
  'dev_secret_key',
  'lumibase_dev_key',
  'minioadmin',
  '736563726574',
  'lumibase-cdc-default-encryption-key-do-not-use-in-prod',
]);

export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of SECRET_FILE_VARS) {
    const fileVar = `${key}_FILE`;
    const filePath = env[fileVar];
    if (!filePath || env[key]) continue;

    const safePath = resolve(filePath);
    // Allow tmpdir for testing
    const isTmpDir = safePath.startsWith(resolve(tmpdir()));

    if (!safePath.startsWith(resolve(process.cwd())) && !safePath.startsWith('/var/run/secrets/') && !isTmpDir) {
        throw new Error(`Access Denied: Path Traversal detected in ${fileVar}`);
    }
    env[key] = readFileSync(filePath, 'utf8').trim();
  }
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.LUMIBASE_ENV === 'production';
}

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionEnv(env)) return;

  const errors: string[] = [];

  for (const key of REQUIRED_PRODUCTION_VARS) {
    if (!env[key]?.trim()) {
      errors.push(`${key} is required in production.`);
    }
  }

  if (env.LUMIBASE_DEV_AUTH === 'true') {
    errors.push('LUMIBASE_DEV_AUTH must not be true in production.');
  }

  for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'MEILISEARCH_API_KEY']) {
    const value = env[key];
    if (value && DEV_SECRET_VALUES.has(value)) {
      errors.push(`${key} uses a development/default value.`);
    }
  }

  const encryptionKey = env.ENCRYPTION_KEY;
  if (encryptionKey && !isValidAesGcmKey(encryptionKey)) {
    errors.push('ENCRYPTION_KEY must be a base64-encoded 128, 192, or 256-bit AES key.');
  }

  // Validate any versioned encryption keys (ENCRYPTION_KEY_<id>) used for
  // key rotation. Each must be a valid AES-GCM key and not a dev/default value,
  // and the active key id (if set) must resolve to a configured key.
  const versionedKeyIds = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !name.startsWith('ENCRYPTION_KEY_') || name.endsWith('_FILE')) continue;
    if (name === 'ENCRYPTION_KEY_FILE') continue;
    const keyId = name.slice('ENCRYPTION_KEY_'.length);
    if (!keyId) continue;
    versionedKeyIds.add(keyId);
    if (DEV_SECRET_VALUES.has(value)) {
      errors.push(`${name} uses a development/default value.`);
    }
    if (!isValidAesGcmKey(value)) {
      errors.push(`${name} must be a base64-encoded 128, 192, or 256-bit AES key.`);
    }
  }

  const activeKeyId = env.ENCRYPTION_ACTIVE_KEY_ID?.trim();
  if (activeKeyId && activeKeyId !== 'v0' && !versionedKeyIds.has(activeKeyId)) {
    errors.push(
      `ENCRYPTION_ACTIVE_KEY_ID='${activeKeyId}' has no matching ENCRYPTION_KEY_${activeKeyId}.`,
    );
  }

  const databaseUrl = env.DATABASE_URL;
  const databaseSslMode = env.DATABASE_SSL_MODE?.trim().toLowerCase();
  if (databaseUrl && databaseSslMode !== 'disable' && !hasRequiredSslMode(databaseUrl)) {
    errors.push('DATABASE_URL must include sslmode=require, sslmode=verify-ca, or sslmode=verify-full in production. Set DATABASE_SSL_MODE=disable only for private test stacks without DB TLS.');
  }

  if (env.CORS_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).includes('*')) {
    errors.push('CORS_ALLOWED_ORIGINS must not contain * in production.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
  }
}

function isValidAesGcmKey(value: string): boolean {
  try {
    const normalized = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false;
    const raw = Buffer.from(normalized, 'base64');
    return [16, 24, 32].includes(raw.byteLength) && raw.toString('base64') === normalized;
  } catch {
    return false;
  }
}

function hasRequiredSslMode(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return ['require', 'verify-ca', 'verify-full'].includes(
      url.searchParams.get('sslmode')?.toLowerCase() ?? '',
    );
  } catch {
    return false;
  }
}
