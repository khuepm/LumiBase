#!/usr/bin/env node
/**
 * Scaffold smoke test: generate a project from the working tree, install its
 * dependencies for real, then typecheck it.
 *
 * Why a real install and not a unit test. #450: the Cloudflare template
 * declared `@cloudflare/workers-types@^4.0.0` while the `wrangler@^4` beside it
 * had moved its peer to `^5.<date>`. `npm install` refused the graph with
 * ERESOLVE and nothing in the repo noticed, because no test had ever installed
 * a generated project. The existing unit tests cover argument parsing and file
 * emission; neither can see a peer conflict.
 *
 * Both package managers matter, and for opposite reasons. npm fails hard on an
 * incompatible peer graph, so it is the one that catches the regression. pnpm
 * only warns — it installed the very same wrong graph (`workers-types@4.x`
 * against a wrangler wanting `^5`) and exited 0. Verifying pnpm alone would
 * have declared #450 fixed while it was not, which is the trap DoD §2e calls
 * "peer thoả tình cờ không tính là thoả".
 *
 * Usage:
 *   node scripts/smoke-scaffold.mjs                        # both templates × npm + pnpm
 *   node scripts/smoke-scaffold.mjs --template cloudflare   # one template
 *   node scripts/smoke-scaffold.mjs --pm npm                # one package manager
 *   node scripts/smoke-scaffold.mjs --keep                  # leave the temp dir for inspection
 *
 * Network is required. This is not part of `pnpm test` — it is a separate
 * command so the unit suite stays offline and fast.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEMPLATES = ['default', 'cloudflare'];
const PACKAGE_MANAGERS = ['npm', 'pnpm'];

function parseArgs(argv) {
  const options = { templates: TEMPLATES, pms: PACKAGE_MANAGERS, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--template') {
      const value = argv[i + 1];
      if (!TEMPLATES.includes(value)) throw new Error(`--template must be one of ${TEMPLATES.join('|')}`);
      options.templates = [value];
      i += 1;
    } else if (arg === '--pm') {
      const value = argv[i + 1];
      if (!PACKAGE_MANAGERS.includes(value)) {
        throw new Error(`--pm must be one of ${PACKAGE_MANAGERS.join('|')}`);
      }
      options.pms = [value];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * `install` for npm, `install` for pnpm — same word, but keep the mapping
 * explicit so adding yarn/bun later does not silently reuse the wrong verb.
 */
const INSTALL_ARGS = { npm: ['install'], pnpm: ['install'] };

function smoke({ template, pm, workdir }) {
  const label = `${template} × ${pm}`;
  const projectName = `smoke-${template}-${pm}`;
  const projectDir = join(workdir, projectName);

  // Scaffold from the working tree, not from the registry: the point is to test
  // the templates as they are now.
  const scaffold = run(
    'node',
    [
      join(pkgRoot, 'bin/create-lumibase.js'),
      projectName,
      '--template',
      template,
      '--pm',
      pm,
      '--no-install',
      '--no-git',
    ],
    workdir,
  );
  if (scaffold.status !== 0) {
    return { label, step: 'scaffold', status: scaffold.status, output: scaffold.output };
  }
  if (!existsSync(join(projectDir, 'package.json'))) {
    return { label, step: 'scaffold', status: 1, output: 'no package.json was emitted' };
  }

  const install = run(pm, INSTALL_ARGS[pm], projectDir);
  if (install.status !== 0) {
    return { label, step: `${pm} install`, status: install.status, output: install.output };
  }

  const typecheck = run(pm, ['run', 'typecheck'], projectDir);
  if (typecheck.status !== 0) {
    return { label, step: `${pm} run typecheck`, status: typecheck.status, output: typecheck.output };
  }

  return { label, step: 'ok', status: 0, output: '' };
}

function main(argv) {
  const options = parseArgs(argv);

  // The bin shim loads `dist/`, so the build has to exist. Fail with a usable
  // message instead of the shim's raw module-not-found stack.
  if (!existsSync(join(pkgRoot, 'dist/index.js'))) {
    console.error('dist/ is missing — run `pnpm -F create-lumibase build` first.');
    return 1;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'lumibase-scaffold-smoke-'));
  console.log(`workdir: ${workdir}`);

  const failures = [];
  try {
    for (const template of options.templates) {
      for (const pm of options.pms) {
        process.stdout.write(`• ${template} × ${pm} … `);
        const result = smoke({ template, pm, workdir });
        if (result.status === 0) {
          console.log('ok');
        } else {
          console.log(`FAILED at ${result.step} (exit ${result.status})`);
          failures.push(result);
        }
      }
    }
  } finally {
    if (options.keep) {
      console.log(`\nkeeping ${workdir}`);
    } else {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n──── ${failure.label} — ${failure.step} ────\n${failure.output.trim()}`);
    }
    console.error(`\n${failures.length} scaffold smoke case(s) failed.`);
    return 1;
  }

  console.log('\nAll scaffold smoke cases passed.');
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
