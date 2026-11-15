#!/usr/bin/env node
import { dev } from './commands/dev';
import { keygen } from './commands/keygen';
import { sign } from './commands/sign';
import { verify } from './commands/verify';

/**
 * `lumibase-ext` — extension signing + local development toolchain.
 *
 *   lumibase-ext keygen --key-id <id> [--out ./keys] [--official]
 *   lumibase-ext sign   --bundle <path> --key <path> --key-id <id>
 *   lumibase-ext verify --bundle <path> --pub <path>
 *   lumibase-ext dev    [--dir .] [--port 4790] [--site <id>]   (hot reload; local dev only)
 */

/** Parse `--flag value` / `--bool` argv into a map. */
function parseArgs(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.set(name, next);
      i += 1;
    } else {
      out.set(name, true);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'keygen':
      keygen(args);
      break;
    case 'sign':
      await sign(args);
      break;
    case 'verify':
      await verify(args);
      break;
    case 'dev':
      await dev(args);
      break;
    default:
      process.stderr.write(
        'Usage: lumibase-ext <keygen|sign|verify|dev> [--flags]\n',
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
