---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T06:12:09.760Z
contentHash: 7d9fde0ac4b70d8e
codeVerified: 2026-11-19T06:12:09.760Z
codeVerifiedHash: 7d9fde0ac4b70d8e
codeVerifiedClaims: 12
---

# Personalisation: audiences and content variants

A page or an item can have **variants**: different content for different
**audiences**. On every request the delivery API picks the audience from what
the request carries (country, locale, campaign, a member tier the site
passes in), merges that audience's variant over the published content, and
caches one copy per audience. Visitors who match no audience get the
default content (#762, epic #678).

This is opt-in per site: a site with no audience behaves exactly as before.
There is no Studio editor yet; manage audiences and variants through the
API below.

## Audiences

An audience is a key, a priority and a rule. The first enabled audience whose
rule matches wins; lower `priority` runs first, ties go to the key in
alphabetical order.

```json
{
  "key": "vn-gold",
  "name": "Gold members in Vietnam",
  "priority": 10,
  "rules": {
    "match": "all",
    "conditions": [
      { "attribute": "country", "op": "eq", "value": "VN" },
      { "attribute": "attr.tier", "op": "in", "value": ["gold", "platinum"] }
    ]
  }
}
```

- `match`: `all` (every condition) or `any` (at least one).
- `op`: `eq`, `neq`, `in`, `nin`, `prefix`, `exists`. Comparisons ignore case.
- `key`: 1–40 lowercase letters, digits or dashes. It appears in cache keys,
  in exposure counts and in the `X-Lumi-Variant` response header. `default`
  is reserved.

| Attribute | Comes from | Needs consent |
|---|---|---|
| `country` | the CDN's geo header: `CF-IPCountry` (Cloudflare), `X-Vercel-IP-Country`, `CloudFront-Viewer-Country` | no |
| `locale` | `?locale=` or `?lang=` | no |
| `utm.source`, `utm.medium`, `utm.campaign`, `utm.term`, `utm.content` | `utm_*` query parameters | yes |
| `attr.<name>` | the `X-Lumi-Attrs` header, e.g. `X-Lumi-Attrs: tier=gold; plan=pro` | yes |

The delivery API is public and does not know who the visitor is, so a member
tier (or any other fact about the visitor) is passed by the site's own server
in `X-Lumi-Attrs`, typically from its session when it renders the page. Do
not let browsers set this header for audiences that gate anything sensitive:
an audience changes which content is shown, it is not an access control.

Without a country header (for example a Docker deployment with no CDN in
front), `country` conditions never match.

### Consent

`country` and `locale` are coarse and not tied to a person, so they are always
usable. UTM parameters and custom attributes are personal: they are only read
when the request carries personalisation consent:

```http
X-Lumi-Consent: personalization, analytics
```

The site's consent banner decides what it sends. `DNT: 1` or `Sec-GPC: 1`
withdraws both. Without consent, a condition on a personal attribute is
always false, including `neq` and `nin`, so an audience can never mean
"everyone who did not consent". The visitor falls through to an audience
built only on country or locale, or to the default content. The API reports
`needsConsent: true` on audiences that use personal attributes.

## Variants

A variant belongs to one page or one item and one audience:

- **Page** (`subjectType: "page"`, `subjectId` = the page id): overrides
  `title` and/or `layoutConfig`. A replacement layout can point sections at
  other collections.
- **Item** (`subjectType: "item"`, `subjectId` = the item id): overrides any
  data field, field by field. `id`, `status`, `sort`, `createdAt` and
  `updatedAt` cannot be overridden.

Only `published` variants are delivered; `draft` is the default. There is one
variant per page or item and audience. Overrides are limited to 64 KiB.
Deleting an audience deletes its variants.

## Delivery

`GET /api/v1/deliver/page/:site_id/:slug` resolves the audience first, then
answers. When the site has audiences:

- The page variant replaces the title or layout, and item variants are merged
  over the items of every section.
- The payload gains `personalisation: { audience, variants }`: the audience
  key (`null` for the default content) and the variant ids applied.
- `X-Lumi-Variant` carries the audience key, or `_` for the default content.
- `Vary` adds the headers the audience can depend on (`CF-IPCountry`,
  `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`, `X-Lumi-Attrs`,
  `X-Lumi-Consent`, `DNT`, `Sec-GPC`), so a shared cache in front of the API
  does not mix audiences.

### Caching

Every cache tier is keyed by the **resolved audience**, never by the raw
attributes. A site with three audiences has at most four cached copies of a
page, however many countries, tiers or campaigns its visitors bring.

- The edge copy's key gets a synthetic `__aud=<key>` parameter.
- The application cache key and the `ETag` include the audience, and the
  `ETag` also covers the site's variants. A `304` for one audience never
  answers another.
- Every change to an audience or a variant drops the cached audience list
  (60-second cache) and purges the site's delivery caches, so it is live on
  the next request.

See [Caching](./caching.md) for the tiers themselves.

## Exposure

**In the CMS.** Each delivered page counts one exposure per day, page slug and
audience key (`_` for the default content). It is only counted when the
request carries analytics consent (`X-Lumi-Consent: analytics`, and no
`DNT` / `Sec-GPC`). Nothing about the visitor is stored. It is counted on
every delivery, including edge-cache hits. Sites without audiences record
nothing.

```http
GET /api/v1/personalisation/exposures?from=2026-11-01&to=2026-11-30
```

**In GA4.** `@lumibase/analytics-consent` sends one `lumi_variant_exposure`
event with the same rule as the tag itself (nothing without a grant):

```ts
import { readConsent, trackVariantExposure, variantFromHeaders } from '@lumibase/analytics-consent';

const res = await fetch(`${cms}/api/v1/deliver/page/${siteId}/home`, { headers });
const page = await res.json();
trackVariantExposure(window.gtag, readConsent(localStorage), {
  subject: 'home',
  audience: page.personalisation?.audience ?? variantFromHeaders(res.headers),
  variants: page.personalisation?.variants,
});
```

The event carries `lumi_subject`, `lumi_audience` (`default` for the default
content) and `lumi_variants`.

## API

Site admins only, under `/api/v1/personalisation`:

| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/audiences` | list / create (`409 AUDIENCE_EXISTS` on a duplicate key) |
| `PATCH` / `DELETE` | `/audiences/:id` | update / delete (its variants go with it) |
| `GET` | `/variants?subjectType=&subjectId=&audienceId=` | list |
| `POST` | `/variants` | `{ subjectType, subjectId, audienceId, overrides, status? }`; `404 SUBJECT_NOT_FOUND` / `AUDIENCE_NOT_FOUND`, `409 VARIANT_EXISTS`, `413 OVERRIDES_TOO_LARGE` |
| `PATCH` / `DELETE` | `/variants/:id` | `{ overrides?, status? }` / delete |
| `GET` | `/exposures?from=&to=&subjectType=&subjectId=` | daily counts and `meta.totals` per audience; at most 366 days |

## Multi-tenancy

`lumibase_audiences`, `lumibase_content_variants` and
`lumibase_variant_exposures` carry `site_id` and are in the RLS
`site_isolation` list. Every query is scoped to the site; delivery takes the
site from the URL and uses the site-scoped database handle, like the rest of
`/deliver`. The cached audience list is keyed per site.

## Not done yet

- A Studio editor for audiences and variants.
- Preview delivery (`/api/v1/deliver/preview`) always shows the default
  content; previewing a variant needs the Studio editor.
- A/B tests with random assignment and insights (#763) build on these tables.
