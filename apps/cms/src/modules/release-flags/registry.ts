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
}

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
    if (!DATE_PATTERN.test(def.removeBy) || Number.isNaN(Date.parse(`${def.removeBy}T00:00:00Z`))) {
      throw new Error(`Release flag "${def.key}" has an invalid removeBy date "${def.removeBy}".`);
    }
    byKey.set(def.key, Object.freeze({ ...def }));
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
