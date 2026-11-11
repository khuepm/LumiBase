// Production image entrypoint helpers (#734, #741). The entrypoint itself is
// exercised against a real PostgreSQL/Redis by the image smoke jobs in CI; this
// covers the decisions it makes about the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PRODUCTION_VARS,
  SECRET_FILE_VARS,
  applyDefaultCorsOrigin,
  healthPort,
  loadSecretFiles,
  missingProductionVars,
  normalizeEncryptionKey,
  resolvePublicUrl,
} from '../../docker/scripts/entrypoint-lib.mjs';

const productionTs = readFileSync(
  fileURLToPath(new URL('../../apps/cms/src/config/production.ts', import.meta.url)),
  'utf8',
);
const tsList = (name) => {
  const body = productionTs.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`))?.[1];
  assert.ok(body, `${name} not found in production.ts`);
  return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
};

test('variable lists stay in step with apps/cms/src/config/production.ts', () => {
  assert.deepEqual([...REQUIRED_PRODUCTION_VARS], tsList('REQUIRED_PRODUCTION_VARS'));
  assert.deepEqual([...SECRET_FILE_VARS], tsList('SECRET_FILE_VARS'));
});

test('loadSecretFiles: file fills an unset variable, direct value wins, unreadable fails', () => {
  const env = { JWT_SECRET_FILE: '/run/secrets/jwt', REDIS_URL: 'redis://direct', REDIS_URL_FILE: '/x' };
  const loaded = loadSecretFiles(env, () => 'from-file\r\n');
  assert.deepEqual(loaded, ['JWT_SECRET']);
  assert.equal(env.JWT_SECRET, 'from-file');
  assert.equal(env.REDIS_URL, 'redis://direct');
  assert.throws(
    () => loadSecretFiles({ ENCRYPTION_KEY_FILE: '/missing' }, () => { throw new Error('ENOENT'); }),
    /ENCRYPTION_KEY_FILE points to an unreadable file/,
  );
});

test('resolvePublicUrl: explicit setting first, then each platform', () => {
  assert.equal(resolvePublicUrl({}), undefined);
  assert.equal(resolvePublicUrl({ FLY_APP_NAME: 'acme-cms' }), 'https://acme-cms.fly.dev');
  assert.equal(resolvePublicUrl({ RAILWAY_PUBLIC_DOMAIN: 'cms.up.railway.app' }), 'https://cms.up.railway.app');
  assert.equal(resolvePublicUrl({ RENDER_EXTERNAL_URL: 'https://cms.onrender.com/' }), 'https://cms.onrender.com');
  assert.equal(
    resolvePublicUrl({ LUMIBASE_PUBLIC_URL: 'https://cms.example.com/path', FLY_APP_NAME: 'x' }),
    'https://cms.example.com',
  );
  assert.equal(resolvePublicUrl({ LUMIBASE_PUBLIC_URL: 'not a url', FLY_APP_NAME: 'x' }), 'https://x.fly.dev');
});

test('applyDefaultCorsOrigin never overrides an explicit value', () => {
  const unset = { CORS_ALLOWED_ORIGINS: '  ' };
  assert.equal(applyDefaultCorsOrigin(unset, 'https://a.example'), 'https://a.example');
  assert.equal(unset.CORS_ALLOWED_ORIGINS, 'https://a.example');
  const set = { CORS_ALLOWED_ORIGINS: 'https://site.example' };
  assert.equal(applyDefaultCorsOrigin(set, 'https://a.example'), undefined);
  assert.equal(set.CORS_ALLOWED_ORIGINS, 'https://site.example');
  assert.equal(applyDefaultCorsOrigin({}, undefined), undefined);
});

test('normalizeEncryptionKey rewrites URL-safe/unpadded keys without changing the bytes', () => {
  const bytes = Buffer.alloc(32, 0xfb);
  const standard = bytes.toString('base64');
  const env = { ENCRYPTION_KEY: bytes.toString('base64url') };
  assert.equal(normalizeEncryptionKey(env), true);
  assert.equal(env.ENCRYPTION_KEY, standard);
  assert.deepEqual(Buffer.from(env.ENCRYPTION_KEY, 'base64'), bytes);
  assert.equal(normalizeEncryptionKey(env), false, 'already standard');
  for (const bad of ['dev_secret_key', 'short', Buffer.alloc(20).toString('base64')]) {
    const e = { ENCRYPTION_KEY: bad };
    assert.equal(normalizeEncryptionKey(e), false);
    assert.equal(e.ENCRYPTION_KEY, bad);
  }
});

test('missingProductionVars only applies in production', () => {
  assert.deepEqual(missingProductionVars({}), []);
  assert.deepEqual(
    missingProductionVars({ NODE_ENV: 'production', DATABASE_URL: 'x', REDIS_URL: 'y', JWT_SECRET: ' ' }),
    ['JWT_SECRET', 'ENCRYPTION_KEY', 'CORS_ALLOWED_ORIGINS'],
  );
});

test('healthPort follows the process role like serve.ts', () => {
  assert.equal(healthPort({}), 1989);
  assert.equal(healthPort({ PORT: '8080' }), 8080);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'worker' }), 1988);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'WORKER', PORT: '8080' }), 8081);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'worker', LUMIBASE_WORKER_HEALTH_PORT: '9000' }), 9000);
});
