import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalActionToolDefinition } from '@lumibase/contracts/platform';
import { CORE_SKILLS, skillCatalog } from '../../services/ai-harness';
import { ExternalActionToolRegistry, externalActionTools } from '../../services/external-action-tools';
import { defaultExternalActionToolSource } from '../defaults';
import {
  isPlatformSeamRegistered,
  loadExternalActionTools,
  platform,
  registerPlatformSeams,
  resetPlatformSeamsForTests,
} from '../registry';

/**
 * The `externalActions` seam: a package outside the CMS hands its tool
 * definitions to a deployment entry, which registers them through
 * `registerPlatformSeams()`. The CMS never imports such a package.
 */

function tool(name: string, overrides: Partial<ExternalActionToolDefinition> = {}): ExternalActionToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    capability: 'fixture:act',
    risk: 'low',
    reversibility: 'reversible',
    blastRadius: { scope: 'single' },
    secrets: [],
    inputSchema: { type: 'object', properties: {} },
    policy: { constitution: 'required' },
    handler: async () => {
      throw new Error('fixture handler must not run in this suite');
    },
    ...overrides,
  };
}

afterEach(() => resetPlatformSeamsForTests());

describe('externalActions seam — nothing registered', () => {
  it('defaults to a source with no tools', () => {
    expect(isPlatformSeamRegistered('externalActions')).toBe(false);
    expect(platform().externalActions).toBe(defaultExternalActionToolSource);
    expect(platform().externalActions.tools()).toEqual([]);
  });

  it('leaves the process-wide registry empty and the catalog equal to the core skills', () => {
    registerPlatformSeams({});
    expect(externalActionTools.size).toBe(0);
    // Same object, not merely equal: the no-tools path does not even copy it.
    expect(skillCatalog()).toBe(CORE_SKILLS);
  });
});

describe('externalActions seam — registration', () => {
  it('loads every tool into the process-wide registry at registration time', () => {
    registerPlatformSeams({ externalActions: { tools: () => [tool('fixtureLabel'), tool('fixtureNotify')] } });
    expect(isPlatformSeamRegistered('externalActions')).toBe(true);
    expect(externalActionTools.list().map((entry) => entry.name)).toEqual(['fixtureLabel', 'fixtureNotify']);
    expect(Object.keys(skillCatalog())).toEqual(expect.arrayContaining(['fixtureLabel', 'fixtureNotify']));
    // The declared policy travels with the definition.
    expect(externalActionTools.get('fixtureLabel')?.policy).toEqual({ constitution: 'required' });
  });

  it('refuses the whole registration, and loads nothing, when one definition is invalid', () => {
    const bad = tool('fixtureBad', { policy: { constitution: 'sometimes' as never } });
    expect(() =>
      registerPlatformSeams({ externalActions: { tools: () => [tool('fixtureGood'), bad] } }),
    ).toThrow(/policy.constitution/);
    expect(externalActionTools.size).toBe(0);
    // The failed registration did not count: a corrected one is accepted.
    registerPlatformSeams({ externalActions: { tools: () => [tool('fixtureGood')] } });
    expect(externalActionTools.size).toBe(1);
  });

  it('refuses duplicate names within one source', () => {
    expect(() =>
      registerPlatformSeams({ externalActions: { tools: () => [tool('fixtureSame'), tool('fixtureSame')] } }),
    ).toThrow(/already registered/);
    expect(externalActionTools.size).toBe(0);
  });

  it('refuses a source that does not return an array', () => {
    expect(() => registerPlatformSeams({ externalActions: { tools: () => null as never } })).toThrow(/array/);
  });

  it('the test reset unregisters what the registration loaded', () => {
    registerPlatformSeams({ externalActions: { tools: () => [tool('fixtureLabel')] } });
    resetPlatformSeamsForTests();
    expect(externalActionTools.size).toBe(0);
  });

  it('a tool that shadows a core skill is listed under the core skill, never the tool', () => {
    registerPlatformSeams({ externalActions: { tools: () => [tool('deleteCollection')] } });
    expect(skillCatalog()['deleteCollection']).toBe(CORE_SKILLS['deleteCollection']);
  });
});

describe('policy validation', () => {
  const load = (definition: ExternalActionToolDefinition) =>
    loadExternalActionTools({ tools: () => [definition] }, new ExternalActionToolRegistry());

  it('accepts both modes, a hash list and a record builder', () => {
    expect(load(tool('fixtureA', { policy: { constitution: 'if_active' } }))).toEqual(['fixtureA']);
    expect(
      load(
        tool('fixtureB', {
          policy: {
            constitution: 'required',
            constitutionHashes: [`sha256:${'a'.repeat(64)}`],
            record: (args) => ({ ...args }),
          },
        }),
      ),
    ).toEqual(['fixtureB']);
    expect(load(tool('fixtureC', { policy: undefined }))).toEqual(['fixtureC']);
  });

  it('refuses malformed hashes, an empty hash list and a non-function record', () => {
    expect(() =>
      load(tool('fixtureD', { policy: { constitution: 'required', constitutionHashes: ['md5:abc'] } })),
    ).toThrow(/constitutionHashes/);
    expect(() => load(tool('fixtureE', { policy: { constitution: 'required', constitutionHashes: [] } }))).toThrow(
      /constitutionHashes/,
    );
    expect(() =>
      load(tool('fixtureF', { policy: { constitution: 'required', record: 'args' as never } })),
    ).toThrow(/policy.record/);
  });
});
