/**
 * Tripwire for the runtime-matrix drift guard (#760).
 *
 * Includes the real incident: Dependabot PR #803 moved the Dockerfile builder
 * to `node:25-slim` while the distroless runtime stayed on Node 22.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFacts,
  findDrift,
  majorOf,
  parseDockerfile,
  parseMatrixList,
  parseNodeVersionEnv,
  parsePinnedTable,
} from '../check-runtime-matrix.mjs';

const ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';

const POLICY = `# Supported runtimes

| Key | Value |
|-----|-------|
| \`.nvmrc\` | \`24\` |
| \`engines.node\` | \`^22.22.2 \\|\\| ^24.15.0 \\|\\| >=26.0.0\` |
| \`matrix.node\` | \`22\`, \`24\` |
| \`matrix.next\` | \`15\`, \`16\` |
| \`docker.builder\` | \`node:22-slim\` |
| \`docker.runtime\` | \`nodejs22-debian13\` |
`;

function facts(overrides = {}) {
  return {
    engines: ENGINES,
    cliEngines: { 'packages/cli/package.json': ENGINES, 'packages/create-lumibase/package.json': ENGINES },
    nodeSupportCopies: [
      { file: 'a', text: 'same' },
      { file: 'b', text: 'same' },
    ],
    nvmrc: 24,
    ciNodeVersion: 24,
    docker: { builder: [22], runtime: [22] },
    matrixNode: [22, 24],
    matrixNext: [15, 16],
    templateNextMajor: 15,
    policyPages: [
      { file: 'en.md', text: POLICY },
      { file: 'vi.md', text: POLICY },
    ],
    ...overrides,
  };
}

test('a consistent repo has no drift', () => {
  assert.deepEqual(findDrift(facts()), []);
});

test('the live repository is consistent', () => {
  assert.deepEqual(findDrift(collectFacts()), []);
});

test('#803: builder on Node 25, runtime on Node 22', () => {
  const errors = findDrift(facts({ docker: { builder: [25], runtime: [22] } }));
  assert.ok(errors.some((e) => e.includes('build on one major and run on another')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('Node 25 is not a CI-tested LTS line')), errors.join('\n'));
});

test('a CI matrix that drops an engines line is drift', () => {
  const errors = findDrift(facts({ matrixNode: [24] }));
  assert.ok(errors.some((e) => e.includes('CI matrix Node lines [24] != engines.node LTS lines [22, 24]')));
});

test('.nvmrc off the matrix, or off ci.yml NODE_VERSION, is drift', () => {
  assert.ok(findDrift(facts({ nvmrc: 25, ciNodeVersion: 25 })).some((e) => e.includes('.nvmrc (25)')));
  assert.ok(findDrift(facts({ ciNodeVersion: 22 })).some((e) => e.includes('NODE_VERSION (22) != .nvmrc (24)')));
  assert.ok(findDrift(facts({ nvmrc: null })).some((e) => e.includes('.nvmrc must name')));
});

test('a CLI that ships a different engines range is drift', () => {
  const errors = findDrift(facts({ cliEngines: { 'packages/cli/package.json': '>=22' } }));
  assert.ok(errors.some((e) => e.includes('packages/cli/package.json engines.node is ">=22"')));
});

test('diverging node-support.js copies are drift', () => {
  const errors = findDrift(
    facts({
      nodeSupportCopies: [
        { file: 'a', text: 'one' },
        { file: 'b', text: 'two' },
      ],
    }),
  );
  assert.ok(errors.some((e) => e.includes('a and b differ')));
});

test('a Next.js template pin outside the matrix is drift', () => {
  const errors = findDrift(facts({ templateNextMajor: 14 }));
  assert.ok(errors.some((e) => e.includes('pins next 14')));
});

test('an unparseable engines range stops the check with one clear finding', () => {
  const errors = findDrift(facts({ engines: 'lts/*' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot be parsed/);
});

test('policy page that lags the repo is drift, per locale', () => {
  const stale = POLICY.replace('`node:22-slim`', '`node:24-slim`');
  const errors = findDrift(
    facts({
      policyPages: [
        { file: 'en.md', text: POLICY },
        { file: 'vi.md', text: stale },
      ],
    }),
  );
  assert.deepEqual(errors, ['vi.md: `docker.builder` documents [node:24-slim] but the repo has [node:22-slim]']);
  const missing = findDrift(facts({ policyPages: [{ file: 'en.md', text: null }] }));
  assert.deepEqual(missing, ['en.md is missing']);
  const noRow = findDrift(facts({ policyPages: [{ file: 'en.md', text: POLICY.replace(/^\| `matrix\.next`.*$/m, '') }] }));
  assert.deepEqual(noRow, ['en.md: "Pinned values" table has no `matrix.next` row']);
});

test('parsers', () => {
  const dockerfile = [
    'FROM node:22-slim@sha256:abc AS builder',
    'RUN echo FROM node:99',
    'FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:def AS runtime',
  ].join('\n');
  assert.deepEqual(parseDockerfile(dockerfile), { builder: [22], runtime: [22] });

  const workflow = "    matrix:\n        node: [24, 22]\n        next: ['16', \"15\"]\n";
  assert.deepEqual(parseMatrixList(workflow, 'node'), [22, 24]);
  assert.deepEqual(parseMatrixList(workflow, 'next'), [15, 16]);
  assert.equal(parseMatrixList(workflow, 'missing'), null);
  assert.equal(parseMatrixList(`${workflow}${workflow}`, 'node'), null);

  assert.equal(parseNodeVersionEnv('env:\n  NODE_VERSION: 24\n'), 24);
  assert.equal(parseNodeVersionEnv("env:\n  NODE_VERSION: '22'\n"), 22);
  assert.equal(parseNodeVersionEnv('env: {}'), null);

  assert.equal(majorOf('^15.5.4'), 15);
  assert.equal(majorOf(undefined), null);

  const table = parsePinnedTable(POLICY);
  assert.deepEqual(table.get('engines.node'), [ENGINES]);
  assert.deepEqual(table.get('matrix.node'), ['22', '24']);
  assert.equal(table.get('Key'), undefined);
});
