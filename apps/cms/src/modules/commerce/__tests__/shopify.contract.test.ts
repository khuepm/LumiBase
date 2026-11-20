import { describe, expect, it } from 'vitest';
import { SHOPIFY_API_VERSION, SHOPIFY_CONTRACT, SHOPIFY_QUERIES, ShopifyAdapter } from '../shopify';
import { SHOPIFY_SCHEMA_EVIDENCE } from './shopify-schema-evidence';

/**
 * Live Shopify contract (#764 review). Opt-in: runs only with a development
 * store and an Admin API token that has `read_products` and `read_discounts`:
 *
 *   SHOPIFY_CONTRACT_SHOP=<store>.myshopify.com SHOPIFY_CONTRACT_TOKEN=shpat_… \
 *     pnpm -F @lumibase/cms test:shopify-contract
 *
 * It proves against the real API, at the pinned version, that:
 * - the store answers with `X-Shopify-API-Version: <pin>` (not a fall-forward);
 * - every field in SHOPIFY_CONTRACT exists and is not deprecated (introspection);
 * - the discount value union still has the members the adapter reads;
 * - every adapter query runs without GraphQL errors and maps (products, a single
 *   product, cursor pagination, discounts).
 * The scheduled `commerce-contract` workflow runs it with repository secrets.
 */

const SHOP = process.env.SHOPIFY_CONTRACT_SHOP ?? '';
const TOKEN = process.env.SHOPIFY_CONTRACT_TOKEN ?? '';
const endpoint = `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  return { res, body };
}

describe.skipIf(!SHOP || !TOKEN)(`Shopify Admin GraphQL ${SHOPIFY_API_VERSION} live contract`, () => {
  it('serves the pinned version, not a fall-forward', async () => {
    const { res, body } = await gql(SHOPIFY_QUERIES.shop);
    expect(res.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(res.headers.get('x-shopify-api-version')).toBe(SHOPIFY_API_VERSION);
  });

  it('every contracted field exists and is not deprecated (introspection)', async () => {
    const problems: string[] = [];
    for (const [type, fields] of Object.entries(SHOPIFY_CONTRACT)) {
      const { body } = await gql('query($n: String!) { __type(name: $n) { kind fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }', { n: type });
      const t = (body.data as { __type: { kind: string; fields: Array<{ name: string; isDeprecated: boolean; deprecationReason: string | null }> | null } | null }).__type;
      if (!t) {
        problems.push(`${type}: type missing`);
        continue;
      }
      for (const f of fields) {
        const live = t.fields?.find((x) => x.name === f);
        if (!live) problems.push(`${type}.${f}: missing`);
        else if (live.isDeprecated) problems.push(`${type}.${f}: deprecated (${live.deprecationReason ?? 'no reason'})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the discount value union still includes the members the adapter reads', async () => {
    const { body } = await gql('{ __type(name: "DiscountCustomerGetsValue") { possibleTypes { name } } }');
    const names = ((body.data as { __type: { possibleTypes: Array<{ name: string }> } }).__type.possibleTypes ?? []).map((t) => t.name);
    for (const n of SHOPIFY_SCHEMA_EVIDENCE.unions.DiscountCustomerGetsValue.filter((x) => x !== 'DiscountOnQuantity')) expect(names).toContain(n);
  });

  it('runs every adapter query against the store (products, pagination, product, discounts)', async () => {
    const adapter = new ShopifyAdapter({ shopDomain: SHOP, accessToken: TOKEN, webhookSecret: 'unused-in-contract' }, (url, init) => fetch(url, init));
    const page = await adapter.listProducts(null);
    expect(Array.isArray(page.products)).toBe(true);
    if (page.next) expect((await adapter.listProducts(page.next)).products).toBeInstanceOf(Array);
    if (page.products[0]) {
      const one = await adapter.getProduct(page.products[0].externalId);
      expect(one?.externalId).toBe(page.products[0].externalId);
      for (const v of one!.variants) for (const p of v.prices) expect(Number.isFinite(p.amount)).toBe(true);
    }
    const promos = await adapter.listPromotions();
    for (const p of promos) if (p.kind === 'percentage') expect(p.value).toBeLessThanOrEqual(100);
  });
});
