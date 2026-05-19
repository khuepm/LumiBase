#!/usr/bin/env tsx
/**
 * config-cli.ts — LumiBase config export / import / diff CLI.
 *
 * Sub-commands:
 *   export  Pull settings + schema + access config as JSON files.
 *   import  Push JSON config back to a running CMS instance.
 *   diff    Compare two exported config directories or JSON files.
 *
 * Usage:
 *   pnpm --filter @lumibase/cms config export --site <siteId> --out ./config-export/
 *   pnpm --filter @lumibase/cms config import --site <siteId> --dir ./config-export/
 *   pnpm --filter @lumibase/cms config diff   --a ./config-a/ --b ./config-b/
 *
 * Environment:
 *   LUMIBASE_API_URL   CMS base URL      (default: http://localhost:8787)
 *   LUMIBASE_TOKEN     Bearer auth token
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── CLI helpers ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0]; // 'export' | 'import' | 'diff'

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const API_URL = process.env['LUMIBASE_API_URL'] ?? 'http://localhost:8787';
const TOKEN   = process.env['LUMIBASE_TOKEN'] ?? '';
const SITE_ID = getArg('--site') ?? getArg('-s') ?? '';

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Lumi-Site': SITE_ID,
  };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, { headers: buildHeaders() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPut(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Resources to export / import ──────────────────────────────────────────

const RESOURCES = [
  { key: 'settings',    path: '/api/v1/settings',    file: 'settings.json' },
  { key: 'collections', path: '/api/v1/collections',  file: 'collections.json' },
  { key: 'fields',      path: '/api/v1/fields',       file: 'fields.json' },
  { key: 'relations',   path: '/api/v1/relations',    file: 'relations.json' },
  { key: 'roles',       path: '/api/v1/roles',        file: 'roles.json' },
  { key: 'policies',    path: '/api/v1/policies',     file: 'policies.json' },
  { key: 'webhooks',    path: '/api/v1/webhooks',     file: 'webhooks.json' },
] as const;

// ── export command ─────────────────────────────────────────────────────────

async function runExport(): Promise<void> {
  if (!SITE_ID) { console.error('--site <siteId> is required'); process.exit(1); }

  const outDir = getArg('--out') ?? getArg('-o') ?? `./lumibase-config-${SITE_ID}`;
  mkdirSync(outDir, { recursive: true });

  console.log(`⏳ Exporting config for site "${SITE_ID}" → ${outDir}/`);

  for (const { path, file, key } of RESOURCES) {
    try {
      const data = await apiGet(path);
      writeFileSync(join(outDir, file), JSON.stringify(data, null, 2), 'utf-8');
      console.log(`  ✓ ${key}`);
    } catch (err) {
      console.warn(`  ⚠ ${key}: ${(err as Error).message}`);
    }
  }

  // Write meta file.
  writeFileSync(
    join(outDir, '_meta.json'),
    JSON.stringify({ siteId: SITE_ID, exportedAt: new Date().toISOString(), version: '1' }, null, 2),
  );

  console.log(`✅ Export complete: ${outDir}/`);
}

// ── import command ─────────────────────────────────────────────────────────

async function runImport(): Promise<void> {
  if (!SITE_ID) { console.error('--site <siteId> is required'); process.exit(1); }

  const inDir = getArg('--dir') ?? getArg('-d');
  if (!inDir) { console.error('--dir <path> is required for import'); process.exit(1); }

  console.log(`⏳ Importing config for site "${SITE_ID}" from ${inDir}/`);

  const files = readdirSync(inDir).filter((f) => f.endsWith('.json') && f !== '_meta.json');

  for (const file of files) {
    const resource = RESOURCES.find((r) => r.file === file);
    if (!resource) { console.log(`  - Skipping unknown file: ${file}`); continue; }

    try {
      const raw = JSON.parse(readFileSync(join(inDir, file), 'utf-8')) as { data?: unknown[] };
      const rows: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : [];

      let ok = 0;
      for (const row of rows) {
        try {
          await apiPost(resource.path, row);
          ok++;
        } catch {
          // Conflict / already exists — skip silently.
        }
      }
      console.log(`  ✓ ${resource.key}: ${ok}/${rows.length} records`);
    } catch (err) {
      console.warn(`  ⚠ ${resource.key}: ${(err as Error).message}`);
    }
  }

  console.log('✅ Import complete.');
}

// ── diff command ───────────────────────────────────────────────────────────

function diffObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path = '',
): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!(key in a)) {
      diffs.push(`+ ${fullPath}: ${JSON.stringify(b[key])}`);
    } else if (!(key in b)) {
      diffs.push(`- ${fullPath}: ${JSON.stringify(a[key])}`);
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      if (typeof a[key] === 'object' && typeof b[key] === 'object' && a[key] !== null && b[key] !== null) {
        diffs.push(...diffObjects(
          a[key] as Record<string, unknown>,
          b[key] as Record<string, unknown>,
          fullPath,
        ));
      } else {
        diffs.push(`~ ${fullPath}:\n  < ${JSON.stringify(a[key])}\n  > ${JSON.stringify(b[key])}`);
      }
    }
  }

  return diffs;
}

async function runDiff(): Promise<void> {
  const dirA = getArg('--a') ?? getArg('-a');
  const dirB = getArg('--b') ?? getArg('-b');

  if (!dirA || !dirB) {
    console.error('Usage: config diff --a <dir-or-file> --b <dir-or-file>');
    process.exit(1);
  }

  console.log(`⏳ Diffing ${dirA} ↔ ${dirB}\n`);

  let hasDiff = false;

  for (const { file, key } of RESOURCES) {
    let rawA: unknown, rawB: unknown;
    try { rawA = JSON.parse(readFileSync(join(dirA, file), 'utf-8')); } catch { continue; }
    try { rawB = JSON.parse(readFileSync(join(dirB, file), 'utf-8')); } catch { continue; }

    const strA = JSON.stringify(rawA, null, 2);
    const strB = JSON.stringify(rawB, null, 2);

    if (strA !== strB) {
      hasDiff = true;
      console.log(`--- ${key} ---`);
      const diffs = diffObjects(
        rawA as Record<string, unknown>,
        rawB as Record<string, unknown>,
      );
      diffs.slice(0, 50).forEach((d) => console.log(d));
      if (diffs.length > 50) console.log(`  ... and ${diffs.length - 50} more differences`);
      console.log('');
    }
  }

  if (!hasDiff) console.log('✅ No differences found.');
  else console.log('⚠ Differences exist between configs.');
}

// ── Main ───────────────────────────────────────────────────────────────────

const HELP = `
LumiBase Config CLI

Sub-commands:
  export  --site <id> [--out <dir>]
  import  --site <id> --dir <dir>
  diff    --a <dir>   --b <dir>

Env vars:
  LUMIBASE_API_URL   CMS base URL (default: http://localhost:8787)
  LUMIBASE_TOKEN     Bearer auth token
`;

switch (command) {
  case 'export': await runExport(); break;
  case 'import': await runImport(); break;
  case 'diff':   await runDiff();   break;
  default:
    console.log(HELP);
    process.exit(0);
}
