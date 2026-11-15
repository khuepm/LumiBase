/**
 * Node.js support check of the `lumibase` / `create-lumibase` bin shims (#760).
 *
 * The range under test is the real root `engines.node`, read from disk, so the
 * cases below are the policy itself: 22 and 24 LTS from their floors, 26+ open,
 * odd non-LTS 23/25 warn, anything below 22 fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  checkNodeVersion,
  describeRange,
  enforceNodeSupport,
  formatNodeMessage,
  hardMinimumMajor,
  parseRange,
  parseVersion,
  satisfies,
} from '../../packages/cli/bin/node-support.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINES = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node;

test('the root engines range is the one the policy documents', () => {
  assert.equal(ENGINES, '^22.22.2 || ^24.15.0 || >=26.0.0');
});

test('parseVersion reads process.version shapes', () => {
  assert.deepEqual(parseVersion('v22.23.4'), [22, 23, 4]);
  assert.deepEqual(parseVersion('27.0.0-alpha.0.1.0'), [27, 0, 0]);
  assert.deepEqual(parseVersion('24'), [24, 0, 0]);
  assert.equal(parseVersion('banana'), null);
});

test('satisfies follows npm semantics for the forms the repo uses', () => {
  for (const [version, expected] of [
    ['v22.22.2', true],
    ['v22.23.4', true],
    ['v22.22.1', false],
    ['v22.12.0', false],
    ['v23.11.0', false],
    ['v24.14.9', false],
    ['v24.15.0', true],
    ['v25.2.0', false],
    ['v26.0.0', true],
    ['v27.0.0', true],
    ['v20.19.0', false],
  ]) {
    assert.equal(satisfies(version, ENGINES), expected, version);
  }
  assert.equal(satisfies('1.2.3', '>=1.2.3 <2'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.3 <2'), false);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('1.2.9', '~1.2.0'), true);
  assert.equal(satisfies('22.9.0', '22'), true);
  assert.equal(satisfies('22.9.0', '<=21'), false);
  assert.equal(satisfies('18.0.0', '>=18'), true);
});

test('an unknown range syntax throws instead of being misread', () => {
  assert.throws(() => parseRange('node-lts'), /unsupported engines range token/);
  assert.throws(() => parseRange(''), /empty/);
});

test('hard minimum is the lowest major the range admits', () => {
  assert.equal(hardMinimumMajor(ENGINES), 22);
  assert.equal(hardMinimumMajor('>=18'), 18);
  assert.equal(hardMinimumMajor('<30'), 0);
});

test('describeRange separates pinned LTS lines from the open lane', () => {
  assert.deepEqual(describeRange(ENGINES), { lines: [22, 24], openFrom: 26 });
  assert.deepEqual(describeRange('>=22.13.0'), { lines: [], openFrom: 22 });
});

test('classification: ok inside the range, warn between floor and range, fail below the floor', () => {
  assert.equal(checkNodeVersion('v24.22.1', ENGINES).status, 'ok');
  assert.equal(checkNodeVersion('v26.13.1', ENGINES).status, 'ok');
  // Odd, non-LTS line (#803 tried to build the image on it): warn, keep going.
  assert.equal(checkNodeVersion('v25.2.0', ENGINES).status, 'unsupported');
  assert.equal(checkNodeVersion('v23.0.0', ENGINES).status, 'unsupported');
  // A 22.x below the declared patch floor: warn, not fail.
  assert.equal(checkNodeVersion('v22.12.0', ENGINES).status, 'unsupported');
  assert.deepEqual(checkNodeVersion('v20.19.0', ENGINES), { status: 'too-old', minimum: 22 });
  assert.deepEqual(checkNodeVersion('v18.20.0', ENGINES), { status: 'too-old', minimum: 22 });
});

test('enforceNodeSupport warns without exiting outside the range', () => {
  const written = [];
  const exits = [];
  const status = enforceNodeSupport({
    name: 'create-lumibase',
    version: 'v25.2.0',
    range: ENGINES,
    write: (text) => written.push(text),
    exit: (code) => exits.push(code),
  });
  assert.equal(status, 'unsupported');
  assert.deepEqual(exits, []);
  assert.match(written[0], /^Warning: create-lumibase is not supported on Node\.js v25\.2\.0/);
  assert.match(written[0], /supported-runtimes/);
});

test('enforceNodeSupport fails with a clear message below the hard minimum', () => {
  const written = [];
  const exits = [];
  const status = enforceNodeSupport({
    name: 'lumibase',
    version: 'v20.19.0',
    range: ENGINES,
    write: (text) => written.push(text),
    exit: (code) => exits.push(code),
  });
  assert.equal(status, 'too-old');
  assert.deepEqual(exits, [1]);
  assert.match(written[0], /^lumibase requires Node\.js 22 or newer\. Current: v20\.19\.0\./);
  assert.ok(written[0].includes(ENGINES));
});

test('enforceNodeSupport is silent on a supported runtime', () => {
  const written = [];
  const status = enforceNodeSupport({
    name: 'lumibase',
    version: 'v24.15.0',
    range: ENGINES,
    write: (text) => written.push(text),
    exit: () => assert.fail('must not exit'),
  });
  assert.equal(status, 'ok');
  assert.deepEqual(written, []);
});

test('enforceNodeSupport reads the shipping package.json when no range is passed', () => {
  for (const pkg of ['cli', 'create-lumibase']) {
    const written = [];
    const status = enforceNodeSupport({
      name: pkg,
      version: 'v25.0.0',
      packageJsonUrl: new URL(`../../packages/${pkg}/package.json`, import.meta.url),
      write: (text) => written.push(text),
      exit: () => assert.fail('must not exit'),
    });
    assert.equal(status, 'unsupported', pkg);
    assert.ok(written[0].includes(ENGINES), pkg);
  }
});

test('a broken manifest never bricks the CLI', () => {
  const status = enforceNodeSupport({
    name: 'lumibase',
    version: 'v10.0.0',
    packageJsonUrl: new URL('./does-not-exist.json', import.meta.url),
    write: () => assert.fail('must not write'),
    exit: () => assert.fail('must not exit'),
  });
  assert.equal(status, 'ok');
});

test('formatNodeMessage is empty for ok', () => {
  assert.equal(formatNodeMessage('x', 'v24.0.0', ENGINES, { status: 'ok' }), '');
});

test('both bin shims run the check before loading dist/', () => {
  for (const shim of ['packages/cli/bin/lumibase.js', 'packages/create-lumibase/bin/create-lumibase.js']) {
    const text = readFileSync(join(root, shim), 'utf8');
    const check = text.indexOf('enforceNodeSupport({');
    const load = text.indexOf("import('../dist/index.js')");
    assert.ok(check > -1 && load > check, `${shim} must call enforceNodeSupport before importing dist/`);
    assert.match(text, /import \{ enforceNodeSupport \} from '\.\/node-support\.js';/);
  }
});

test('the shim does not warn on the Node running this test (a matrix line)', () => {
  // Executes the real shim: dist/ may be missing in an unbuilt checkout, so only
  // the stderr prefix written by the check is asserted, not the exit code.
  const result = spawnSync(process.execPath, [join(root, 'packages/cli/bin/lumibase.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.doesNotMatch(result.stderr, /not supported on Node\.js|requires Node\.js/);
});
