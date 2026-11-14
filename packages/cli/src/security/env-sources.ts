/**
 * Collects the configuration a LumiBase deployment would actually run with,
 * from the files a project keeps next to it — without executing anything.
 *
 * Sources, lowest precedence first:
 *
 *   1. dotenv files (`.env`, `.env.local`, `.dev.vars`, or `--env-file`).
 *   2. the process environment — it wins over a dotenv file for both
 *      `node --env-file` and Docker Compose interpolation.
 *   3. `[vars]` in `wrangler.toml` (Cloudflare bindings).
 *   4. literal `environment:` entries in `docker-compose.yml` / `compose.yaml`,
 *      with `${VAR}` / `${VAR:-default}` / `${VAR:?error}` resolved against 1+2
 *      the way Compose does. These are what the container sees.
 *
 * Node built-ins only: this runs from the CLI, never inside the CMS.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type EnvSourceKind = 'dotenv' | 'process' | 'wrangler' | 'compose';

export interface EnvValue {
  value: string;
  /** File (relative to cwd) or `process environment`. */
  source: string;
  kind: EnvSourceKind;
  /**
   * True when the value is written out literally in a file that is normally
   * committed (`wrangler.toml` `[vars]`, a compose `environment:` entry) rather
   * than read from a gitignored dotenv file or the environment.
   */
  committedLiteral: boolean;
}

export interface ProjectEnv {
  values: Map<string, EnvValue>;
  /** Every file that was read, relative to cwd. */
  files: string[];
  /** `cloudflare` when a wrangler config is present or LUMIBASE_RUNTIME says so. */
  runtime: 'docker' | 'cloudflare';
}

export const DEFAULT_ENV_FILES = ['.env', '.env.local', '.dev.vars'] as const;
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const WRANGLER_FILES = ['wrangler.toml'];

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Strip an unquoted trailing ` # comment`. */
function stripInlineComment(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0]!;
    const end = v.indexOf(quote, 1);
    return end === -1 ? v : v.slice(0, end + 1);
  }
  const hash = v.search(/\s#/);
  return hash === -1 ? v : v.slice(0, hash).trim();
}

/** Minimal dotenv reader: `KEY=value`, optional `export`, quotes, `#` comments. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    out.set(m[1]!, unquote(stripInlineComment(m[2]!)));
  }
  return out;
}

/** `[vars]` of a wrangler.toml — flat `KEY = "value"` pairs only. */
export function parseWranglerVars(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inVars = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]?\]\s*$/.exec(line);
    if (header) {
      // `[vars]` and `[env.<name>.vars]` both define runtime variables.
      inVars = /(^|\.)vars$/.test(header[1]!.trim());
      continue;
    }
    if (!inVars) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (m) out.set(m[1]!, unquote(stripInlineComment(m[2]!)));
  }
  return out;
}

export interface ComposeEntry {
  /** Raw value as written, before interpolation. */
  raw: string;
}

/**
 * The `environment:` entries of every service in a compose file. Supports the
 * map form (`KEY: value`) and the list form (`- KEY=value`). Indentation-based
 * on purpose: a full YAML parser is a dependency this check does not need.
 */
export function parseComposeEnvironment(text: string): Map<string, ComposeEntry> {
  const out = new Map<string, ComposeEntry>();
  const lines = text.split(/\r?\n/);
  let blockIndent = -1;
  for (const line of lines) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0 && indent <= blockIndent) blockIndent = -1;

    if (blockIndent < 0) {
      if (/^\s*environment:\s*(#.*)?$/.test(line)) blockIndent = indent;
      continue;
    }

    const body = line.trim();
    const list = /^-\s*["']?([A-Za-z_][A-Za-z0-9_]*)=(.*?)["']?\s*$/.exec(body);
    if (list) {
      out.set(list[1]!, { raw: list[2]! });
      continue;
    }
    const map = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
    if (map) out.set(map[1]!, { raw: unquote(stripInlineComment(map[2]!)) });
  }
  return out;
}

export interface Interpolated {
  /** `undefined` when the result is unset (e.g. `${X}` with X unset). */
  value: string | undefined;
  /** True when the value came only from text in the compose file itself. */
  literal: boolean;
}

/** Compose-style interpolation against `lookup`. */
export function interpolate(raw: string, lookup: (key: string) => string | undefined): Interpolated {
  let literal = true;
  let unset = false;
  const value = raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\$/g,
    (match, braced: string | undefined, op: string | undefined, arg: string | undefined, bare: string | undefined) => {
      if (match === '$$') return '$';
      const key = (braced ?? bare)!;
      literal = false;
      const current = lookup(key);
      const emptyCounts = op?.startsWith(':') ?? false;
      const missing = current === undefined || (emptyCounts && current === '');
      if (op === ':-' || op === '-') return missing ? (arg ?? '') : current!;
      if (missing) {
        unset = true;
        return '';
      }
      return current!;
    },
  );
  // A whole-value `${X}` / `${X:?msg}` with X unset leaves the key unset.
  if (unset && value === '') return { value: undefined, literal };
  return { value, literal };
}

export interface LoadProjectEnvOptions {
  /** Explicit dotenv files (relative to cwd). Defaults to {@link DEFAULT_ENV_FILES}. */
  envFiles?: readonly string[];
  /** Process environment overlay. Pass `{}` to ignore the shell. */
  processEnv?: Readonly<Record<string, string | undefined>>;
}

/** Variables worth taking from the shell: LumiBase's own, never unrelated noise. */
function isRelevantKey(key: string): boolean {
  return (
    /^(LUMIBASE_|REFRESH_COOKIE_|ENCRYPTION_KEY|NEXT_PUBLIC_|VITE_)/.test(key) ||
    [
      'JWT_SECRET',
      'CORS_ALLOWED_ORIGINS',
      'NODE_ENV',
      'DATABASE_URL',
      'DATABASE_SYSTEM_URL',
      'DATABASE_SSL_MODE',
      'REDIS_URL',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'MEILISEARCH_API_KEY',
      'ADMIN_EMAIL',
      'ADMIN_PASSWORD',
    ].includes(key)
  );
}

export function loadProjectEnv(cwd: string, options: LoadProjectEnvOptions = {}): ProjectEnv {
  const values = new Map<string, EnvValue>();
  const files: string[] = [];

  for (const rel of options.envFiles ?? DEFAULT_ENV_FILES) {
    const path = resolve(cwd, rel);
    if (!existsSync(path)) {
      if (options.envFiles) throw new Error(`Env file not found: ${rel}`);
      continue;
    }
    files.push(rel);
    for (const [key, value] of parseDotenv(readFileSync(path, 'utf8'))) {
      values.set(key, { value, source: rel, kind: 'dotenv', committedLiteral: false });
    }
  }

  const processEnv = options.processEnv ?? process.env;
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined || !isRelevantKey(key)) continue;
    values.set(key, { value, source: 'process environment', kind: 'process', committedLiteral: false });
  }

  // Interpolation sees dotenv + process only, as Compose does.
  const interpolationBase = new Map(values);
  const lookup = (key: string) => interpolationBase.get(key)?.value;

  let runtime: ProjectEnv['runtime'] = 'docker';
  for (const name of WRANGLER_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    runtime = 'cloudflare';
    files.push(name);
    for (const [key, value] of parseWranglerVars(readFileSync(path, 'utf8'))) {
      values.set(key, { value, source: name, kind: 'wrangler', committedLiteral: true });
    }
  }

  for (const name of COMPOSE_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    files.push(name);
    for (const [key, entry] of parseComposeEnvironment(readFileSync(path, 'utf8'))) {
      const resolved = interpolate(entry.raw, lookup);
      if (resolved.value === undefined) {
        values.delete(key);
        continue;
      }
      values.set(key, {
        value: resolved.value,
        source: name,
        kind: 'compose',
        committedLiteral: resolved.literal,
      });
    }
  }

  const declared = values.get('LUMIBASE_RUNTIME')?.value;
  if (declared === 'cloudflare') runtime = 'cloudflare';
  else if (declared === 'docker') runtime = 'docker';

  return { values, files, runtime };
}
