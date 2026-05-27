#!/usr/bin/env -S npx tsx
/**
 * `lumibase` CLI dispatcher. Routes subcommands to script files.
 *
 * Usage:
 *   lumibase typegen --site <siteId> --out ./types.ts
 */

export {};

const [, , subcommand, ...rest] = process.argv;

if (!subcommand) {
  console.error('Usage: lumibase <subcommand> [args]');
  console.error('Subcommands:');
  console.error('  typegen  Generate TypeScript types from a CMS site schema');
  console.error('  config   Import / export / diff site configuration');
  process.exit(1);
}

switch (subcommand) {
  case 'typegen': {
    process.argv = [process.argv[0], process.argv[1], ...rest];
    await import('./typegen.js');
    break;
  }
  case 'config': {
    process.argv = [process.argv[0], process.argv[1], ...rest];
    await import('./config-cli.js');
    break;
  }
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
}
