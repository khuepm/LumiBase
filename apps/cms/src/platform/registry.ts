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
  const accepted: Partial<PlatformSeams> = {};
  for (const name of Object.keys(DEFAULT_PLATFORM_SEAMS) as PlatformSeamName[]) {
    const implementation = seams[name];
    if (implementation !== undefined) accepted[name] = implementation;
  }
  overrides = accepted;
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
  overrides = null;
  resolved = null;
}
