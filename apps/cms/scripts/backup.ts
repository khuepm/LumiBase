#!/usr/bin/env tsx
/**
 * backup.ts — CLI wrapper for LumiBase site backup & restore.
 *
 * Usage:
 *   pnpm --filter @lumibase/cms backup export --site <siteId> --out backup.ndjson
 *   pnpm --filter @lumibase/cms backup import --site <siteId> --file backup.ndjson
 *
 * Environment:
 *   LUMIBASE_API_URL   Base URL of the CMS API  (default: http://localhost:1989)
 *   LUMIBASE_TOKEN     Bearer token for authentication
 *
 * The script calls the /api/v1/admin/backup and /api/v1/admin/restore endpoints
 * directly, so the CMS must be running (or use a preview URL).
 */

import { createWriteStream, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ── CLI argument parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0]; // 'export' | 'import'

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const API_URL = process.env['LUMIBASE_API_URL'] ?? 'http://localhost:1989';
const TOKEN = process.env['LUMIBASE_TOKEN'] ?? '';
const SITE_ID = getArg('--site') ?? getArg('-s') ?? '';

if (!SITE_ID) {
  console.error('Error: --site <siteId> is required.');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Lumi-Site': SITE_ID,
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  return headers;
}

// ── Commands ───────────────────────────────────────────────────────────────

async function runExport(): Promise<void> {
  const outFile = getArg('--out') ?? getArg('-o') ?? `lumibase-backup-${SITE_ID}-${new Date().toISOString().slice(0, 10)}.ndjson`;

  console.log(`⏳ Exporting site ${SITE_ID} → ${outFile} …`);

  const res = await fetch(`${API_URL}/api/v1/admin/backup`, {
    headers: buildHeaders(),
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    console.error(`Error: ${res.status} — ${text}`);
    process.exit(1);
  }

  const dest = createWriteStream(outFile);
  await pipeline(Readable.fromWeb(res.body as never), dest);

  console.log(`✅ Export complete: ${outFile}`);
}

async function runImport(): Promise<void> {
  const inFile = getArg('--file') ?? getArg('-f');
  if (!inFile) {
    console.error('Error: --file <path> is required for import.');
    process.exit(1);
  }

  console.log(`⏳ Restoring site ${SITE_ID} from ${inFile} …`);

  const body = readFileSync(inFile, 'utf-8');

  const res = await fetch(`${API_URL}/api/v1/admin/restore`, {
    method: 'POST',
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/x-ndjson',
    },
    body,
  });

  const json = await res.json() as { data?: { restored: number }; errors?: unknown[] };

  if (!res.ok) {
    console.error(`Error: ${res.status}`, json.errors);
    process.exit(1);
  }

  console.log(`✅ Restore complete: ${json.data?.restored ?? 0} records imported.`);
}

// ── Main ───────────────────────────────────────────────────────────────────

switch (command) {
  case 'export':
    await runExport();
    break;
  case 'import':
    await runImport();
    break;
  default:
    console.log(`
LumiBase Backup CLI

Usage:
  backup export --site <siteId> [--out <file>]
  backup import --site <siteId> --file <path>

Options:
  --site, -s   Site ID (required)
  --out,  -o   Output file for export (default: lumibase-backup-<site>-<date>.ndjson)
  --file, -f   Input NDJSON file for import

Environment:
  LUMIBASE_API_URL   CMS base URL (default: http://localhost:1989)
  LUMIBASE_TOKEN     Bearer token
`);
    process.exit(0);
}
