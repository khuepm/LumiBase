import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defineReleaseFlags, type ReleaseFlagDefinition, type ReleaseStage } from '../registry';
import { parseReleaseFlagOverrides, resolveReleaseFlag, type ReleaseInputs } from '../resolver';

const def = (patch: Partial<ReleaseFlagDefinition> = {}): ReleaseFlagDefinition => ({
  key: 'demo',
  description: 'Demo.',
  stage: 'dark',
  siteToggle: true,
  siteDefault: false,
  owner: '#1',
  removeBy: '2099-01-01',
  ...patch,
});

const inputs = (patch: Partial<ReleaseInputs> = {}): ReleaseInputs => ({
  envOverrides: new Map(),
  manifestFlags: null,
  siteValues: {},
  ...patch,
});

describe('resolveReleaseFlag — release gate', () => {
  it.each<[ReleaseStage, boolean]>([
    ['dark', false],
    ['beta', false],
    ['ga', true],
  ])('stage %s defaults to released=%s', (stage, released) => {
    const state = resolveReleaseFlag(def({ stage, siteToggle: false }), inputs());
    expect(state).toMatchObject({ released, releasedBy: 'stage', enabled: released, enabledBy: 'release' });
  });

  it('a manifest releases a dark flag', () => {
    const state = resolveReleaseFlag(def({ siteDefault: true }), inputs({ manifestFlags: { demo: true } }));
    expect(state).toMatchObject({ released: true, releasedBy: 'manifest', enabled: true, enabledBy: 'site-default' });
  });

  it('a manifest can withdraw a ga flag (kill switch)', () => {
    const state = resolveReleaseFlag(def({ stage: 'ga' }), inputs({ manifestFlags: { demo: false } }));
    expect(state).toMatchObject({ released: false, releasedBy: 'manifest', enabled: false });
  });

  it('the env override beats the manifest in both directions', () => {
    expect(
      resolveReleaseFlag(def(), inputs({ envOverrides: new Map([['demo', true]]), manifestFlags: { demo: false } })),
    ).toMatchObject({ released: true, releasedBy: 'env' });
    expect(
      resolveReleaseFlag(def(), inputs({ envOverrides: new Map([['demo', false]]), manifestFlags: { demo: true } })),
    ).toMatchObject({ released: false, releasedBy: 'env' });
  });

  it('ignores a non-boolean manifest value', () => {
    const state = resolveReleaseFlag(def(), inputs({ manifestFlags: { demo: 'yes' as unknown as boolean } }));
    expect(state.releasedBy).toBe('stage');
  });
});

describe('resolveReleaseFlag — site choice', () => {
  const released = { manifestFlags: { demo: true } };

  it('uses the site value once released', () => {
    expect(resolveReleaseFlag(def(), inputs({ ...released, siteValues: { demo: true } }))).toMatchObject({
      enabled: true,
      enabledBy: 'site',
      siteValue: true,
    });
    expect(
      resolveReleaseFlag(def({ siteDefault: true }), inputs({ ...released, siteValues: { demo: false } })),
    ).toMatchObject({ enabled: false, enabledBy: 'site' });
  });

  it('falls back to siteDefault when the site never chose or stored garbage', () => {
    expect(resolveReleaseFlag(def({ siteDefault: true }), inputs({ ...released, siteValues: { demo: 'on' } })))
      .toMatchObject({ enabled: true, enabledBy: 'site-default', siteValue: null });
  });

  it('a site cannot enable a flag that is not released', () => {
    expect(resolveReleaseFlag(def(), inputs({ siteValues: { demo: true } }))).toMatchObject({
      released: false,
      enabled: false,
      enabledBy: 'release',
      siteValue: true,
    });
  });

  it('ignores site values for flags without siteToggle', () => {
    expect(resolveReleaseFlag(def({ siteToggle: false }), inputs({ ...released, siteValues: { demo: false } })))
      .toMatchObject({ enabled: true, enabledBy: 'release', siteValue: null });
  });

  // Property: whatever the inputs, a flag is never enabled unless released, and
  // an env override always decides the release gate.
  it('never enables an unreleased flag; env always decides the gate (property)', () => {
    const optBool = fc.option(fc.boolean(), { nil: undefined });
    fc.assert(
      fc.property(
        fc.constantFrom<ReleaseStage>('dark', 'beta', 'ga'),
        fc.boolean(),
        fc.boolean(),
        optBool,
        optBool,
        fc.oneof(fc.boolean(), fc.constant(undefined), fc.string(), fc.integer()),
        (stage, siteToggle, siteDefault, envValue, manifestValue, siteValue) => {
          const state = resolveReleaseFlag(
            def({ stage, siteToggle, siteDefault }),
            inputs({
              envOverrides: envValue === undefined ? new Map() : new Map([['demo', envValue]]),
              manifestFlags: manifestValue === undefined ? null : { demo: manifestValue },
              siteValues: siteValue === undefined ? {} : { demo: siteValue },
            }),
          );
          if (!state.released) expect(state.enabled).toBe(false);
          if (envValue !== undefined) expect(state).toMatchObject({ released: envValue, releasedBy: 'env' });
          if (!siteToggle) expect(state.enabled).toBe(state.released);
        },
      ),
    );
  });
});

describe('parseReleaseFlagOverrides', () => {
  const known = defineReleaseFlags([def({ key: 'alpha' }), def({ key: 'beta.two' })]);

  it('parses on/off pairs separated by commas or whitespace', () => {
    const { overrides, ignored } = parseReleaseFlagOverrides('alpha=on, beta.two=OFF', known);
    expect([...overrides]).toEqual([['alpha', true], ['beta.two', false]]);
    expect(ignored).toEqual([]);
  });

  it.each(['true', '1', 'yes'])('accepts %s as on', (value) => {
    expect(parseReleaseFlagOverrides(`alpha=${value}`, known).overrides.get('alpha')).toBe(true);
  });

  it('reports unknown keys and bad values without applying them', () => {
    const { overrides, ignored } = parseReleaseFlagOverrides('nope=on alpha=maybe alpha beta.two=0', known);
    expect([...overrides]).toEqual([['beta.two', false]]);
    expect(ignored).toEqual(['nope=on', 'alpha=maybe', 'alpha']);
  });

  it('treats an absent or empty value as no overrides', () => {
    expect(parseReleaseFlagOverrides(undefined, known).overrides.size).toBe(0);
    expect(parseReleaseFlagOverrides('  ', known).overrides.size).toBe(0);
  });
});
