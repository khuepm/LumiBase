#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * access-cli.ts — LumiBase access manifest export/import CLI.
 *
 * Usage:
 *   lumibase access export --site <siteId> --out access.json
 *   lumibase access import access.json --site <siteId> --dry-run
 *   lumibase access import access.json --site <siteId> --mode replace-managed
 *
 * Environment:
 *   LUMIBASE_API_URL / LUMI_URL      CMS base URL (default: http://localhost:1989)
 *   LUMIBASE_TOKEN   / LUMI_TOKEN    Bearer auth token
 *   LUMIBASE_SITE    / LUMI_SITE     Active site id
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AccessConflict,
  AccessExportManifest,
  AccessImportApplyResult,
  AccessImportDiff,
  AccessImportDiffSection,
  AccessImportDryRunResult,
  AccessImportMode,
} from '@lumibase/sdk';

export interface AccessCliEnv {
  readonly LUMIBASE_API_URL?: string;
  readonly LUMI_URL?: string;
  readonly LUMIBASE_TOKEN?: string;
  readonly LUMI_TOKEN?: string;
  readonly LUMIBASE_SITE?: string;
  readonly LUMI_SITE?: string;
}

export interface AccessCliOptions {
  command: 'export' | 'import' | 'help';
  url: string;
  site: string;
  token?: string;
  out?: string;
  file?: string;
  dryRun: boolean;
  mode: AccessImportMode;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

const HELP = `
LumiBase Access CLI

Sub-commands:
  export  --site <id> [--out <file|->]
  import  <file> --site <id> [--dry-run] [--mode merge|replace-managed|replace-all]

Env vars:
  LUMIBASE_API_URL / LUMI_URL     CMS base URL (default: http://localhost:1989)
  LUMIBASE_TOKEN   / LUMI_TOKEN   Bearer auth token
  LUMIBASE_SITE    / LUMI_SITE    Active site id
`;

export function parseAccessArgs(argv: string[], env: AccessCliEnv = process.env): AccessCliOptions {
  const [command = 'help', ...rest] = argv;
  const args = parseFlags(rest);
  const url = flagValue(args.url) ?? env.LUMIBASE_API_URL ?? env.LUMI_URL ?? 'http://localhost:1989';
  const site = flagValue(args.site) ?? flagValue(args.s) ?? env.LUMIBASE_SITE ?? env.LUMI_SITE ?? '';
  const token = flagValue(args.auth) ?? flagValue(args.token) ?? env.LUMIBASE_TOKEN ?? env.LUMI_TOKEN;
  const mode = parseMode(args.mode);

  if (command !== 'export' && command !== 'import') {
    return { command: 'help', url, site, token, dryRun: false, mode: 'merge' };
  }

  return {
    command,
    url,
    site,
    token,
    out: flagValue(args.out) ?? flagValue(args.o),
    file: command === 'import' ? firstPositional(rest) : undefined,
    dryRun: Boolean(args['dry-run'] ?? args.dryRun),
    mode,
  };
}

export async function runAccessCli(
  options: AccessCliOptions,
  deps: {
    fetcher?: FetchLike;
    stdout?: Pick<typeof process.stdout, 'write'>;
    stderr?: Pick<typeof process.stderr, 'write'>;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetcher = deps.fetcher ?? fetch;

  if (options.command === 'help') {
    stdout.write(HELP);
    return 0;
  }
  if (!options.site) {
    stderr.write('Error: --site <siteId> is required (or set LUMIBASE_SITE / LUMI_SITE).\n');
    return 1;
  }

  try {
    if (options.command === 'export') {
      const manifest = await exportAccessManifest(options, fetcher);
      const json = `${JSON.stringify(manifest, null, 2)}\n`;
      if (!options.out || options.out === '-') {
        stdout.write(json);
      } else {
        const outPath = resolve(process.cwd(), options.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, json, 'utf8');
        stdout.write(`[access] Exported ${outPath}\n`);
      }
      return 0;
    }

    const result = await importAccessManifest(options, fetcher);
    stdout.write(formatImportResult(result));
    if (!result.valid || (result.conflicts?.conflicts.length ?? 0) > 0) return 1;
    return 0;
  } catch (error) {
    stderr.write(`[access] FAILED: ${(error as Error).message}\n`);
    return 1;
  }
}

export async function exportAccessManifest(
  options: Pick<AccessCliOptions, 'url' | 'site' | 'token'>,
  fetcher: FetchLike = fetch,
): Promise<AccessExportManifest> {
  const response = await requestJson<{ data: AccessExportManifest }>(
    fetcher,
    options,
    '/api/v1/access/export',
    { method: 'GET' },
  );
  if (!response.ok) throw new Error(response.error);
  return response.body.data;
}

export async function importAccessManifest(
  options: Pick<AccessCliOptions, 'url' | 'site' | 'token' | 'file' | 'dryRun' | 'mode'>,
  fetcher: FetchLike = fetch,
): Promise<AccessImportDryRunResult | AccessImportApplyResult> {
  if (!options.file) throw new Error('import requires a manifest file path.');
  const manifest = JSON.parse(await readFile(resolve(process.cwd(), options.file), 'utf8')) as AccessExportManifest;
  const params = new URLSearchParams();
  if (options.dryRun) params.set('dryRun', 'true');
  else if (options.mode !== 'merge') params.set('mode', options.mode);
  const path = `/api/v1/access/import${params.toString() ? `?${params.toString()}` : ''}`;

  const response = await requestJson<{ data: AccessImportDryRunResult | AccessImportApplyResult }>(
    fetcher,
    options,
    path,
    {
      method: 'POST',
      body: JSON.stringify(manifest),
    },
  );
  if (!response.ok && !response.body?.data) throw new Error(response.error);
  return response.body.data;
}

export function formatImportResult(result: AccessImportDryRunResult | AccessImportApplyResult): string {
  const lines: string[] = [];
  lines.push(`[access] ${result.dryRun ? 'Dry-run' : 'Import'} ${result.valid ? 'valid' : 'blocked'}`);
  if (!result.dryRun) {
    lines.push(`[access] mode=${result.mode} applied=${String(result.applied)}`);
  }
  lines.push(formatDiffSummary(result.diff));

  if (result.errors.length > 0) {
    lines.push('[access] Errors:');
    for (const error of result.errors) {
      lines.push(`  - ${error.path ? `${error.path}: ` : ''}${error.message}`);
    }
  }

  lines.push(...formatConflicts('Blocking conflicts', result.conflicts.conflicts));
  lines.push(...formatConflicts('Warnings', result.conflicts.warnings));
  return `${lines.join('\n')}\n`;
}

export function summarizeDiff(diff: AccessImportDiff): Omit<AccessImportDiffSection, 'entries'> {
  const sections = [
    diff.roles,
    diff.policies,
    diff.apiKeys,
    ...Object.values(diff.bindings),
  ];
  return sections.reduce(
    (acc, section) => ({
      create: acc.create + section.create,
      update: acc.update + section.update,
      unchanged: acc.unchanged + section.unchanged,
      delete: acc.delete + section.delete,
    }),
    { create: 0, update: 0, unchanged: 0, delete: 0 },
  );
}

function formatDiffSummary(diff: AccessImportDiff): string {
  const total = summarizeDiff(diff);
  return `[access] diff create=${total.create} update=${total.update} unchanged=${total.unchanged} delete=${total.delete}`;
}

function formatConflicts(title: string, conflicts: AccessConflict[]): string[] {
  if (conflicts.length === 0) return [];
  return [
    `[access] ${title}: ${conflicts.length}`,
    ...conflicts.map(
      (conflict) =>
        `  - ${conflict.collection}:${conflict.action} ${conflict.reason} (${conflict.existingPolicy} / ${conflict.incomingPolicy})`,
    ),
  ];
}

async function requestJson<T>(
  fetcher: FetchLike,
  options: Pick<AccessCliOptions, 'url' | 'site' | 'token'>,
  path: string,
  init: RequestInit,
): Promise<{ ok: true; body: T } | { ok: false; body: T; error: string }> {
  const url = new URL(path, options.url);
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-lumi-site', options.site);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  const response = await fetcher(url, { ...init, headers });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : null) as T;
  if (response.ok) return { ok: true, body };
  return { ok: false, body, error: `${init.method ?? 'GET'} ${path} -> ${response.status}: ${text}` };
}

function parseFlags(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--') && !arg?.startsWith('-')) continue;
    const key = arg.replace(/^-+/, '');
    const value = argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : true;
    args[key] = value;
  }
  return args;
}

function firstPositional(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith('-'));
}

function parseMode(value: string | true | undefined): AccessImportMode {
  if (value === 'replace-managed' || value === 'replace-all' || value === 'merge') return value;
  return 'merge';
}

function flagValue(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runAccessCli(parseAccessArgs(process.argv.slice(2)));
  process.exit(code);
}
