import { parseDecisionSettings } from '../../services/decision-governance';
import { SITE_RELEASE_FLAGS_SETTINGS_KEY, type ReleaseFlagDefinition } from './registry';

/**
 * Where each flag's site choice lives (#896).
 *
 * Flags declared after the registry keep site choices under `release.flags`,
 * keyed by flag key. Switches that predate it keep their original location —
 * a field of an existing `lumibase_settings` object — so no stored value moves
 * and no site changes state. Each legacy settings key has a reader that
 * interprets the stored object exactly like the feature's own reader does.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Stored boolean, or `null` when the site never chose. */
export type LegacySiteReader = (stored: unknown, field: string) => boolean | null;

const plainBoolean: LegacySiteReader = (stored, field) => {
  const value = asRecord(stored)[field];
  return typeof value === 'boolean' ? value : null;
};

/**
 * One reader per legacy settings key. `contentOs` fields are read with
 * `=== true` by `getContentOsFlags`; `aiDecisions` is parsed as a whole by
 * `parseDecisionSettings`, which reads a malformed object as all-off.
 */
export const LEGACY_SITE_READERS: Readonly<Record<string, LegacySiteReader>> = {
  contentOs: plainBoolean,
  aiDecisions: (stored, field) => {
    if (plainBoolean(stored, field) === null) return null;
    return (parseDecisionSettings(stored) as unknown as Record<string, unknown>)[field] === true;
  },
};

/**
 * Turn stored settings rows (`settings key → value`) into the per-flag values
 * the resolver reads. A legacy flag's key under `release.flags` is ignored:
 * its legacy location is the only source.
 */
export function composeSiteValues(
  rows: ReadonlyMap<string, unknown>,
  registry: ReadonlyMap<string, ReleaseFlagDefinition>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...asRecord(rows.get(SITE_RELEASE_FLAGS_SETTINGS_KEY)) };
  for (const def of registry.values()) {
    if (!def.siteSetting) continue;
    delete out[def.key];
    const reader = LEGACY_SITE_READERS[def.siteSetting.key] ?? plainBoolean;
    const value = reader(rows.get(def.siteSetting.key), def.siteSetting.field);
    if (value !== null) out[def.key] = value;
  }
  return out;
}

/** Changes for one settings object: fields to set and fields to remove. */
export interface SettingsObjectChange {
  readonly set: Record<string, boolean>;
  readonly cleared: string[];
}

/**
 * Group `changes` (flag key → value, `null` clears) by the settings object
 * that stores them. Keys the registry does not declare are grouped under
 * `release.flags` as before; the route refuses them earlier.
 */
export function groupSiteChanges(
  changes: Readonly<Record<string, boolean | null>>,
  registry: ReadonlyMap<string, ReleaseFlagDefinition>,
): Map<string, SettingsObjectChange> {
  const groups = new Map<string, { set: Record<string, boolean>; cleared: string[] }>();
  for (const [key, value] of Object.entries(changes)) {
    const location = registry.get(key)?.siteSetting;
    const settingsKey = location?.key ?? SITE_RELEASE_FLAGS_SETTINGS_KEY;
    const field = location?.field ?? key;
    let group = groups.get(settingsKey);
    if (!group) {
      group = { set: {}, cleared: [] };
      groups.set(settingsKey, group);
    }
    if (value === null) group.cleared.push(field);
    else group.set[field] = value;
  }
  return groups;
}
