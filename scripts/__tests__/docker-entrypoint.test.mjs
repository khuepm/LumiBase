// Production image entrypoint helpers (#734). The entrypoint itself is
// exercised against a real PostgreSQL/Redis by the image smoke jobs in CI; this
// covers the decisions it makes about the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECRET_FILE_VARS, healthPort, loadSecretFiles } from '../../docker/scripts/entrypoint-lib.mjs';

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

test('healthPort follows the process role like serve.ts', () => {
  assert.equal(healthPort({}), 1989);
  assert.equal(healthPort({ PORT: '8080' }), 8080);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'worker' }), 1988);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'WORKER', PORT: '8080' }), 8081);
  assert.equal(healthPort({ LUMIBASE_PROCESS_ROLE: 'worker', LUMIBASE_WORKER_HEALTH_PORT: '9000' }), 9000);
});
