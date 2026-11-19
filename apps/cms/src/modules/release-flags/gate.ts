import type { Database } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import { RELEASE_FLAGS, type ReleaseFlagDefinition, type ReleaseFlagKey } from './registry';
import { parseReleaseFlagOverrides, resolveReleaseFlag, type ReleaseFlagState } from './resolver';
import { loadAcceptedManifest, trustedAcceptedManifest, type ReleaseEnv } from './state';

/**
 * The release gate for code that runs outside a request (#896): reconciler
 * cycles, the AI harness, queue consumers, scheduled sweeps. Such code has no
 * Hono context to read env bindings from, so the gate uses the environment the
 * process last saw — remembered by every request that evaluates flags and by
 * the Workers `fetch` / `queue` / `scheduled` entry points — falling back to
 * `process.env` (the Node/Docker entry).
 */

export const RELEASE_ENV_KEYS = [
  'LUMIBASE_RELEASE_FLAGS',
  'LUMIBASE_RELEASE_PUBLIC_KEYS',
  'LUMIBASE_RELEASE_MANIFEST_URL',
  'LUMIBASE_RELEASE_MANIFEST_REFRESH_S',
  'LUMIBASE_INSTANCE_ID',
] as const satisfies readonly (keyof ReleaseEnv)[];

let rememberedEnv: ReleaseEnv | null = null;

/** Pick the release variables from a bindings object, then `process.env`. */
export function pickReleaseEnv(bindings: unknown): ReleaseEnv {
  const source = (bindings && typeof bindings === 'object' ? bindings : {}) as Partial<
    Record<(typeof RELEASE_ENV_KEYS)[number], unknown>
  >;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const out: Record<string, string | undefined> = {};
  for (const key of RELEASE_ENV_KEYS) {
    const bound = source[key];
    out[key] = typeof bound === 'string' ? bound : proc[key];
  }
  return out as ReleaseEnv;
}

/**
 * Remember the environment for evaluations that have no request context.
 * `null` forgets it (tests).
 */
export function rememberReleaseEnv(env: ReleaseEnv | null): void {
  rememberedEnv = env;
}

/** The environment last remembered, else `process.env`. */
export function currentReleaseEnv(): ReleaseEnv {
  return rememberedEnv ?? pickReleaseEnv(undefined);
}

/**
 * Effective state of flags whose site choice the caller has already read from
 * its own storage (`siteSetting`). `siteValues` maps a flag key to the stored
 * boolean, or `null` when the site never chose.
 *
 * Fails toward the stage default: if the manifest cannot be read the last
 * manifest this process read still applies, and with none the flag's stage
 * decides — for the `ga` switches migrated in #896 that is the pre-registry
 * behaviour. A read failure therefore never switches a feature off.
 */
export async function resolveStoredSiteFlags(
  db: Database,
  siteValues: Readonly<Partial<Record<ReleaseFlagKey, boolean | null>>>,
  options: { env?: ReleaseEnv; registry?: ReadonlyMap<string, ReleaseFlagDefinition> } = {},
): Promise<Map<string, ReleaseFlagState>> {
  const registry = options.registry ?? RELEASE_FLAGS;
  const env = options.env ?? currentReleaseEnv();
  const { overrides } = parseReleaseFlagOverrides(env.LUMIBASE_RELEASE_FLAGS, registry);
  let manifestFlags: Readonly<Record<string, boolean>> | null = null;
  try {
    manifestFlags = (await trustedAcceptedManifest(await loadAcceptedManifest(db), env))?.flags ?? null;
  } catch (err) {
    console.warn('[release-flags] gate could not check the manifest', formatSafeError(err));
  }
  const states = new Map<string, ReleaseFlagState>();
  const values: Record<string, unknown> = { ...siteValues };
  for (const key of Object.keys(siteValues)) {
    const def = registry.get(key);
    if (!def) continue;
    states.set(key, resolveReleaseFlag(def, { envOverrides: overrides, manifestFlags, siteValues: values }));
  }
  return states;
}
