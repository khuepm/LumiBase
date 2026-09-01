import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { CliError } from '../errors.js';

/**
 * Locates the `create-lumibase` executable inside this package's dependency
 * tree. `lumibase init` deliberately delegates instead of re-implementing the
 * scaffold: `npm create lumibase` and `lumibase init` must never drift.
 */
export function resolveScaffoldBin(requireFrom: NodeRequire): string {
  let manifestPath: string;
  try {
    manifestPath = requireFrom.resolve('create-lumibase/package.json');
  } catch {
    throw new CliError(
      'Could not find the create-lumibase package.',
      'Reinstall the CLI, or run `npm create lumibase@latest` directly.',
    );
  }

  const manifest = requireFrom(manifestPath) as { bin?: Record<string, string> | string };
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['create-lumibase'];

  if (!bin) {
    throw new CliError('The installed create-lumibase package declares no executable.');
  }

  return join(dirname(manifestPath), bin);
}

export interface InitCommandOptions {
  /** Injected in tests; defaults to a require rooted at this module. */
  requireFrom?: NodeRequire;
  /** Injected in tests; defaults to spawning a real child process. */
  run?: (command: string, args: string[]) => number;
}

export function initCommand(argv: string[], options: InitCommandOptions = {}): number {
  const requireFrom = options.requireFrom ?? createRequire(import.meta.url);
  const binPath = resolveScaffoldBin(requireFrom);

  const run =
    options.run ??
    ((command: string, args: string[]): number => {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error) {
        throw new CliError(`Failed to run the scaffolder: ${result.error.message}`);
      }
      return result.status ?? 1;
    });

  return run(process.execPath, [binPath, ...argv]);
}
