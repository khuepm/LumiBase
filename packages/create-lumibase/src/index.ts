import { resolve, basename } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import process from 'node:process';
import pc from 'picocolors';
import prompts from 'prompts';
import { parseArgs } from './utils/args.js';
import { validateProjectName } from './utils/validate.js';
import { scaffold } from './scaffold.js';
import { detectPackageManager } from './utils/detect-pm.js';
import { installDependencies } from './install.js';
import { initGit } from './git.js';
import { printNextSteps } from './utils/print.js';

export type Template = 'default' | 'cloudflare';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface ProjectConfig {
  projectName: string;
  targetDir: string;
  template: Template;
  packageManager: PackageManager;
  installDeps: boolean;
  initializeGit: boolean;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));

  console.log();
  console.log(
    pc.bold(pc.cyan(' LumiBase')) +
      pc.dim(' — Edge-native Headless CMS'),
  );
  console.log();

  // --- resolve project name / target dir ---
  let projectName = argv._[0] ?? '';
  let targetDir = '';

  if (!projectName) {
    const res = await prompts(
      {
        type: 'text',
        name: 'projectName',
        message: 'Project name:',
        initial: 'my-lumibase',
        validate: (v: string) => validateProjectName(v) ?? true,
      },
      { onCancel },
    );
    projectName = res.projectName as string;
  }

  const nameError = validateProjectName(projectName);
  if (nameError) {
    console.error(pc.red(`✖ ${nameError}`));
    process.exit(1);
  }

  targetDir = resolve(process.cwd(), projectName);

  // --- warn if target dir is not empty ---
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    const { overwrite } = await prompts(
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Directory ${pc.yellow(projectName)} is not empty. Continue and overwrite?`,
        initial: false,
      },
      { onCancel },
    );
    if (!overwrite) {
      console.log(pc.dim('Cancelled.'));
      process.exit(0);
    }
  }

  // --- template ---
  const template: Template =
    (argv.template as Template | undefined) ??
    ((
      await prompts(
        {
          type: 'select',
          name: 'template',
          message: 'Deployment target:',
          choices: [
            {
              title: `${pc.bold('Docker')}  ${pc.dim('Node.js + PostgreSQL (recommended)')}`,
              value: 'default',
            },
            {
              title: `${pc.bold('Cloudflare Workers')}  ${pc.dim('Edge + D1')}`,
              value: 'cloudflare',
            },
          ],
          initial: 0,
        },
        { onCancel },
      )
    ).template as Template);

  // --- package manager ---
  const detectedPm = detectPackageManager();
  const packageManager: PackageManager =
    (argv.pm as PackageManager | undefined) ??
    ((
      await prompts(
        {
          type: 'select',
          name: 'packageManager',
          message: 'Package manager:',
          choices: (
            [
              ['pnpm', 'Recommended'],
              ['npm', ''],
              ['yarn', ''],
              ['bun', 'Fast'],
            ] as [PackageManager, string][]
          ).map(([value, hint]) => ({
            title:
              value === detectedPm
                ? `${value} ${pc.dim(`(detected${hint ? ', ' + hint : ''})`)}`
                : hint
                  ? `${value} ${pc.dim(`(${hint})`)}`
                  : value,
            value,
          })),
          initial: (['pnpm', 'npm', 'yarn', 'bun'] as PackageManager[]).indexOf(
            detectedPm,
          ),
        },
        { onCancel },
      )
    ).packageManager as PackageManager);

  // --- install ---
  const installDeps: boolean =
    argv['no-install'] === true
      ? false
      : argv.install === true
        ? true
        : ((
            await prompts(
              {
                type: 'confirm',
                name: 'installDeps',
                message: 'Install dependencies?',
                initial: true,
              },
              { onCancel },
            )
          ).installDeps as boolean);

  // --- git ---
  const initializeGit: boolean =
    argv['no-git'] === true
      ? false
      : argv.git === true
        ? true
        : ((
            await prompts(
              {
                type: 'confirm',
                name: 'initializeGit',
                message: 'Initialize a git repository?',
                initial: true,
              },
              { onCancel },
            )
          ).initializeGit as boolean);

  const config: ProjectConfig = {
    projectName: basename(targetDir),
    targetDir,
    template,
    packageManager,
    installDeps,
    initializeGit,
  };

  console.log();

  // --- scaffold ---
  await scaffold(config);

  // --- git ---
  if (initializeGit) {
    await initGit(targetDir);
  }

  // --- install ---
  if (installDeps) {
    await installDependencies(config);
  }

  // --- done ---
  printNextSteps(config);
}

function onCancel() {
  console.log(pc.dim('\nCancelled.'));
  process.exit(0);
}

main().catch((err: unknown) => {
  if (process.env['DEBUG']) {
    console.error(err);
  } else {
    console.error(
      pc.red('\n✖ Something went wrong:'),
      err instanceof Error ? err.message : String(err),
    );
    console.error(pc.dim('  Run with DEBUG=1 for full stack trace.'));
  }
  process.exit(1);
});
