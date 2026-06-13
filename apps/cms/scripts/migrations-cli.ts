#!/usr/bin/env -S npx tsx
/**
 * CMS-facing migration CLI shim.
 *
 * Usage:
 *   lumibase migrations version
 *   lumibase migrations preflight
 *   lumibase migrations dry-run
 */

export {};

process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'lumibase', ...process.argv.slice(2)];
await import('../../../packages/database/scripts/migrate.js');
