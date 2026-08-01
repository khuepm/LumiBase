import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ExtensionManifestSchema,
  type ExtensionManifest,
} from '@lumibase/contracts/schemas';
import {
  MANIFEST_FILENAME,
  type DiscoverOptions,
  type DiscoveredExtension,
  type DiscoveryError,
  type DiscoveryResult,
} from './types';

/**
 * Extension discovery, Directus-style.
 *
 * Given a root directory (the `extensions/` submodule by default), each
 * immediate subdirectory containing a `lumibase-extension.json` is treated as
 * an extension. The manifest is validated against the shared Zod schema and the
 * `entry` path is resolved against the folder.
 *
 * This operates on SOURCE folders, not built bundles — `entry` typically points
 * at `./src/index.ts`. Bundling/serving is a separate concern handled by the
 * build pipeline or the dev-time Vite alias.
 */

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(
  sourceDir: string,
): Promise<{ manifest: ExtensionManifest } | { error: string }> {
  const manifestPath = join(sourceDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return { error: `missing ${MANIFEST_FILENAME}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON in ${MANIFEST_FILENAME}: ${(err as Error).message}` };
  }

  const parsed = ExtensionManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { error: `manifest validation failed: ${issues}` };
  }

  return { manifest: parsed.data };
}

/**
 * Discover all extensions under `rootDir`.
 *
 * `rootDir` is resolved to an absolute path. Subdirectories without a manifest
 * are silently skipped (they may be docs, fixtures, or the repo README). Folders
 * with a malformed manifest are collected into `errors` unless `strict` is set.
 */
export async function discoverExtensions(
  rootDir: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  const extensions: DiscoveredExtension[] = [];
  const errors: DiscoveryError[] = [];

  if (!(await pathExists(root))) {
    return { extensions, errors };
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      extensions,
      errors: [{ sourceDir: root, reason: `cannot read directory: ${(err as Error).message}` }],
    };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const sourceDir = join(root, entry.name);
    const manifestPath = join(sourceDir, MANIFEST_FILENAME);
    if (!(await pathExists(manifestPath))) continue; // not an extension folder

    const result = await readManifest(sourceDir);
    if ('error' in result) {
      if (options.strict) {
        throw new Error(`Extension at ${sourceDir}: ${result.error}`);
      }
      errors.push({ sourceDir, reason: result.error });
      continue;
    }

    const { manifest } = result;

    if (options.types && !options.types.includes(manifest.type)) {
      continue;
    }

    const entryPath = resolve(sourceDir, manifest.entry);
    if (!(await pathExists(entryPath))) {
      const reason = `entry "${manifest.entry}" does not exist`;
      if (options.strict) throw new Error(`Extension at ${sourceDir}: ${reason}`);
      errors.push({ sourceDir, reason });
      continue;
    }

    extensions.push({
      manifest,
      name: manifest.name,
      type: manifest.type,
      sourceDir,
      entryPath,
    });
  }

  // Stable ordering so consumers (and tests) get deterministic results.
  extensions.sort((a, b) => a.name.localeCompare(b.name));
  return { extensions, errors };
}

/**
 * Discover a single extension by folder path (no scanning). Returns null if the
 * folder has no manifest; throws/collects on validation just like the scanner.
 */
export async function discoverExtensionAt(
  sourceDir: string,
): Promise<DiscoveredExtension | null> {
  const dir = isAbsolute(sourceDir) ? sourceDir : resolve(process.cwd(), sourceDir);
  const manifestPath = join(dir, MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) return null;

  const result = await readManifest(dir);
  if ('error' in result) {
    throw new Error(`Extension at ${dir}: ${result.error}`);
  }

  const entryPath = resolve(dir, result.manifest.entry);
  return {
    manifest: result.manifest,
    name: result.manifest.name,
    type: result.manifest.type,
    sourceDir: dir,
    entryPath,
  };
}
