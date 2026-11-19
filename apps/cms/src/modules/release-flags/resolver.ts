import type { ReleaseFlagDefinition, ReleaseStage } from './registry';

/**
 * Pure evaluation of one release flag (#869). No I/O: everything the decision
 * depends on arrives in {@link ReleaseInputs}, so the precedence can be
 * property-tested.
 *
 * Two layers, in this order:
 *
 *  1. **Release gate** (instance-wide) — is the feature released on this
 *     deployment at all? First match wins:
 *       `LUMIBASE_RELEASE_FLAGS` override → accepted signed manifest → stage
 *       default (`ga` released; `dark`/`beta` not).
 *  2. **Site choice** — only for released flags declared `siteToggle`: the
 *     site's own setting, else the flag's `siteDefault`.
 *
 * A site can never switch on a feature the release gate keeps off. The env
 * override sits above the manifest on purpose: it is the operator's kill
 * switch, and on a self-hosted instance the operator controls the code anyway
 * (a flag is not a security or licensing boundary there).
 */

export type ReleasedBy = 'env' | 'manifest' | 'stage';
export type EnabledBy = 'release' | 'site' | 'site-default';

export interface ReleaseInputs {
  /** Parsed `LUMIBASE_RELEASE_FLAGS`. */
  readonly envOverrides: ReadonlyMap<string, boolean>;
  /** `flags` of the accepted manifest, or `null` when none was accepted. */
  readonly manifestFlags: Readonly<Record<string, boolean>> | null;
  /** The site's stored choices (`settings` key `release.flags`). */
  readonly siteValues: Readonly<Record<string, unknown>>;
}

export interface ReleaseFlagState {
  readonly key: string;
  readonly stage: ReleaseStage;
  /** Released on this instance. */
  readonly released: boolean;
  readonly releasedBy: ReleasedBy;
  /** Effective for the site: what gated code paths obey. */
  readonly enabled: boolean;
  readonly enabledBy: EnabledBy;
  /** The site's stored choice, `null` when it never chose (or cannot). */
  readonly siteValue: boolean | null;
}

export function resolveReleaseFlag(def: ReleaseFlagDefinition, inputs: ReleaseInputs): ReleaseFlagState {
  let released: boolean;
  let releasedBy: ReleasedBy;
  const envValue = inputs.envOverrides.get(def.key);
  const manifestValue = inputs.manifestFlags?.[def.key];
  if (envValue !== undefined) {
    released = envValue;
    releasedBy = 'env';
  } else if (typeof manifestValue === 'boolean') {
    released = manifestValue;
    releasedBy = 'manifest';
  } else {
    released = def.stage === 'ga';
    releasedBy = 'stage';
  }

  const stored = inputs.siteValues[def.key];
  const siteValue = def.siteToggle && typeof stored === 'boolean' ? stored : null;
  const base = { key: def.key, stage: def.stage, released, releasedBy, siteValue };

  if (!released || !def.siteToggle) {
    return { ...base, enabled: released, enabledBy: 'release' };
  }
  if (siteValue !== null) return { ...base, enabled: siteValue, enabledBy: 'site' };
  return { ...base, enabled: def.siteDefault, enabledBy: 'site-default' };
}

const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['off', 'false', '0', 'no']);

/**
 * Parse `LUMIBASE_RELEASE_FLAGS`: comma- or whitespace-separated `key=on|off`
 * pairs (`true/false`, `1/0`, `yes/no` also accepted). Entries that do not
 * parse, or name a flag the registry does not declare, are returned in
 * `ignored` so the caller can log them; they never change a decision.
 */
export function parseReleaseFlagOverrides(
  raw: string | undefined,
  known: ReadonlyMap<string, unknown>,
): { overrides: Map<string, boolean>; ignored: string[] } {
  const overrides = new Map<string, boolean>();
  const ignored: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/)) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = (eq === -1 ? '' : entry.slice(0, eq)).trim().toLowerCase();
    const value = (eq === -1 ? '' : entry.slice(eq + 1)).trim().toLowerCase();
    if (!key || !known.has(key) || (!ON.has(value) && !OFF.has(value))) {
      ignored.push(entry);
      continue;
    }
    overrides.set(key, ON.has(value));
  }
  return { overrides, ignored };
}
