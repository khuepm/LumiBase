import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CONFIG_MANIFEST_VERSION, parseConfigManifest } from '@lumibase/shared/schemas';
import {
  canonicalize,
  serializeConfig,
  type ConfigState,
} from '../config-serialize';

/**
 * Feature: code-first-config
 *   Req 1.5 — deterministic, byte-identical output for diff-friendly git.
 *   Req 6.1 — round-trip: export then parse yields a valid, equal manifest.
 *   Req 6.2 — serializeConfig is pure (no DB) so this runs without a database.
 *
 * **Validates: Requirements 1.2, 1.3, 1.5, 6.1, 6.2**
 */

// A well-behaved JSON generator: strings, safe integers, booleans, null, and
// shallow records/arrays thereof. We deliberately avoid fc.jsonValue()'s
// floating-point edge cases (`-0`, sub-ULP precision) — round-tripping IEEE-754
// noise through JSON.stringify is not what this property is testing, and it
// makes the generator flaky. Structural fidelity is the invariant of interest.
const safeJsonScalar = fc.oneof(
  fc.string(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);
const safeJson = fc.oneof(
  safeJsonScalar,
  fc.array(safeJsonScalar, { maxLength: 4 }),
  fc.dictionary(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,8}$/), safeJsonScalar, { maxKeys: 4 }),
);

const collectionArb = fc.record(
  {
    name: fc.stringMatching(/^[a-z][a-z0-9_]{1,12}$/),
    label: fc.option(fc.string(), { nil: undefined }),
    hidden: fc.option(fc.boolean(), { nil: undefined }),
    versioning: fc.option(fc.boolean(), { nil: undefined }),
    accountability: fc.option(fc.constantFrom('all', 'activity', 'none'), { nil: undefined }),
    meta: fc.option(fc.dictionary(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,8}$/), safeJson, { maxKeys: 4 }), { nil: undefined }),
  },
  { requiredKeys: ['name'] },
);

const settingArb = fc.record({
  key: fc.stringMatching(/^[a-z][a-z0-9_]{1,16}$/),
  value: safeJson,
  scope: fc.constantFrom('site', 'module'),
});

// Distinct names so stable keys don't collide (the DB enforces uniqueness too).
function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const stateArb: fc.Arbitrary<ConfigState> = fc
  .record({
    collections: fc.array(collectionArb, { maxLength: 6 }),
    settings: fc.array(settingArb, { maxLength: 6 }),
  })
  .map((s) => ({
    collections: uniqueBy(s.collections, (c) => c.name),
    fields: [],
    relations: [],
    webhooks: [],
    settings: uniqueBy(s.settings, (x) => x.key),
  }));

describe('serializeConfig', () => {
  it('round-trips: a serialized manifest parses back to an equal value (Req 6.1)', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const manifest = serializeConfig(state);
        const parsed = parseConfigManifest(manifest);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          // Re-serializing the parsed manifest is a no-op (idempotent).
          expect(canonicalize(parsed.manifest)).toEqual(manifest);
        }
      }),
    );
  });

  it('is deterministic: equal state → byte-identical JSON (Req 1.5)', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const a = JSON.stringify(serializeConfig(state));
        const b = JSON.stringify(serializeConfig(state));
        expect(a).toBe(b);
      }),
    );
  });

  it('is order-independent: shuffling input rows yields identical output (Req 1.5)', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const shuffled: ConfigState = {
          ...state,
          collections: [...state.collections].reverse(),
          settings: [...state.settings].reverse(),
        };
        expect(JSON.stringify(serializeConfig(state))).toBe(
          JSON.stringify(serializeConfig(shuffled)),
        );
      }),
    );
  });

  it('stamps the manifest version and never leaks id/siteId/timestamps (Req 1.2, 1.3)', () => {
    const state: ConfigState = {
      collections: [
        {
          name: 'articles',
          label: 'Articles',
          versioning: true,
          // Fields a DB row would carry but a manifest must drop:
          ...({ id: 'nano_xxx', siteId: 'site_1', createdAt: new Date(), updatedAt: new Date() } as Record<string, unknown>),
        } as ConfigState['collections'][number],
      ],
      fields: [],
      relations: [],
      webhooks: [],
      settings: [],
    };
    const manifest = serializeConfig(state);
    expect(manifest.version).toBe(CONFIG_MANIFEST_VERSION);
    const json = JSON.stringify(manifest);
    expect(json).not.toContain('nano_xxx');
    expect(json).not.toContain('site_1');
    expect(json).not.toContain('createdAt');
    expect(json).not.toContain('siteId');
  });

  it('respects scope filtering (Req 1.6)', () => {
    const state: ConfigState = {
      collections: [{ name: 'articles' }],
      fields: [],
      relations: [],
      webhooks: [{ name: 'wh', url: 'https://e.x', actions: [], collections: [], headers: {}, status: 'active' }],
      settings: [{ key: 'k', value: 1, scope: 'site' }],
    };
    const settingsOnly = serializeConfig(state, { scope: 'settings' });
    expect(settingsOnly.collections).toHaveLength(0);
    expect(settingsOnly.webhooks).toHaveLength(0);
    expect(settingsOnly.settings).toHaveLength(1);
  });
});

describe('canonicalize', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const input = { b: 1, a: { d: 2, c: 3 }, list: [{ z: 1, y: 2 }] };
    expect(JSON.stringify(canonicalize(input))).toBe(
      JSON.stringify({ a: { c: 3, d: 2 }, b: 1, list: [{ y: 2, z: 1 }] }),
    );
  });
});
