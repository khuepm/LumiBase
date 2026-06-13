import { execa } from 'execa';
import pc from 'picocolors';
import { createSpinner } from './utils/spinner.js';
import type { ProjectConfig } from './index.js';

const INSTALL_CMDS: Record<string, string[]> = {
  pnpm: ['pnpm', ['install']],
  npm: ['npm', ['install']],
  yarn: ['yarn', ['install']],
  bun: ['bun', ['install']],
} as unknown as Record<string, string[]>;

export async function installDependencies(config: ProjectConfig): Promise<void> {
  const { packageManager, targetDir } = config;
  const spinner = createSpinner(`Installing dependencies with ${pc.bold(packageManager)}`);

  const entry = INSTALL_CMDS[packageManager];
  if (!entry) {
    spinner.fail(`Unknown package manager: ${packageManager}`);
    return;
  }

  const [cmd, args] = entry as [string, string[]];

  try {
    await execa(cmd, args, {
      cwd: targetDir,
      stdio: process.env['DEBUG'] ? 'inherit' : 'pipe',
    });
    spinner.succeed(`Dependencies installed`);
  } catch (err) {
    spinner.fail('Dependency install failed');
    console.error(
      pc.dim(`  Run ${pc.cyan(`${packageManager} install`)} manually after fixing the error.`),
    );
    if (process.env['DEBUG']) throw err;
  }
}
