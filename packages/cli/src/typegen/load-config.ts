import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from '../errors.js';
import {
  TYPEGEN_TARGET_TYPES,
  type TypegenConfig,
  type TypegenSource,
  type TypegenTarget,
  type TypegenTargetType,
} from '../typegen-config.js';

/** Searched in this order, walking up from the working directory. */
export const TYPEGEN_CONFIG_FILENAMES = [
  'lumibase.typegen.config.ts',
  'lumibase.typegen.config.mts',
  'lumibase.typegen.config.js',
  'lumibase.typegen.config.mjs',
  'lumibase.typegen.config.json',
] as const;

export interface LoadedTypegenConfig {
  path: string;
  /** Directory relative paths (outputs, manifest files) resolve against. */
  dir: string;
  configs: TypegenConfig[];
}

export function findTypegenConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of TYPEGEN_CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads a typegen config module.
 *
 * - `.json` is parsed directly.
 * - `.js` / `.mjs` go through Node's own `import()`.
 * - `.ts` / `.mts` go through jiti: Node 22.0–22.17 cannot import TypeScript
 *   without a flag, and jiti is a small, dependency-free, widely used loader
 *   (ESLint, Tailwind and Nuxt load their TS configs with it). It is loaded
 *   lazily, so JSON / JS configs never pay for it.
 */
export async function loadTypegenConfig(path: string): Promise<LoadedTypegenConfig> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new CliError(`Typegen config not found: ${absolute}`);

  const ext = extname(absolute);
  let exported: unknown;

  try {
    if (ext === '.json') {
      exported = JSON.parse(readFileSync(absolute, 'utf8'));
    } else if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      const { createJiti } = await import('jiti');
      const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
      exported = await jiti.import(absolute, { default: true });
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const mod = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
      exported = mod.default ?? mod;
    } else {
      throw new CliError(`Unsupported typegen config extension "${ext}" (${absolute}).`);
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `Could not load ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { path: absolute, dir: dirname(absolute), configs: validateTypegenConfig(exported, absolute) };
}

/** Narrows an untrusted export to `TypegenConfig[]`, with an error naming the bad key. */
export function validateTypegenConfig(value: unknown, origin = 'typegen config'): TypegenConfig[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw new CliError(`${origin} exports an empty array.`);

  const configs = list.map((entry, index) => validateOne(entry, `${origin} [${index}]`));

  const outs = new Map<string, string>();
  configs.forEach((config, index) => {
    for (const target of config.targets) {
      const label = config.name ?? `config #${index + 1}`;
      const key = normalize(target.out);
      const previous = outs.get(key);
      if (previous) {
        throw new CliError(
          `${origin}: "${target.out}" is written by both ${previous} and ${label} (${target.type}).`,
          'Give every target its own output path.',
        );
      }
      outs.set(key, `${label} (${target.type})`);
    }
  });

  return configs;
}

function validateOne(value: unknown, where: string): TypegenConfig {
  const obj = asObject(value, where);
  const targetsRaw = obj['targets'];
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    throw new CliError(`${where}: "targets" must be a non-empty array.`);
  }

  return {
    name: optionalString(obj, 'name', where),
    source: obj['source'] === undefined ? undefined : validateSource(obj['source'], `${where}.source`),
    include: optionalStringArray(obj, 'include', where),
    exclude: optionalStringArray(obj, 'exclude', where),
    targets: targetsRaw.map((target, i) => validateTarget(target, `${where}.targets[${i}]`)),
  };
}

function validateSource(value: unknown, where: string): TypegenSource {
  const obj = asObject(value, where);
  // Same rule as lumibase.config.json: a token in a committed file is a leak.
  if ('token' in obj) {
    throw new CliError(
      `${where} must not contain a "token".`,
      'Name the environment variable that holds it instead: { tokenEnv: "MY_LUMIBASE_TOKEN" }.',
    );
  }
  if ('manifest' in obj) {
    const manifest = optionalString(obj, 'manifest', where);
    if (!manifest) throw new CliError(`${where}.manifest must be a non-empty path.`);
    const extra = Object.keys(obj).filter((key) => key !== 'manifest');
    if (extra.length > 0) {
      throw new CliError(`${where}: a manifest-file source takes no other keys (got ${extra.join(', ')}).`);
    }
    return { manifest };
  }
  return {
    url: optionalString(obj, 'url', where),
    site: optionalString(obj, 'site', where),
    urlEnv: optionalString(obj, 'urlEnv', where),
    siteEnv: optionalString(obj, 'siteEnv', where),
    tokenEnv: optionalString(obj, 'tokenEnv', where),
  };
}

function validateTarget(value: unknown, where: string): TypegenTarget {
  const obj = asObject(value, where);
  const rawType = obj['type'];
  if (typeof rawType !== 'string' || !(TYPEGEN_TARGET_TYPES as readonly string[]).includes(rawType)) {
    throw new CliError(
      `${where}.type must be one of ${TYPEGEN_TARGET_TYPES.join(', ')} (got ${JSON.stringify(rawType)}).`,
    );
  }
  const type = rawType as TypegenTargetType;
  const out = optionalString(obj, 'out', where);
  if (!out) throw new CliError(`${where}.out must be a non-empty path.`);

  switch (type) {
    case 'ts': {
      const branded = obj['branded'];
      if (branded !== undefined && typeof branded !== 'boolean') {
        throw new CliError(`${where}.branded must be a boolean.`);
      }
      return { type, out, branded, importFrom: optionalString(obj, 'importFrom', where) };
    }
    case 'zod':
      return { type, out, importFrom: optionalString(obj, 'importFrom', where) };
    case 'openapi':
      return {
        type,
        out,
        title: optionalString(obj, 'title', where),
        version: optionalString(obj, 'version', where),
      };
    case 'graphql-sdl':
    case 'manifest':
      return { type, out };
    default:
      throw new CliError(`${where}.type is not supported.`);
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(obj: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CliError(`${where}.${key} must be a string.`);
  return value;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new CliError(`${where}.${key} must be an array of strings.`);
  }
  return value.length > 0 ? (value as string[]) : undefined;
}
