import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { CliError } from './errors.js';
import type { ParsedArgs } from './utils/args.js';
import { stringFlag } from './utils/args.js';

export const CONFIG_FILENAME = 'lumibase.config.json';

export interface TypegenFileConfig {
  out?: string;
  include?: string[];
  exclude?: string[];
  branded?: boolean;
}

export interface FileConfig {
  url?: string;
  siteId?: string;
  typegen?: TypegenFileConfig;
}

/** Where a resolved value came from — surfaced by `lumibase doctor`. */
export type ValueSource = 'flag' | 'env' | 'file' | 'missing';

export interface ResolvedConfig {
  url?: string;
  siteId?: string;
  token?: string;
  sources: { url: ValueSource; siteId: ValueSource; token: ValueSource };
  configPath?: string;
  typegen: TypegenFileConfig;
}

/** Walks up from `startDir` looking for a config file, stopping at the fs root. */
export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);

  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readConfigFile(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(
      `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${path} must contain a JSON object.`);
  }

  const config = parsed as Record<string, unknown>;

  // A token in a committed config file is a leaked credential waiting to
  // happen. Refuse loudly rather than silently ignoring it, so nobody assumes
  // it was picked up and ships the file.
  if ('token' in config) {
    throw new CliError(
      `${CONFIG_FILENAME} must not contain a "token".`,
      'Pass the token via the LUMIBASE_TOKEN environment variable or --token instead — this file is meant to be committed.',
    );
  }

  return {
    url: typeof config['url'] === 'string' ? config['url'] : undefined,
    siteId: typeof config['siteId'] === 'string' ? config['siteId'] : undefined,
    typegen: readTypegenSection(config['typegen']),
  };
}

function readTypegenSection(value: unknown): TypegenFileConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const section = value as Record<string, unknown>;

  return {
    out: typeof section['out'] === 'string' ? section['out'] : undefined,
    include: stringArray(section['include']),
    exclude: stringArray(section['exclude']),
    branded: typeof section['branded'] === 'boolean' ? section['branded'] : undefined,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string');
  return items.length > 0 ? items : undefined;
}

export interface ResolveConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves connection settings with precedence flag > env > config file.
 *
 * The token is deliberately *not* readable from the config file — see
 * {@link readConfigFile}.
 */
export function resolveConfig(args: ParsedArgs, options: ResolveConfigOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const configPath = findConfigFile(cwd);
  const file: FileConfig = configPath ? readConfigFile(configPath) : {};

  const url = pick(stringFlag(args, 'url'), env['LUMIBASE_URL'], file.url);
  const siteId = pick(stringFlag(args, 'site'), env['LUMIBASE_SITE_ID'], file.siteId);
  const token = pick(stringFlag(args, 'token'), env['LUMIBASE_TOKEN'], undefined);

  return {
    url: url.value ? stripTrailingSlash(url.value) : undefined,
    siteId: siteId.value,
    token: token.value,
    sources: { url: url.source, siteId: siteId.source, token: token.source },
    configPath,
    typegen: file.typegen ?? {},
  };
}

function pick(
  flag: string | undefined,
  envValue: string | undefined,
  fileValue: string | undefined,
): { value?: string; source: ValueSource } {
  if (flag) return { value: flag, source: 'flag' };
  if (envValue) return { value: envValue, source: 'env' };
  if (fileValue) return { value: fileValue, source: 'file' };
  return { source: 'missing' };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Narrows a resolved config to one that can actually reach an API. */
export function requireConnection(
  config: ResolvedConfig,
): asserts config is ResolvedConfig & { url: string; siteId: string; token: string } {
  const missing: string[] = [];
  if (!config.url) missing.push('url (--url / LUMIBASE_URL)');
  if (!config.siteId) missing.push('siteId (--site / LUMIBASE_SITE_ID)');
  if (!config.token) missing.push('token (--token / LUMIBASE_TOKEN)');

  if (missing.length > 0) {
    throw new CliError(
      `Missing connection settings: ${missing.join(', ')}.`,
      `Set them in the environment, or put "url" and "siteId" in ${CONFIG_FILENAME}. Run \`lumibase doctor\` to see what was resolved.`,
    );
  }
}
