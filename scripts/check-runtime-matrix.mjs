#!/usr/bin/env node
/**
 * Keep every place that names a supported Node.js / Next.js version in step
 * (#760, epic #677 X09).
 *
 * The runtime support matrix is declared in six places that nothing tied
 * together:
 *
 *   .nvmrc                                  local dev line
 *   package.json → engines.node             what installs / runs at all
 *   packages/{cli,create-lumibase}          what the published CLIs accept
 *     package.json → engines.node
 *   docker/Dockerfile                       builder `node:<M>-slim` and runtime
 *                                           `distroless/nodejs<M>-debian13`
 *   .github/workflows/runtime-matrix.yml    the Node / Next.js lines CI proves
 *   .github/workflows/ci.yml NODE_VERSION   the line the main gate runs on
 *   docs/{en,vi}/contributing/supported-runtimes.md   the published promise
 *
 * Dependabot PR #803 is the failure this catches: it moved the Docker builder
 * to `node:25-slim` (non-LTS, no corepack) while the distroless runtime stayed
 * on Node 22 — an image built on one major and run on another, with nothing
 * on the PR saying so. The rules:
 *
 *   1. engines.node parses, and both CLIs ship exactly the root range (the
 *      bin shims read it as their single source of truth).
 *   2. The two copies of `bin/node-support.js` are byte-identical.
 *   3. The CI matrix's Node lines == the bounded LTS lines of engines.node
 *      (`^22.x || ^24.x` → [22, 24]).
 *   4. `.nvmrc` and ci.yml `NODE_VERSION` name the same major, and it is a
 *      matrix line.
 *   5. Dockerfile builder major == runtime major, and it is a matrix line.
 *   6. The scaffolded Next.js template's `next` major is a CI matrix line.
 *   7. Both locales of the policy page carry the same values in their
 *      "Pinned values" table.
 *
 * Dependency-free on purpose (text parsing only), like the other repo guards,
 * so it runs before and without an install.
 *
 * Usage:  node scripts/check-runtime-matrix.mjs
 * Exit:   0 = consistent · 1 = drift (each finding printed)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describeRange, parseRange } from '../packages/cli/bin/node-support.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = {
  nvmrc: '.nvmrc',
  rootPackage: 'package.json',
  cliPackages: ['packages/cli/package.json', 'packages/create-lumibase/package.json'],
  nodeSupport: ['packages/cli/bin/node-support.js', 'packages/create-lumibase/bin/node-support.js'],
  dockerfile: 'docker/Dockerfile',
  matrixWorkflow: '.github/workflows/runtime-matrix.yml',
  ciWorkflow: '.github/workflows/ci.yml',
  nextTemplate: 'packages/create-lumibase/templates/nextjs/package.json.hbs',
  policyPages: ['docs/en/contributing/supported-runtimes.md', 'docs/vi/contributing/supported-runtimes.md'],
};

/** Majors of the Dockerfile's builder (`FROM node:<M>…`) and runtime (`distroless/nodejs<M>-…`). */
export function parseDockerfile(text) {
  const builder = [...text.matchAll(/^FROM\s+(?:docker\.io\/(?:library\/)?)?node:(\d+)[^\s]*/gm)].map((m) => Number(m[1]));
  const runtime = [...text.matchAll(/^FROM\s+gcr\.io\/distroless\/nodejs(\d+)-[^\s]*/gm)].map((m) => Number(m[1]));
  return { builder, runtime };
}

/** `node: [22, 24]` / `next: ['15', '16']` flow sequences from the matrix workflow. */
export function parseMatrixList(text, key) {
  const matches = [...text.matchAll(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'gm'))];
  if (matches.length !== 1) return null;
  return matches[0][1]
    .split(',')
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

export function parseNodeVersionEnv(text) {
  const match = /^\s+NODE_VERSION:\s*['"]?(\d+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** Major of a semver range/spec such as `^15.5.4` → 15. */
export function majorOf(spec) {
  const match = /(\d+)/.exec(String(spec ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The policy page's "Pinned values" table: every row whose first cell is a
 * single code span is a key; its value is the list of code spans in the
 * second cell (`\|` unescaped, as GFM requires inside table cells).
 */
export function parsePinnedTable(markdown) {
  const rows = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/\\\|/g, '\u0000')
      .split('|')
      .slice(1, -1)
      .map((c) => c.replace(/\u0000/g, '|').trim());
    if (cells.length < 2) continue;
    const key = /^`([^`]+)`$/.exec(cells[0]);
    if (!key) continue;
    const values = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.set(key[1], values);
  }
  return rows;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const fmt = (list) => `[${list.join(', ')}]`;

/** Pure: facts in, findings out. */
export function findDrift(facts) {
  const errors = [];
  let range;
  try {
    parseRange(facts.engines);
    range = describeRange(facts.engines);
  } catch (error) {
    errors.push(`package.json engines.node "${facts.engines}" cannot be parsed: ${error.message}`);
    return errors;
  }

  for (const [file, value] of Object.entries(facts.cliEngines)) {
    if (value !== facts.engines) {
      errors.push(`${file} engines.node is "${value}" but the root declares "${facts.engines}" — the CLI warns from its own engines, so they must match`);
    }
  }

  if (facts.nodeSupportCopies.length > 1 && new Set(facts.nodeSupportCopies.map((c) => c.text)).size !== 1) {
    errors.push(`${facts.nodeSupportCopies.map((c) => c.file).join(' and ')} differ — edit one, copy it to the other`);
  }

  const matrixNode = facts.matrixNode;
  if (!matrixNode) {
    errors.push(`${FILES.matrixWorkflow}: expected exactly one \`node: [...]\` matrix list`);
  } else if (!sameList(matrixNode, range.lines)) {
    errors.push(`CI matrix Node lines ${fmt(matrixNode)} != engines.node LTS lines ${fmt(range.lines)} ("${facts.engines}")`);
  }

  const lines = matrixNode ?? range.lines;
  if (facts.nvmrc === null) {
    errors.push('.nvmrc must name a Node major (e.g. `24`)');
  } else {
    if (!lines.includes(facts.nvmrc)) errors.push(`.nvmrc (${facts.nvmrc}) is not a CI-tested Node line ${fmt(lines)}`);
    if (facts.ciNodeVersion !== null && facts.ciNodeVersion !== facts.nvmrc) {
      errors.push(`${FILES.ciWorkflow} NODE_VERSION (${facts.ciNodeVersion}) != .nvmrc (${facts.nvmrc}) — local dev and the main gate run different majors`);
    }
  }

  const { builder, runtime } = facts.docker;
  if (builder.length === 0 || runtime.length === 0) {
    errors.push(`${FILES.dockerfile}: expected a \`FROM node:<major>…\` builder and a \`FROM gcr.io/distroless/nodejs<major>-…\` runtime`);
  } else {
    const majors = [...new Set([...builder, ...runtime])];
    if (majors.length !== 1) {
      errors.push(`${FILES.dockerfile}: builder Node ${fmt(builder)} and runtime Node ${fmt(runtime)} differ — the image would build on one major and run on another (#803)`);
    }
    for (const major of majors) {
      if (!lines.includes(major)) errors.push(`${FILES.dockerfile}: Node ${major} is not a CI-tested LTS line ${fmt(lines)}`);
    }
  }

  const matrixNext = facts.matrixNext;
  if (!matrixNext) {
    errors.push(`${FILES.matrixWorkflow}: expected exactly one \`next: [...]\` matrix list`);
  } else if (facts.templateNextMajor !== null && !matrixNext.includes(facts.templateNextMajor)) {
    errors.push(`the Next.js template pins next ${facts.templateNextMajor}, which the CI matrix ${fmt(matrixNext)} does not test`);
  }

  const expected = new Map([
    ['.nvmrc', facts.nvmrc === null ? [] : [String(facts.nvmrc)]],
    ['engines.node', [facts.engines]],
    ['matrix.node', (matrixNode ?? []).map(String)],
    ['matrix.next', (matrixNext ?? []).map(String)],
    ['docker.builder', builder.map((m) => `node:${m}-slim`)],
    ['docker.runtime', runtime.map((m) => `nodejs${m}-debian13`)],
  ]);
  for (const page of facts.policyPages) {
    if (page.text === null) {
      errors.push(`${page.file} is missing`);
      continue;
    }
    const table = parsePinnedTable(page.text);
    for (const [key, values] of expected) {
      const documented = table.get(key);
      if (!documented) {
        errors.push(`${page.file}: "Pinned values" table has no \`${key}\` row`);
      } else if (!sameList(documented, values)) {
        errors.push(`${page.file}: \`${key}\` documents ${fmt(documented)} but the repo has ${fmt(values)}`);
      }
    }
  }

  return errors;
}

function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

export function collectFacts() {
  const engines = JSON.parse(read(FILES.rootPackage)).engines?.node ?? '';
  const cliEngines = Object.fromEntries(
    FILES.cliPackages.map((f) => [f, JSON.parse(read(f) ?? '{}').engines?.node ?? '(none)']),
  );
  const nvmrcText = (read(FILES.nvmrc) ?? '').trim();
  const nvmrc = /^v?(\d+)(\.\d+){0,2}$/.test(nvmrcText) ? majorOf(nvmrcText) : null;
  const matrixText = read(FILES.matrixWorkflow) ?? '';
  // The template is Handlebars-wrapped JSON; `{{…}}` only appears in values.
  const templateText = read(FILES.nextTemplate) ?? '{}';
  const templateNext = /"next":\s*"([^"]+)"/.exec(templateText)?.[1];
  return {
    engines,
    cliEngines,
    nodeSupportCopies: FILES.nodeSupport.map((file) => ({ file, text: read(file) })),
    nvmrc,
    ciNodeVersion: parseNodeVersionEnv(read(FILES.ciWorkflow) ?? ''),
    docker: parseDockerfile(read(FILES.dockerfile) ?? ''),
    matrixNode: parseMatrixList(matrixText, 'node'),
    matrixNext: parseMatrixList(matrixText, 'next'),
    templateNextMajor: templateNext ? majorOf(templateNext) : null,
    policyPages: FILES.policyPages.map((file) => ({ file, text: read(file) })),
  };
}

function main() {
  const errors = findDrift(collectFacts());
  if (errors.length > 0) {
    console.error('Runtime support matrix drift:\n');
    for (const error of errors) console.error(`  ✖ ${error}`);
    console.error('\nSee docs/en/contributing/supported-runtimes.md → "Changing the matrix".');
    process.exit(1);
  }
  console.log('Runtime support matrix consistent (.nvmrc, engines, Dockerfile, CI matrix, policy page).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
