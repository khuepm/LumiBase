import { describe, expect, it } from 'vitest';
import { SHOPIFY_API_VERSION, SHOPIFY_API_VERSION_SUPPORTED_UNTIL, SHOPIFY_CONTRACT, SHOPIFY_QUERIES } from '../shopify';
import { SHOPIFY_SCHEMA_EVIDENCE } from './shopify-schema-evidence';

/** Renew the pin this long before Shopify stops serving it. */
const RENEW_BEFORE_DAYS = 90;

describe('Shopify API version pin (#764 review)', () => {
  it('pins a supported stable version and its end-of-support matches the captured versioning table', () => {
    expect(SHOPIFY_API_VERSION).toMatch(/^\d{4}-(01|04|07|10)$/);
    expect(SHOPIFY_SCHEMA_EVIDENCE.version).toBe(SHOPIFY_API_VERSION);
    expect(SHOPIFY_SCHEMA_EVIDENCE.versioning.supported).toContain(SHOPIFY_API_VERSION);
    expect(SHOPIFY_SCHEMA_EVIDENCE.versioning.supportedUntil[SHOPIFY_API_VERSION as '2026-10']).toBe(SHOPIFY_API_VERSION_SUPPORTED_UNTIL);
  });

  it(`fails ${RENEW_BEFORE_DAYS} days before the pinned version leaves Shopify's support window`, () => {
    const renewBy = new Date(Date.parse(SHOPIFY_API_VERSION_SUPPORTED_UNTIL) - RENEW_BEFORE_DAYS * 86_400_000);
    expect(
      Date.now() < renewBy.getTime(),
      `Shopify ${SHOPIFY_API_VERSION} is supported until ${SHOPIFY_API_VERSION_SUPPORTED_UNTIL}: pin a newer stable version, re-capture shopify-schema-evidence.ts and run the live contract test.`,
    ).toBe(true);
  });
});

describe('Shopify field contract vs the captured 2026-10 schema', () => {
  it('every selected field is documented for the pinned version and none is deprecated', () => {
    const types = SHOPIFY_SCHEMA_EVIDENCE.types as Record<string, { fields: Record<string, string>; deprecated?: readonly string[] }>;
    for (const [type, fields] of Object.entries(SHOPIFY_CONTRACT)) {
      const evidence = types[type];
      expect(evidence, `no captured schema for ${type}`).toBeDefined();
      for (const f of fields) {
        expect(Object.keys(evidence!.fields), `${type}.${f} not in the captured schema`).toContain(f);
        expect(evidence!.deprecated ?? [], `${type}.${f} is deprecated`).not.toContain(f);
      }
    }
  });

  it('the adapter queries select only contracted fields (featuredImage is gone)', () => {
    const words = new Set(Object.values(SHOPIFY_QUERIES).join(' ').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    // GraphQL syntax, variables and fragment type conditions, not fields.
    const syntax = new Set(['query', 'on', 'first', 'after', 'id', 'ID', 'String', '__typename', 'DiscountCodeBasic', 'DiscountAutomaticBasic', 'DiscountPercentage', 'DiscountAmount']);
    const fields = new Set<string>(Object.values(SHOPIFY_CONTRACT).flat());
    expect([...words].filter((w) => !syntax.has(w) && !fields.has(w))).toEqual([]);
    expect(words.has('featuredImage')).toBe(false);
  });
});
