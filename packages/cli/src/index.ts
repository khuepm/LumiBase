import process from 'node:process';
import pc from 'picocolors';
import { run } from './cli.js';
import { CliError } from './errors.js';
import { log } from './utils/log.js';

async function main(): Promise<void> {
  const exitCode = await run(process.argv.slice(2));
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    log.plain();
    log.error(err.message);
    if (err.hint) log.dim(`  ${err.hint}`);
    log.plain();
    process.exitCode = err.exitCode;
    return;
  }

  if (process.env['DEBUG']) {
    console.error(err);
  } else {
    log.plain();
    log.error(err instanceof Error ? err.message : String(err));
    console.error(pc.dim('  Run with DEBUG=1 for the full stack trace.'));
    log.plain();
  }
  process.exitCode = 1;
});
