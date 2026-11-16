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
 *   node scripts/smoke-scaffold.mjs                        # every template × npm + pnpm
 *   node scripts/smoke-scaffold.mjs --template cloudflare   # one template
 *   node scripts/smoke-scaffold.mjs --pm npm                # one package manager
 *   node scripts/smoke-scaffold.mjs --keep                  # leave the temp dir for inspection
 *   node scripts/smoke-scaffold.mjs --workdir ./out         # scaffold into ./out and keep it
 *                                                           # (CI deploys the built Astro site from there)
 *
 * The site templates (`astro`, `sveltekit`) are also BUILT, not only
 * typechecked: a static export that typechecks but cannot `astro build` is not
 * deployable, and #744's acceptance is "the starter builds and deploys to
 * Pages". The build runs with no CMS configured, which is the first-deploy
 * path both starters support (a "connect your CMS" page).
 *
 * Framework matrix (#760, `.github/workflows/runtime-matrix.yml`):
 *   node scripts/smoke-scaffold.mjs --template nextjs --pm npm --next 15 --build --skip-audit
 *     --next <major>   install `next@^<major>` instead of the template's pin, so
 *                      CI proves the template on Next.js current and current−1
 *     --build          also run `next build` after the typecheck (nextjs only)
 *     --skip-audit     skip the production audit — the matrix answers "does it
 *                      work on this framework line?", the default smoke keeps
 *                      answering "is the shipped graph clean?"
 *
 * Network is required. This is not part of `pnpm test` — it is a separate
 * command so the unit suite stays offline and fast.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEMPLATES = ['default', 'cloudflare', 'nextjs', 'astro', 'sveltekit'];

/** Templates whose generated manifest depends on the `lumibase` client. */
const CLIENT_TEMPLATES = new Set(['nextjs', 'astro', 'sveltekit']);

/**
 * Templates that are built as well as typechecked, and the file a successful
 * build must leave behind — the thing `wrangler pages deploy` uploads.
 */
const BUILD_OUTPUT = {
  astro: 'dist/index.html',
  sveltekit: '.svelte-kit/cloudflare/_worker.js',
};
const PACKAGE_MANAGERS = ['npm', 'pnpm'];

function parseArgs(argv) {
  const options = {
    templates: TEMPLATES,
    pms: PACKAGE_MANAGERS,
    keep: false,
    workdir: null,
    next: null,
    build: false,
    audit: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      // `pnpm smoke -- --workdir x` forwards the separator; it is not an option.
      continue;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--build') {
      options.build = true;
    } else if (arg === '--skip-audit') {
      options.audit = false;
    } else if (arg === '--next') {
      const value = argv[i + 1];
      if (!/^\d+$/.test(value ?? '')) throw new Error('--next must be a Next.js major, e.g. 16');
      options.next = value;
      i += 1;
    } else if (arg === '--workdir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--workdir needs a directory');
      options.workdir = resolve(value);
      options.keep = true;
      i += 1;
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

function packReleaseClients(workdir) {
  const repoRoot = resolve(pkgRoot, '../..');
  const build = run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=lumibase...'], repoRoot);
  if (build.status !== 0) throw new Error(build.output);

  const tarballs = {};
  for (const directory of ['sdk', 'cli']) {
    const packageDir = join(repoRoot, 'packages', directory);
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const packed = run('pnpm', ['pack', '--pack-destination', workdir], packageDir);
    if (packed.status !== 0) throw new Error(packed.output);
    const filename = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz';
    tarballs[manifest.name] = 'file:' + join(workdir, filename);
  }
  return tarballs;
}

function smoke({ template, pm, workdir, tarballs, next, build, audit: runAudit }) {
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

  // Exercise the release clients before their version exists on npm.
  // Pack real publish artifacts so exports and declaration files are checked too.
  if (CLIENT_TEMPLATES.has(template)) {
    const manifestPath = join(projectDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies.lumibase = tarballs.lumibase;
    if (next && template === 'nextjs') manifest.dependencies.next = `^${next}`;
    manifest.overrides = { ...manifest.overrides, '@lumibase/sdk': tarballs['@lumibase/sdk'] };
    manifest.pnpm = {
      ...manifest.pnpm,
      overrides: { ...manifest.pnpm?.overrides, '@lumibase/sdk': tarballs['@lumibase/sdk'] },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  const install = run(pm, INSTALL_ARGS[pm], projectDir);
  if (install.status !== 0) {
    return { label, step: `${pm} install`, status: install.status, output: install.output };
  }

  // Standalone starters do not inherit the monorepo's dependency overrides.
  // Audit the installed production graph: a manifest-only test missed the
  // vulnerable PostCSS pinned by Next.js in a fresh Next.js starter. The
  // Astro and SvelteKit starters get the same check (#744).
  if (CLIENT_TEMPLATES.has(template) && runAudit) {
    const audit = run(pm, ['audit', pm === 'npm' ? '--omit=dev' : '--prod', '--audit-level=moderate'], projectDir);
    if (audit.status !== 0) {
      return { label, step: `${pm} audit`, status: audit.status, output: audit.output };
    }
  }

  const typecheck = run(pm, ['run', 'typecheck'], projectDir);
  if (typecheck.status !== 0) {
    return { label, step: `${pm} run typecheck`, status: typecheck.status, output: typecheck.output };
  }

  if (template === 'nextjs' && build) {
    const built = run(pm, ['run', 'build'], projectDir);
    if (built.status !== 0) {
      return { label, step: `${pm} run build`, status: built.status, output: built.output };
    }
  }

  const expectedOutput = BUILD_OUTPUT[template];
  if (expectedOutput) {
    const built = run(pm, ['run', 'build'], projectDir);
    if (built.status !== 0) {
      return { label, step: `${pm} run build`, status: built.status, output: built.output };
    }
    if (!existsSync(join(projectDir, expectedOutput))) {
      return {
        label,
        step: `${pm} run build`,
        status: 1,
        output: `build exited 0 but left no ${expectedOutput}\n${built.output}`,
      };
    }
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

  let workdir;
  if (options.workdir) {
    mkdirSync(options.workdir, { recursive: true });
    workdir = options.workdir;
  } else {
    workdir = mkdtempSync(join(tmpdir(), 'lumibase-scaffold-smoke-'));
  }
  console.log(`workdir: ${workdir}`);

  const failures = [];
  try {
    const tarballs = options.templates.some((t) => CLIENT_TEMPLATES.has(t))
      ? packReleaseClients(workdir)
      : {};
    for (const template of options.templates) {
      for (const pm of options.pms) {
        process.stdout.write(`• ${template} × ${pm} … `);
        const result = smoke({ ...options, template, pm, workdir, tarballs });
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
