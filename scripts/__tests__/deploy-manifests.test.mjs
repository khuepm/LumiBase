// One-click deploy manifests (#741): render.yaml, fly.toml, railway.json and
// the Railway template variables. None of them can be exercised without an
// account on each platform, so this pins the properties that decide whether a
// fresh deploy reaches the setup wizard: every variable production refuses to
// start without is provided or derived, no secret value is committed, setup is
// token-gated, and the port and health path match what the image serves.
//
// Plain-text checks on purpose: the root workspace has no YAML/TOML parser as a
// dependency, and the assertions below are about keys and values, not layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REQUIRED_PRODUCTION_VARS } from '../../docker/scripts/entrypoint-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');
const dockerfile = read('docker/Dockerfile');
const exposedPort = dockerfile.match(/^EXPOSE (\d+)$/m)?.[1];

/** Each platform injects a variable the entrypoint derives the origin from. */
const DERIVED = new Set(['CORS_ALLOWED_ORIGINS']);
const SECRETS = ['JWT_SECRET', 'ENCRYPTION_KEY'];

test('the image still exposes the port every manifest targets', () => {
  assert.equal(exposedPort, '1989');
});

test('render.yaml provides every required variable without committing a secret', () => {
  const yaml = read('render.yaml');
  const keys = [...yaml.matchAll(/^\s*- key: ([A-Z0-9_]+)$/gm)].map((m) => m[1]);
  for (const name of REQUIRED_PRODUCTION_VARS) {
    if (DERIVED.has(name)) continue;
    assert.ok(keys.includes(name), `${name} missing from render.yaml`);
  }
  for (const name of SECRETS) {
    assert.match(yaml, new RegExp(`- key: ${name}\\n\\s+generateValue: true\\n`), `${name} must use generateValue`);
  }
  assert.match(yaml, /- key: DATABASE_URL\n\s+fromDatabase:\n\s+name: lumibase-db\n\s+property: connectionString/);
  assert.match(yaml, /- key: REDIS_URL\n\s+fromService:\n\s+type: keyvalue\n\s+name: lumibase-redis\n\s+property: connectionString/);
  assert.match(yaml, /- key: LUMIBASE_REQUIRE_SETUP_TOKEN\n\s+value: "true"/);
  assert.match(yaml, /- key: NODE_ENV\n\s+value: production/);
  assert.match(yaml, new RegExp(`- key: PORT\\n\\s+value: "${exposedPort}"`));
  assert.match(yaml, /healthCheckPath: \/health$/m);
  assert.match(yaml, /maxmemoryPolicy: noeviction/, 'BullMQ needs a non-evicting Redis');
});

test('fly.toml: no secrets in [env], setup gated, port/health/signal match the image', () => {
  const toml = read('fly.toml');
  const env = toml.match(/^\[env\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
  for (const name of [...SECRETS, 'DATABASE_URL', 'REDIS_URL']) {
    assert.doesNotMatch(env, new RegExp(`^\\s*${name}\\s*=`, 'm'), `${name} must be a Fly secret, not [env]`);
  }
  assert.match(env, /^\s*LUMIBASE_REQUIRE_SETUP_TOKEN = "true"$/m);
  assert.match(env, /^\s*NODE_ENV = "production"$/m);
  assert.match(env, new RegExp(`^\\s*PORT = "${exposedPort}"$`, 'm'));
  assert.match(toml, new RegExp(`^\\s*internal_port = ${exposedPort}$`, 'm'));
  assert.match(toml, /^\s*path = "\/health"$/m);
  assert.match(toml, /^kill_signal = "SIGTERM"$/m, 'serve.ts drains on SIGTERM only');
  assert.match(toml, /^\s*auto_stop_machines = "off"$/m, 'a stopped machine runs no scheduler or workers');
});

test('railway.json builds the production Dockerfile and checks /health', () => {
  const config = JSON.parse(read('railway.json'));
  assert.equal(config.build.builder, 'DOCKERFILE');
  assert.ok(existsSync(root + config.build.dockerfilePath), config.build.dockerfilePath);
  assert.equal(config.deploy.healthcheckPath, '/health');
});

test('Railway template variables cover production and generate valid secrets', () => {
  const { variables } = JSON.parse(read('docker/railway-template-variables.json'));
  for (const name of REQUIRED_PRODUCTION_VARS) assert.ok(variables[name], `${name} missing`);
  assert.equal(variables.LUMIBASE_REQUIRE_SETUP_TOKEN, 'true');
  assert.match(variables.JWT_SECRET, /^\$\{\{secret\(\d+\)\}\}$/);
  assert.ok(Number(variables.JWT_SECRET.match(/\d+/)[0]) >= 32, 'JWT_SECRET needs at least 32 chars');

  // Expand the ENCRYPTION_KEY recipe the way Railway does and run the same
  // check `validateProductionConfig` applies (canonical base64, 16/24/32 bytes).
  const recipe = variables.ENCRYPTION_KEY.match(/^\$\{\{secret\((\d+), "([^"]+)"\)\}\}(.*)$/);
  assert.ok(recipe, 'ENCRYPTION_KEY must be a secret(length, alphabet) recipe');
  const [, length, alphabet, suffix] = recipe;
  for (let i = 0; i < 500; i++) {
    let value = '';
    for (let j = 0; j < Number(length); j++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
    value += suffix;
    const raw = Buffer.from(value, 'base64');
    assert.equal(raw.byteLength, 32, value);
    assert.equal(raw.toString('base64'), value, `non-canonical key: ${value}`);
  }
});

test('no manifest commits a value for a secret', () => {
  const sources = ['render.yaml', 'fly.toml', 'railway.json', 'docker/railway-template-variables.json'];
  for (const rel of sources) {
    // Railway's secret(length, alphabet) recipes carry the base64 alphabet.
    const text = read(rel).replace(/\$\{\{secret\([^)]*\)\}\}/g, '');
    // A long opaque token anywhere is a red flag (keys, passwords, tokens).
    assert.doesNotMatch(text, /[A-Za-z0-9+/_-]{40,}={0,2}/, `${rel} looks like it contains a secret`);
  }
});
