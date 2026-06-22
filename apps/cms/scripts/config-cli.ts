#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * config-cli.ts — LumiBase Code-First Configuration CLI.
 *
 * Talks to a running CMS instance's unified Config Manifest endpoints
 * (`/api/v1/config/export`, `/api/v1/config/import`). The manifest is a single
 * versioned JSON file (`lumibase.config@v1`) covering collections, fields,
 * relations, settings and webhooks — commit it to git and gate PRs on `diff`.
 *
 * Sub-commands:
 *   export   Pull the config manifest to a file (or stdout).
 *   diff     Compare a manifest file against the live instance.
 *            Exit 0 = no changes, 1 = changes (use as a CI gate).
 *   apply    Apply a manifest file to the live instance.
 *
 * Usage:
 *   pnpm --filter @lumibase/cms config export --site <id> [--scope all|schema|settings|webhooks] [--out config.json]
 *   pnpm --filter @lumibase/cms config diff   --site <id> config.json
 *   pnpm --filter @lumibase/cms config apply  --site <id> config.json [--mode merge|replace-managed|replace-all] [--allow-destructive] [--dry-run]
 *
 * Environment:
 *   LUMIBASE_API_URL   CMS base URL      (default: http://localhost:1989)
 *   LUMIBASE_TOKEN     Bearer auth token (admin)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const command = args[0]; // 'export' | 'diff' | 'apply'

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return args.includes(flag);
}
/** Flags that consume the following arg as their value. */
const VALUE_FLAGS = new Set(['--site', '-s', '--scope', '--out', '-o', '--mode']);
/** First non-flag positional after the command (e.g. the manifest file path). */
function positional(): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) continue; // a flag
    if (VALUE_FLAGS.has(args[i - 1] ?? '')) continue; // a flag's value
    return a;
  }
  return undefined;
}

const API_URL = process.env['LUMIBASE_API_URL'] ?? 'http://localhost:1989';
const TOKEN = process.env['LUMIBASE_TOKEN'] ?? '';
const SITE_ID = getArg('--site') ?? getArg('-s') ?? '';

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Lumi-Site': SITE_ID };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

/** Resolve a user path and reject traversal outside the working directory. */
function safeResolve(p: string): string {
  const resolved = resolve(process.cwd(), p);
  if (!resolved.startsWith(process.cwd())) {
    console.error('Error: Access Denied: Path Traversal detected');
    process.exit(1);
  }
  return resolved;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, { headers: buildHeaders() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function apiPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ── export ───────────────────────────────────────────────────────────────────

async function runExport(): Promise<void> {
  if (!SITE_ID) { console.error('--site <siteId> is required'); process.exit(1); }
  const scope = getArg('--scope') ?? 'all';
  const out = getArg('--out') ?? getArg('-o');

  const body = (await apiGet(`/api/v1/config/export?scope=${encodeURIComponent(scope)}`)) as { data: unknown };
  const json = JSON.stringify(body.data, null, 2);

  if (out) {
    writeFileSync(safeResolve(out), json + '\n', 'utf-8');
    console.log(`✅ Exported config manifest → ${out}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

// ── diff ───────────────────────────────────────────────────────────────────

interface ResourceDiff { create: number; update: number; unchanged: number; delete: number }
interface ConfigDiff {
  collections: ResourceDiff; fields: ResourceDiff; relations: ResourceDiff;
  webhooks: ResourceDiff; settings: ResourceDiff; risk: string; clean: boolean;
}

function printDiff(diff: ConfigDiff): void {
  const rows: Array<[string, ResourceDiff]> = [
    ['collections', diff.collections], ['fields', diff.fields], ['relations', diff.relations],
    ['webhooks', diff.webhooks], ['settings', diff.settings],
  ];
  console.log('  resource     + create  ~ update   = same   - delete');
  for (const [name, r] of rows) {
    console.log(`  ${name.padEnd(12)} ${String(r.create).padStart(6)}   ${String(r.update).padStart(6)}  ${String(r.unchanged).padStart(6)}   ${String(r.delete).padStart(6)}`);
  }
  console.log(`  risk: ${diff.risk}`);
}

function loadManifest(file: string): unknown {
  return JSON.parse(readFileSync(safeResolve(file), 'utf-8'));
}

async function runDiff(): Promise<void> {
  if (!SITE_ID) { console.error('--site <siteId> is required'); process.exit(1); }
  const file = positional();
  if (!file) { console.error('Usage: config diff --site <id> <manifest.json>'); process.exit(1); }
  const mode = getArg('--mode') ?? 'replace-all';

  const manifest = loadManifest(file);
  const { status, json } = await apiPost(`/api/v1/config/import?dryRun=true&mode=${mode}`, manifest);
  const data = (json as { data?: { valid: boolean; errors?: Array<{ code: string; message: string }>; diff: ConfigDiff | null } }).data;

  if (!data || status >= 400 || !data.valid) {
    console.error('❌ Manifest invalid:');
    for (const e of data?.errors ?? []) console.error(`  - ${e.code}: ${e.message}`);
    process.exit(2);
  }

  printDiff(data.diff!);
  if (data.diff!.clean) {
    console.log('✅ No changes.');
    process.exit(0);
  }
  console.log('⚠ Changes pending (exit 1).');
  process.exit(1);
}

// ── apply ───────────────────────────────────────────────────────────────────

async function runApply(): Promise<void> {
  if (!SITE_ID) { console.error('--site <siteId> is required'); process.exit(1); }
  const file = positional();
  if (!file) { console.error('Usage: config apply --site <id> <manifest.json>'); process.exit(1); }
  const mode = getArg('--mode') ?? 'merge';
  const allowDestructive = hasFlag('--allow-destructive');
  const dryRun = hasFlag('--dry-run');

  const manifest = loadManifest(file);
  const qs = new URLSearchParams({ mode });
  if (dryRun) qs.set('dryRun', 'true');
  if (allowDestructive) qs.set('allowDestructive', 'true');

  const { status, json } = await apiPost(`/api/v1/config/import?${qs.toString()}`, manifest);
  const data = (json as { data?: { valid: boolean; errors?: Array<{ code: string; message: string }>; diff: ConfigDiff | null; applied?: { created: number; updated: number; deleted: number } } }).data;

  if (dryRun) {
    if (data?.diff) printDiff(data.diff);
    console.log('ℹ Dry-run only; nothing written.');
    process.exit(0);
  }

  if (!data || status >= 400 || !data.valid) {
    console.error(`❌ Apply failed (${status}):`);
    for (const e of data?.errors ?? []) console.error(`  - ${e.code}: ${e.message}`);
    if ((data?.errors ?? []).some((e) => e.code === 'DESTRUCTIVE_BLOCKED')) {
      console.error('  Re-run with --allow-destructive if these deletions are intended.');
    }
    process.exit(2);
  }

  const a = data.applied ?? { created: 0, updated: 0, deleted: 0 };
  console.log(`✅ Applied: ${a.created} created, ${a.updated} updated, ${a.deleted} deleted.`);
}

// ── main ───────────────────────────────────────────────────────────────────

const HELP = `
LumiBase Config CLI — Code-First Configuration (lumibase.config@v1)

Sub-commands:
  export  --site <id> [--scope all|schema|settings|webhooks] [--out file]
  diff    --site <id> <manifest.json>            # exit 1 if changes (CI gate)
  apply   --site <id> <manifest.json> [--mode merge|replace-managed|replace-all]
                                       [--allow-destructive] [--dry-run]

Env vars:
  LUMIBASE_API_URL   CMS base URL (default: http://localhost:1989)
  LUMIBASE_TOKEN     Bearer auth token (admin)
`;

switch (command) {
  case 'export': await runExport(); break;
  case 'diff':   await runDiff();   break;
  case 'apply':  await runApply();  break;
  default:
    console.log(HELP);
    process.exit(0);
}
