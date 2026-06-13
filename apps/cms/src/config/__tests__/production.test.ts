import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { loadSecretFiles, validateProductionConfig } from '../production';

const VALID_KEY = Buffer.alloc(32, 1).toString('base64');

function validEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LUMIBASE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/lumibase?sslmode=require',
    REDIS_URL: 'rediss://redis.example.com:6379',
    JWT_SECRET: 'prod-jwt-secret-with-enough-entropy',
    ENCRYPTION_KEY: VALID_KEY,
    CORS_ALLOWED_ORIGINS: 'https://studio.example.com',
    ...extra,
  };
}

describe('production config validation', () => {
  it('accepts a hardened production environment', () => {
    expect(() => validateProductionConfig(validEnv())).not.toThrow();
  });

  it('fails when required production values are missing', () => {
    expect(() => validateProductionConfig(validEnv({ ENCRYPTION_KEY: '' }))).toThrow(
      /ENCRYPTION_KEY is required/,
    );
  });

  it('rejects development auth and default secrets', () => {
    expect(() =>
      validateProductionConfig(
        validEnv({
          LUMIBASE_DEV_AUTH: 'true',
          JWT_SECRET: 'dev_secret_key',
        }),
      ),
    ).toThrow(/LUMIBASE_DEV_AUTH must not be true/);
  });

  it('requires database TLS unless explicitly disabled', () => {
    expect(() =>
      validateProductionConfig(
        validEnv({
          DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/lumibase',
        }),
      ),
    ).toThrow(/DATABASE_URL must include sslmode/);

    expect(() =>
      validateProductionConfig(
        validEnv({
          DATABASE_URL: 'postgresql://user:pass@postgres:5432/lumibase',
          DATABASE_SSL_MODE: 'disable',
        }),
      ),
    ).not.toThrow();
  });

  it('loads supported secrets from *_FILE variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumibase-config-'));
    const secretPath = join(dir, 'jwt_secret');
    writeFileSync(secretPath, 'secret-from-file\n');

    const env: NodeJS.ProcessEnv = { JWT_SECRET_FILE: secretPath };
    loadSecretFiles(env);

    expect(env.JWT_SECRET).toBe('secret-from-file');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path traversal attempts in *_FILE variables', () => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET_FILE: '../../../../../../etc/passwd' };
    expect(() => loadSecretFiles(env)).toThrow(/Access Denied: Path Traversal detected/);
  });
});
