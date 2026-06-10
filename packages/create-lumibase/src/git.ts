import { execa } from 'execa';
import pc from 'picocolors';
import { createSpinner } from './utils/spinner.js';

export async function initGit(targetDir: string): Promise<void> {
  const spinner = createSpinner('Initialising git repository');

  try {
    await execa('git', ['init'], { cwd: targetDir, stdio: 'pipe' });
    await execa('git', ['add', '-A'], { cwd: targetDir, stdio: 'pipe' });
    await execa(
      'git',
      ['commit', '--allow-empty', '-m', 'chore: initialise LumiBase project'],
      { cwd: targetDir, stdio: 'pipe' },
    );
    spinner.succeed('Git repository initialised');
  } catch {
    spinner.fail('Git init skipped (git may not be installed)');
    console.error(pc.dim('  Run `git init` manually when ready.'));
  }
}
