// Production image entrypoint helpers (#734, #741). The entrypoint itself is
// exercised against a real PostgreSQL/Redis by the image smoke jobs in CI; this
// covers the decisions it makes about the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PRODUCTION_VARS,
  SECRET_FILE_VARS,
  applyDefaultCorsOrigin,
  corsOriginsHaveNoHost,
  encryptionKeyProblem,
  exitsAfterPreflight,
  healthPort,
  loadSecretFiles,
  missingProductionVars,
  resolvePublicUrl,
} from '../../docker/scripts/entrypoint-lib.mjs';

const entrypoint = fileURLToPath(new URL('../../docker/scripts/entrypoint.mjs', import.meta.url));

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

test('applyDefaultCorsOrigin treats an origin without a host as unset', () => {
  for (const hostless of ['https://', 'http://', ' https:// ', 'https://, ']) {
    assert.equal(corsOriginsHaveNoHost(hostless), true, hostless);
    const env = { CORS_ALLOWED_ORIGINS: hostless };
    assert.equal(applyDefaultCorsOrigin(env, 'https://a.example'), 'https://a.example');
    assert.equal(env.CORS_ALLOWED_ORIGINS, 'https://a.example');
    const noOrigin = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: hostless };
    assert.equal(applyDefaultCorsOrigin(noOrigin, undefined), undefined);
    assert.ok(missingProductionVars(noOrigin).includes('CORS_ALLOWED_ORIGINS'), hostless);
  }
  for (const real of [undefined, '', 'https://a.example', 'https://, https://b.example', 'http://localhost:2026']) {
    assert.equal(corsOriginsHaveNoHost(real), false, String(real));
  }
});

// The server's own check, copied from production.ts so the two cannot drift
// apart silently: the entrypoint must refuse exactly what the server refuses.
const serverAcceptsKey = (() => {
  const body = productionTs.match(/function isValidAesGcmKey\(value: string\): boolean \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'isValidAesGcmKey not found in production.ts');
  return new Function('value', body);
})();

test('encryptionKeyProblem refuses exactly what the server refuses, in production only', () => {
  const bytes = Buffer.alloc(32, 0xfb);
  const keys = [
    bytes.toString('base64'),
    bytes.toString('base64url'), // URL-safe, unpadded: the server rejects it
    Buffer.alloc(16, 7).toString('base64'),
    Buffer.alloc(24, 9).toString('base64'),
    Buffer.alloc(16, 7).toString('base64').replace(/=+$/, ''),
    Buffer.alloc(20).toString('base64'),
    `  ${bytes.toString('base64')}\t`,
    'dev_secret_key',
    'short',
  ];
  for (const key of keys) {
    const env = { NODE_ENV: 'production', ENCRYPTION_KEY: key };
    assert.equal(encryptionKeyProblem(env) === undefined, serverAcceptsKey(key), JSON.stringify(key));
    assert.equal(env.ENCRYPTION_KEY, key, 'never rewritten');
    assert.equal(encryptionKeyProblem({ ENCRYPTION_KEY: key }), undefined, 'not checked outside production');
  }
  assert.match(encryptionKeyProblem({ LUMIBASE_ENV: 'production', ENCRYPTION_KEY: 'x' }), /ENCRYPTION_KEY .*openssl rand -base64 32/);
  assert.equal(encryptionKeyProblem({ NODE_ENV: 'production' }), undefined, 'missing is reported elsewhere');
});

test('exitsAfterPreflight matches the MIGRATION_MODE contract', () => {
  assert.equal(exitsAfterPreflight({}), false);
  assert.equal(exitsAfterPreflight({ MIGRATION_MODE: 'preflight' }), true);
  assert.equal(exitsAfterPreflight({ MIGRATION_MODE: 'dry-run' }), true);
  assert.equal(exitsAfterPreflight({ MIGRATION_MODE: 'apply' }), false);
  assert.equal(exitsAfterPreflight({ MIGRATION_MODE: 'preflight', SKIP_MIGRATIONS: 'true' }), false);
  assert.equal(exitsAfterPreflight({ MIGRATION_MODE: 'dry-run', RUN_MIGRATION_PREFLIGHT: 'false' }), false);
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

// End to end through entrypoint.mjs, with stand-ins for the two bundles: the
// migration runner records its command, the "server" records the environment
// it was loaded with. This is the contract the image runs under.
function runEntrypoint(env) {
  const app = mkdtempSync(join(tmpdir(), 'lumibase-entrypoint-'));
  try {
    mkdirSync(join(app, 'dist'));
    const log = join(app, 'calls.log');
    writeFileSync(
      join(app, 'dist/migrate.cjs'),
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'migrate ' + process.argv[2] + '\\n');`,
    );
    writeFileSync(
      join(app, 'dist/serve.cjs'),
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'serve ' + JSON.stringify({
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
        CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
      }) + '\\n'); process.exit(0);`,
    );
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: app,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      // nothing ran
    }
    return { status: result.status, output: result.stdout + result.stderr, calls };
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://db/lumibase',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'j'.repeat(64),
  CORS_ALLOWED_ORIGINS: 'https://cms.example.com',
};

test('entrypoint hands ENCRYPTION_KEY to the server byte-for-byte', () => {
  for (const key of [
    Buffer.alloc(32, 0xfb).toString('base64'),
    ` ${Buffer.alloc(16, 0xfe).toString('base64')} `,
  ]) {
    const run = runEntrypoint({ ...productionEnv, ENCRYPTION_KEY: key });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.calls.slice(0, 2), ['migrate preflight', 'migrate apply']);
    const served = JSON.parse(run.calls[2].slice('serve '.length));
    assert.equal(served.ENCRYPTION_KEY, key);
  }
});

test('entrypoint stops before migrating when the server would reject ENCRYPTION_KEY', () => {
  const urlSafe = Buffer.alloc(32, 0xfb).toString('base64url');
  const run = runEntrypoint({ ...productionEnv, ENCRYPTION_KEY: urlSafe });
  assert.equal(run.status, 1);
  assert.deepEqual(run.calls, [], 'nothing ran');
  assert.match(run.output, /ENCRYPTION_KEY must be a base64-encoded 128, 192, or 256-bit AES key/);
});

test('MIGRATION_MODE=preflight|dry-run needs only DATABASE_URL, even in production', () => {
  for (const mode of ['preflight', 'dry-run']) {
    const run = runEntrypoint({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x', MIGRATION_MODE: mode });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.calls, ['migrate preflight'], mode);
  }
  // Without the mode the same environment is refused before the database.
  const run = runEntrypoint({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x' });
  assert.equal(run.status, 1);
  assert.deepEqual(run.calls, []);
  assert.match(run.output, /Missing required production configuration: REDIS_URL, JWT_SECRET, ENCRYPTION_KEY, CORS_ALLOWED_ORIGINS/);
});

test('a hostless CORS_ALLOWED_ORIGINS yields to the platform origin, or stops with a hint', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const fallback = runEntrypoint({
    ...productionEnv,
    ENCRYPTION_KEY: key,
    CORS_ALLOWED_ORIGINS: 'https://',
    RAILWAY_PUBLIC_DOMAIN: 'cms.up.railway.app',
  });
  assert.equal(fallback.status, 0, fallback.output);
  assert.equal(JSON.parse(fallback.calls.at(-1).slice('serve '.length)).CORS_ALLOWED_ORIGINS, 'https://cms.up.railway.app');

  const none = runEntrypoint({ ...productionEnv, ENCRYPTION_KEY: key, CORS_ALLOWED_ORIGINS: 'https://' });
  assert.equal(none.status, 1);
  assert.deepEqual(none.calls, []);
  assert.match(none.output, /names no host/);
  assert.match(none.output, /Missing required production configuration: CORS_ALLOWED_ORIGINS\..*LUMIBASE_PUBLIC_URL/);
});
