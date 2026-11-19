import { describe, expect, it } from 'vitest';
import { CONTENT_OS_RELEASE_FLAGS } from '../../../services/feature-flags';
import { parseDecisionSettings } from '../../../services/decision-governance';
import { defineReleaseFlags, RELEASE_FLAGS, SITE_RELEASE_FLAGS_SETTINGS_KEY, siteSettingsKeysOf } from '../registry';
import { resolveReleaseFlag } from '../resolver';
import { composeSiteValues, groupSiteChanges, LEGACY_SITE_READERS } from '../storage';

/**
 * #896: switches that predate the registry are declared in it without moving
 * their stored values. These tests pin the "no behaviour change" contract
 * without a database: with no manifest and no override, the registry's
 * effective value for every stored shape equals what the legacy reader
 * returned before the migration.
 */

const LEGACY = [...RELEASE_FLAGS.values()].filter((def) => def.siteSetting);
const NO_GATE = { envOverrides: new Map<string, boolean>(), manifestFlags: null } as const;

/** The pre-#896 readers, verbatim in behaviour. */
const BEFORE: Record<string, (stored: unknown, field: string) => boolean> = {
  contentOs: (stored, field) =>
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)[field] === true
      : false,
  aiDecisions: (stored, field) =>
    (parseDecisionSettings(stored) as unknown as Record<string, unknown>)[field] === true,
};

/** Stored shapes a site may have today, including malformed ones. */
const SHAPES = (field: string): unknown[] => [
  undefined,
  null,
  {},
  [],
  'on',
  { [field]: true },
  { [field]: false },
  { [field]: 'true' },
  { [field]: 1 },
  { [field]: true, enabled: true },
  { [field]: true, enabled: 'yes' }, // malformed aiDecisions object
  { [field]: true, unrelated: { nested: true } },
];

describe('legacy switches in the release-flag registry (#896)', () => {
  it('declares exactly the inventoried release gates', () => {
    expect(LEGACY.map((def) => `${def.key} ← ${def.siteSetting!.key}.${def.siteSetting!.field}`)).toEqual([
      'content-os.reconciler ← contentOs.reconciler',
      'content-os.veto-window ← contentOs.vetoWindow',
      'content-os.agent-review ← contentOs.agentReview',
      'content-os.mcp ← contentOs.mcp',
      'ai-decisions.flows ← aiDecisions.flows',
      'ai-decisions.drift ← aiDecisions.drift',
    ]);
  });

  it('keeps every existing site where it was: ga, per-site, default OFF', () => {
    for (const def of LEGACY) {
      expect(def, def.key).toMatchObject({ stage: 'ga', siteToggle: true, siteDefault: false });
    }
  });

  it('has a reader for every legacy settings key and maps every Content OS field', () => {
    for (const def of LEGACY) expect(LEGACY_SITE_READERS[def.siteSetting!.key], def.key).toBeTypeOf('function');
    for (const key of Object.values(CONTENT_OS_RELEASE_FLAGS)) {
      expect(RELEASE_FLAGS.get(key)?.siteSetting?.key).toBe('contentOs');
    }
    expect(siteSettingsKeysOf(RELEASE_FLAGS).sort()).toEqual(
      [SITE_RELEASE_FLAGS_SETTINGS_KEY, 'aiDecisions', 'contentOs'].sort(),
    );
  });

  it('configuration values stay out of the registry', () => {
    const keys = new Set(LEGACY.map((def) => def.siteSetting!.key));
    for (const config of ['files.dam', 'openapi', 'encryption.envelope', 'deployment.environments']) {
      expect(keys.has(config), config).toBe(false);
    }
    // aiDecisions.enabled is the site's consent to send content to a provider,
    // not a release gate.
    expect(LEGACY.some((def) => def.siteSetting!.key === 'aiDecisions' && def.siteSetting!.field === 'enabled')).toBe(false);
  });

  it('with no manifest and no override, every stored shape resolves as before', () => {
    for (const def of LEGACY) {
      const { key: settingsKey, field } = def.siteSetting!;
      for (const stored of SHAPES(field)) {
        const siteValues = composeSiteValues(new Map([[settingsKey, stored]]), RELEASE_FLAGS);
        const state = resolveReleaseFlag(def, { ...NO_GATE, siteValues });
        expect(state.enabled, `${def.key} ← ${JSON.stringify(stored)}`).toBe(BEFORE[settingsKey]!(stored, field));
        expect(state.released).toBe(true);
      }
    }
  });

  it('the release gate can withdraw a legacy switch but never turn one on', () => {
    for (const def of LEGACY) {
      const { key: settingsKey, field } = def.siteSetting!;
      const on = composeSiteValues(new Map([[settingsKey, { [field]: true }]]), RELEASE_FLAGS);
      const off = composeSiteValues(new Map([[settingsKey, {}]]), RELEASE_FLAGS);
      const withdrawn = { envOverrides: new Map([[def.key, false]]), manifestFlags: null };
      const byManifest = { envOverrides: new Map<string, boolean>(), manifestFlags: { [def.key]: false } };
      const released = { envOverrides: new Map([[def.key, true]]), manifestFlags: null };
      expect(resolveReleaseFlag(def, { ...withdrawn, siteValues: on }).enabled).toBe(false);
      expect(resolveReleaseFlag(def, { ...byManifest, siteValues: on }).enabled).toBe(false);
      expect(resolveReleaseFlag(def, { ...released, siteValues: off }).enabled).toBe(false);
      expect(resolveReleaseFlag(def, { ...released, siteValues: on }).enabled).toBe(true);
    }
  });

  it('ignores a legacy flag key written under release.flags', () => {
    const values = composeSiteValues(
      new Map<string, unknown>([[SITE_RELEASE_FLAGS_SETTINGS_KEY, { 'content-os.mcp': true, 'content-environments': true }]]),
      RELEASE_FLAGS,
    );
    expect(values).toEqual({ 'content-environments': true });
  });

  it('routes writes to the storage each flag reads from', () => {
    const groups = groupSiteChanges(
      { 'content-os.mcp': true, 'content-os.reconciler': null, 'ai-decisions.flows': false, 'content-environments': true },
      RELEASE_FLAGS,
    );
    expect(Object.fromEntries(groups)).toEqual({
      contentOs: { set: { mcp: true }, cleared: ['reconciler'] },
      aiDecisions: { set: { flows: false }, cleared: [] },
      [SITE_RELEASE_FLAGS_SETTINGS_KEY]: { set: { 'content-environments': true }, cleared: [] },
    });
  });

  it('rejects malformed legacy declarations', () => {
    const base = { description: 'd', stage: 'ga', siteDefault: false, owner: '#896', removeBy: '2099-01-01' } as const;
    expect(() =>
      defineReleaseFlags([{ ...base, key: 'a', siteToggle: false, siteSetting: { key: 'x', field: 'a' } }]),
    ).toThrow(/not a siteToggle/);
    expect(() =>
      defineReleaseFlags([{ ...base, key: 'a', siteToggle: true, siteSetting: { key: 'release.flags', field: 'a' } }]),
    ).toThrow(/invalid siteSetting/);
    expect(() =>
      defineReleaseFlags([
        { ...base, key: 'a', siteToggle: true, siteSetting: { key: 'x', field: 'f' } },
        { ...base, key: 'b', siteToggle: true, siteSetting: { key: 'x', field: 'f' } },
      ]),
    ).toThrow(/reuses the site setting/);
  });
});
