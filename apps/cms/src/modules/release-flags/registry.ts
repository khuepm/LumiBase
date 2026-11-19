/**
 * Release-flag registry (#869).
 *
 * Every feature that ships to `main` before it is meant to run in production is
 * declared here, once. The declaration is the contract the rest of the module
 * relies on:
 *
 *  - `stage` decides what an instance does when nobody has said anything:
 *    `ga` is released, `dark` and `beta` are not. LumiBase releases a `dark`
 *    feature by issuing a signed manifest (see `./manifest`); an operator can
 *    force any flag with `LUMIBASE_RELEASE_FLAGS`.
 *  - `siteToggle` says whether site admins may switch a released feature on or
 *    off for their own site. `siteDefault` is the value for a site that never
 *    chose.
 *  - `siteSetting` (optional) names where a site's choice is stored when the
 *    switch predates this registry (#896): the field of an existing
 *    `lumibase_settings` object such as `contentOs.mcp`. Those switches are
 *    declared `ga` so an instance with no manifest and no override behaves
 *    exactly as before; the registry adds the ability to withdraw them per
 *    deployment. New flags store site choices under `release.flags` instead.
 *  - `owner` and `removeBy` keep flags from becoming permanent: every flag
 *    doubles a code path, so it carries the issue that owns it and the date by
 *    which the flag (not the feature) must be deleted. `registry.test.ts` fails
 *    once that date has passed.
 *
 * A flag gates code, never schema: migrations ship with the version and run
 * whether a flag is on or not, so every migration behind a flag must be
 * additive and safe while the feature is off.
 */

export const RELEASE_STAGES = ['dark', 'beta', 'ga'] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export interface ReleaseFlagDefinition {
  /** Stable identifier: lower-case words joined by `-` or `.`. */
  readonly key: string;
  /** One sentence shown to site admins. */
  readonly description: string;
  readonly stage: ReleaseStage;
  /** Site admins may switch the released feature per site. */
  readonly siteToggle: boolean;
  /** Value for a site that never chose. Only read when `siteToggle` is true. */
  readonly siteDefault: boolean;
  /** Issue or spec that owns the flag, e.g. `#853`. */
  readonly owner: string;
  /** `YYYY-MM-DD`: the flag must be removed from the code by this date. */
  readonly removeBy: string;
  /**
   * Legacy storage of the site choice: field `field` of the object stored under
   * settings key `key`. Absent → the choice lives under `release.flags`.
   */
  readonly siteSetting?: ReleaseFlagSiteSetting;
}

export interface ReleaseFlagSiteSetting {
  /** `lumibase_settings.key`, e.g. `contentOs`. */
  readonly key: string;
  /** Top-level field of that object holding the boolean, e.g. `mcp`. */
  readonly field: string;
}

/** Settings key holding site choices of flags without a legacy `siteSetting`. */
export const SITE_RELEASE_FLAGS_SETTINGS_KEY = 'release.flags';

export const RELEASE_FLAG_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The declared flags. `as const` keeps each key as a literal so
 * `requireReleaseFlag('typo')` fails to compile.
 */
const DEFINITIONS = [
  {
    key: 'content-environments',
    description:
      'Fork a site into an isolated environment and promote schema and content back to the origin site.',
    stage: 'dark',
    siteToggle: true,
    siteDefault: false,
    owner: '#853',
    removeBy: '2027-06-30',
  },
  // ── Switches that predate the registry (#896) ──────────────────────────────
  // Each keeps its existing storage and its OFF site default; declaring it
  // `ga` keeps every existing site's behaviour while letting a manifest or
  // LUMIBASE_RELEASE_FLAGS withdraw it on a deployment. Configuration values
  // (files.dam, openapi, encryption.envelope, …) are deliberately not here —
  // see docs/en/features/release-flags.md "Existing switches".
  {
    key: 'content-os.reconciler',
    description: 'Drift scans create reconciler goals (Content OS Module B).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'contentOs', field: 'reconciler' },
  },
  {
    key: 'content-os.veto-window',
    description: 'Dangerous agent actions at autonomy L3 are staged with a veto window instead of waiting for approval (Content OS Module D).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'contentOs', field: 'vetoWindow' },
  },
  {
    key: 'content-os.agent-review',
    description: 'Reviewer agents may decide pending approvals (Content OS Module C).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'contentOs', field: 'agentReview' },
  },
  {
    key: 'content-os.mcp',
    description: 'The /api/v1/mcp endpoint accepts requests (Content OS Module A).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'contentOs', field: 'mcp' },
  },
  {
    key: 'ai-decisions.flows',
    description: 'Flows may run ai:decision nodes. Also needs the site AI decisions opt-in (aiDecisions.enabled).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'aiDecisions', field: 'flows' },
  },
  {
    key: 'ai-decisions.drift',
    description: 'Drift scans evaluate semantic rules with AI decisions. Also needs the site AI decisions opt-in (aiDecisions.enabled).',
    stage: 'ga',
    siteToggle: true,
    siteDefault: false,
    owner: '#896',
    removeBy: '2027-12-31',
    siteSetting: { key: 'aiDecisions', field: 'drift' },
  },
] as const satisfies readonly ReleaseFlagDefinition[];

export type ReleaseFlagKey = (typeof DEFINITIONS)[number]['key'];

/**
 * Validate a set of definitions and index it by key. Throws on the first
 * problem: a malformed registry is a programming error and must fail at import,
 * not on the first request that happens to read the bad entry.
 */
export function defineReleaseFlags(
  definitions: readonly ReleaseFlagDefinition[],
): ReadonlyMap<string, ReleaseFlagDefinition> {
  const byKey = new Map<string, ReleaseFlagDefinition>();
  const locations = new Set<string>();
  for (const def of definitions) {
    if (!RELEASE_FLAG_KEY_PATTERN.test(def.key)) {
      throw new Error(`Release flag key "${def.key}" must match ${RELEASE_FLAG_KEY_PATTERN}.`);
    }
    if (byKey.has(def.key)) throw new Error(`Release flag "${def.key}" is declared twice.`);
    if (!(RELEASE_STAGES as readonly string[]).includes(def.stage)) {
      throw new Error(`Release flag "${def.key}" has unknown stage "${def.stage}".`);
    }
    if (!def.description.trim()) throw new Error(`Release flag "${def.key}" needs a description.`);
    if (!def.owner.trim()) throw new Error(`Release flag "${def.key}" needs an owner.`);
    if (def.siteSetting) {
      const { key, field } = def.siteSetting;
      if (!def.siteToggle) throw new Error(`Release flag "${def.key}" has a siteSetting but is not a siteToggle.`);
      if (!key.trim() || !field.trim() || key === SITE_RELEASE_FLAGS_SETTINGS_KEY) {
        throw new Error(`Release flag "${def.key}" has an invalid siteSetting.`);
      }
      const location = `${key}\u0000${field}`;
      if (locations.has(location)) {
        throw new Error(`Release flag "${def.key}" reuses the site setting ${key}.${field}.`);
      }
      locations.add(location);
    }
    if (!DATE_PATTERN.test(def.removeBy) || Number.isNaN(Date.parse(`${def.removeBy}T00:00:00Z`))) {
      throw new Error(`Release flag "${def.key}" has an invalid removeBy date "${def.removeBy}".`);
    }
    byKey.set(
      def.key,
      Object.freeze({ ...def, ...(def.siteSetting ? { siteSetting: Object.freeze({ ...def.siteSetting }) } : {}) }),
    );
  }
  return byKey;
}

/** The registry the CMS evaluates. */
export const RELEASE_FLAGS: ReadonlyMap<string, ReleaseFlagDefinition> = defineReleaseFlags(DEFINITIONS);

/** Declared flags whose `removeBy` date is before `today` (`YYYY-MM-DD`). */
export function expiredReleaseFlags(
  registry: ReadonlyMap<string, ReleaseFlagDefinition>,
  today: string,
): string[] {
  return [...registry.values()].filter((def) => def.removeBy < today).map((def) => def.key);
}

/** Settings keys a site's choices are read from: `release.flags` plus every legacy key. */
export function siteSettingsKeysOf(registry: ReadonlyMap<string, ReleaseFlagDefinition>): string[] {
  const keys = new Set<string>([SITE_RELEASE_FLAGS_SETTINGS_KEY]);
  for (const def of registry.values()) if (def.siteSetting) keys.add(def.siteSetting.key);
  return [...keys];
}
