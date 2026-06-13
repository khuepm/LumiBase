import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AgentArtifactService, stableHash, stableStringify } from '../agent-artifact-service';
import { maskSecrets } from '../agent-run-service';

const secretKeyArb = fc.constantFrom(
  'secret',
  'apiKey',
  'api_key',
  'accessToken',
  'password',
  'authorization',
  'credential',
);

const safeKeyArb = fc.stringMatching(/^(name|title|prompt|safe|description|field|collection|value)$/);

const jsonPrimitiveArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    jsonPrimitiveArb,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(safeKeyArb, tie('value'), { maxKeys: 4 }),
  ),
})).value;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function insertSecretLeaf(base: unknown, key: string, value: unknown): Record<string, unknown> {
  return {
    payload: base,
    nested: {
      [key]: value,
      safe: 'visible',
    },
  };
}

describe('agent harness service boundary properties', () => {
  it('masks every generated secret-like key without changing safe siblings', () => {
    fc.assert(
      fc.property(jsonValueArb, secretKeyArb, jsonPrimitiveArb, (payload, secretKey, secretValue) => {
        const masked = maskSecrets(insertSecretLeaf(payload, secretKey, secretValue)) as {
          nested: Record<string, unknown>;
        };

        expect(masked.nested[secretKey]).toBe('[masked]');
        expect(masked.nested.safe).toBe('visible');
      }),
      { numRuns: 100 },
    );
  });

  it('stable stringify and hash are invariant to object key insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKeyArb, jsonValueArb, { minKeys: 1, maxKeys: 6 }),
        (record) => {
          const reversed = Object.fromEntries(Object.entries(record).reverse());
          const canonicalRecord = canonical(record);

          expect(stableStringify(record)).toBe(stableStringify(reversed));
          expect(stableStringify(record)).toBe(stableStringify(canonicalRecord));
          expect(stableHash(record)).toBe(stableHash(reversed));
          expect(stableHash(record)).toBe(stableHash(canonicalRecord));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects every generated artifact payload above the configured size guard before database access', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 513 * 1024, max: 560 * 1024 }), async (size) => {
        const service = new AgentArtifactService({} as never, 'site_1');

        await expect(service.createArtifact({
          runId: 'run_1',
          type: 'page_spec',
          title: 'Too large',
          content: { body: 'x'.repeat(size) },
        })).rejects.toThrow(/exceeds 524288 bytes/);
      }),
      { numRuns: 25 },
    );
  });
});
