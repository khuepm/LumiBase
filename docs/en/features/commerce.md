---
sourceLang: en
version: 3
lastUpdated: 2026-11-19T09:11:24.583Z
contentHash: 078cb60d3e1d3edd
codeVerified: 2026-11-19T09:11:24.583Z
codeVerifiedHash: 078cb60d3e1d3edd
codeVerifiedClaims: 12
---

# Commerce content: Medusa and Shopify

LumiBase can mirror a store's catalogue so pages show products, prices and
promotions next to editorial content (#764, epic #678). The store stays the
source of truth: LumiBase has no cart and no checkout. Products sync into an
ordinary collection, so delivery, search, CDC, caching and the block editor
work on them like on any other content.

Two adapters ship, behind one port (`apps/cms/src/modules/commerce/`):

| Provider | API | Webhook signature |
|---|---|---|
| Medusa v2 | Admin REST, secret API key | `X-Lumi-Signature: sha256=<hex HMAC>` |
| Shopify | Admin GraphQL `2025-01`, app access token | `X-Shopify-Hmac-Sha256` (base64 HMAC) |

## 1. Connect a store

```http
PUT /api/v1/integrations/commerce/medusa
{ "apiUrl": "https://shop-api.example.com", "apiKey": "sk_…", "webhookSecret": "…" }

PUT /api/v1/integrations/commerce/shopify
{ "shopDomain": "acme.myshopify.com", "accessToken": "shpat_…", "webhookSecret": "<app client secret>" }
```

Site admins only. Before saving, LumiBase reads the first page of products, so
wrong credentials answer `422 COMMERCE_CREDENTIALS_REJECTED`. Add `?verify=false`
to skip the check.

The whole config is stored as one encrypted site tool secret
(`COMMERCE_MEDUSA` / `COMMERCE_SHOPIFY`) and is never returned.
`GET /api/v1/integrations/commerce` lists each provider with `connected`, the
non-secret part (`apiUrl` or `shopDomain`) and the `webhookUrl` to register.
`DELETE /api/v1/integrations/commerce/:provider` disconnects.

Outbound calls are guarded:

- A Medusa `apiUrl` that is private, loopback or a metadata address, directly
  or after DNS resolution, is refused with `502 COMMERCE_UNREACHABLE`.
- Shopify calls only ever go to `<store>.myshopify.com`.

Connecting also creates the collections below, once.

## 2. What is synced

| Collection | Content |
|---|---|
| `commerce_products` | `title`, `handle`, `description`, `thumbnail`, `variants`, `price_from`, `currency`, `provider`, `external_id`, `synced_at` |
| `commerce_promotions` | `title`, `code`, `kind` (`percentage`/`fixed`), `value`, `currency`, `starts_at`, `ends_at`, `provider`, `external_id`, `synced_at` |

A row is keyed by `(provider, external_id)`. A product that is published
upstream (Medusa `published`, Shopify `ACTIVE`) is a `published` item; anything
else is a `draft`, so delivery hides it. A promotion is published while it is
active.

`variants` holds each variant's `prices`: `{ currency, amount, minQuantity,
maxQuantity, compareAt? }`, with amounts in major units.

- **Medusa:** a price with a quantity range is a **tier**. Customer-group
  price-list prices are not synced.
- **Shopify:** quantity breaks exist only on B2B catalogs, so each variant has
  a single price, plus `compareAt` when it is on sale.

`price_from` is the lowest price, tiers included.

Every write goes through the item service, so revisions, webhooks, search
indexing and delivery-cache invalidation follow as for an editor's change. A
full sync runs with the calling admin's own permissions. A webhook has no
principal, so it writes as the system: the CDC actor is
`system`/`commerce:<provider>` and the reason is `commerce-sync`. A sync owns its
rows: an edit made in Studio is overwritten by the next sync.

## 3. Keeping it fresh

**Webhooks** make a store change appear in seconds. Register the
`webhookUrl` (`POST /api/v1/commerce-webhooks/:site_id/:provider`):

- **Shopify:** subscribe to `products/create`, `products/update` and
  `products/delete`.
- **Medusa:** has no outbound webhooks. Add a subscriber in the Medusa app that
  posts `{ "event": "product.updated", "data": { "id": "prod_…" } }` (also
  `product.created`, `product.deleted`, `promotion.*`) with
  `X-Lumi-Signature: sha256=` + the hex HMAC-SHA256 of the raw body under the
  webhook secret.

The webhook is unauthenticated, rate-limited, and verified by signature:

- a missing or wrong signature answers `401`;
- an unknown site, or a provider that is not connected, answers `404`.

The body only names what changed. LumiBase then fetches the product from the
provider, so a webhook body can never write content. An event it does not
handle is acknowledged with `200` so the provider does not retry.

**Full sync**: `POST /api/v1/integrations/commerce/:provider/sync` walks every
product page and every promotion, then removes the synced rows the provider no
longer has. It returns `{ products, promotions, truncated }`. Run it after
connecting, and whenever webhooks may have been missed.

## 4. Blocks and price tiers

Connecting creates two hidden block templates for dynamic zones:

- `block_product_card`: `product_handle`, `show_tiers`, `currency`,
  `cta_label`, `cta_url`;
- `block_promotion`: `promotion_code`, `headline`, `body`, `cta_label`,
  `cta_url`.

Add them to a `blocks` field's `allowedBlocks`. A frontend resolves the handle
or code through the delivery items API and renders prices with the helpers in
`@lumibase/sdk`:

```ts
import { formatPriceTiers, unitPrice } from '@lumibase/sdk';

formatPriceTiers(product.variants[0], 'EUR', 'de');
// ['1–9: 120,00 €', '10+: 99,50 €']
unitPrice(product.variants[0], 'EUR', 12); // 99.5
```

`priceTiers()` sorts the tiers and closes open ranges, so quantity ranges
never overlap.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/integrations/commerce` | providers, connection state, webhook URLs |
| `PUT` | `/api/v1/integrations/commerce/:provider` | connect (`medusa` / `shopify`) |
| `DELETE` | `/api/v1/integrations/commerce/:provider` | disconnect |
| `POST` | `/api/v1/integrations/commerce/:provider/sync` | full sync |
| `POST` | `/api/v1/commerce-webhooks/:site_id/:provider` | provider webhook (public, signed) |

Errors:

- `400 VALIDATION` and `COMMERCE_CONFIG_INVALID`;
- `404 COMMERCE_NOT_CONFIGURED`;
- `422 COMMERCE_CREDENTIALS_REJECTED`;
- `429 COMMERCE_RATE_LIMITED`;
- `502 COMMERCE_UNAVAILABLE` and `COMMERCE_UNREACHABLE`.

## Multi-tenancy

There is no new table:

- Credentials are per-site encrypted tool secrets, with additional
  authenticated data bound to the site and the name.
- Synced rows are ordinary items of the site.
- The webhook takes the site from its URL, reads only that site's config, and
  verifies the signature with that site's secret.

## Not done yet

- A Studio screen to connect a store (API only for now).
- A periodic background sync. Webhooks plus the manual full sync cover it
  today.
- Shopify B2B quantity price breaks, other providers, and product variants as
  their own collection.
