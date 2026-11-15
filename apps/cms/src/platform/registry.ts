import type { ExternalActionToolSource } from '@lumibase/contracts/platform';
import { externalActionTools, type ExternalActionToolRegistry } from '../services/external-action-tools';
import { DEFAULT_PLATFORM_SEAMS } from './defaults';
import type { PlatformSeamName, PlatformSeams } from './types';

/**
 * Platform seam registry.
 *
 * A deployment entry that wraps the CMS calls `registerPlatformSeams()` once,
 * at module scope, before it serves anything. The built-in entry points
 * (`cloudflare.ts`, `serve.ts`) never call it, so a stock build runs entirely
 * on the defaults in `./defaults`.
 *
 * Same idea as `setRuntimeFactory()` in `middleware/runtime.ts`: injection at
 * the entry, never from a request handler. Module state is safe here on both
 * runtimes — one registration per Worker isolate, one per Node process.
 */

let overrides: Partial<PlatformSeams> | null = null;
let resolved: PlatformSeams | null = null;
/** Tools this registration put into the process-wide registry; undone by the test reset. */
let loadedToolNames: string[] = [];

/**
 * Validates and registers every tool of an `externalActions` source.
 *
 * All or nothing: if any definition is refused (malformed, duplicate, or a
 * name already registered), the ones registered before it are removed again
 * and the error propagates. A deployment entry that half-loaded its tools
 * would run with a governance surface nobody reviewed.
 */
export function loadExternalActionTools(
  source: ExternalActionToolSource,
  registry: ExternalActionToolRegistry = externalActionTools,
): string[] {
  const tools = source.tools();
  if (!Array.isArray(tools)) {
    throw new Error('externalActions.tools() must return an array of tool definitions.');
  }
  const loaded: string[] = [];
  try {
    for (const tool of tools) {
      registry.register(tool);
      loaded.push(tool.name);
    }
  } catch (err) {
    for (const name of loaded) registry.unregister(name);
    throw err;
  }
  return loaded;
}

/**
 * Supply implementations for one or more seams. Callable once, and only before
 * the first `platform()` read: a registration that arrives after a request has
 * already been answered on the defaults would apply to some requests and not
 * others, so it is refused loudly instead.
 */
export function registerPlatformSeams(seams: Partial<PlatformSeams>): void {
  if (overrides) {
    throw new Error('registerPlatformSeams() was already called; register every seam in one call.');
  }
  if (resolved) {
    throw new Error('registerPlatformSeams() must run before the first request is served.');
  }
  const accepted: Record<string, unknown> = {};
  for (const name of Object.keys(DEFAULT_PLATFORM_SEAMS) as PlatformSeamName[]) {
    const implementation = seams[name];
    if (implementation !== undefined) accepted[name] = implementation;
  }
  // Tools are loaded now, not on first read: a bad definition fails the entry
  // at boot, and the harness, `tools/list` and MCP all see the same set from
  // the first request on. Nothing is recorded if loading fails.
  const loaded = seams.externalActions ? loadExternalActionTools(seams.externalActions) : [];
  overrides = accepted as Partial<PlatformSeams>;
  loadedToolNames = loaded;
}

/** The complete seam set: registered implementations over built-in defaults. */
export function platform(): PlatformSeams {
  resolved ??= { ...DEFAULT_PLATFORM_SEAMS, ...overrides };
  return resolved;
}

/**
 * Whether the deployment entry supplied its own implementation of `name`.
 * Call sites use it to skip work that only an implementation needs (resolving
 * the tenant, for one), which keeps the default path free of added I/O.
 */
export function isPlatformSeamRegistered(name: PlatformSeamName): boolean {
  return overrides?.[name] !== undefined;
}

/** Test hook: forget any registration and return to the defaults. */
export function resetPlatformSeamsForTests(): void {
  for (const name of loadedToolNames) externalActionTools.unregister(name);
  loadedToolNames = [];
  overrides = null;
  resolved = null;
}
