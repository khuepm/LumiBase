---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:05:03.371Z
contentHash: 3565f2c1a877a259
codeVerified: 2026-11-14T02:05:03.371Z
codeVerifiedHash: 3565f2c1a877a259
codeVerifiedClaims: 12
---

# Filter sanitisation audit (hidden-field oracles)

Issue #738 (epic #674, S09). This page records how LumiBase stops a caller from
learning the value of a field it cannot read by using a filter, sort, relation
expansion, search expression or count. Each vector lists its status and the test
that proves it.

## Threat model

A caller holds `read` on a collection, but the policy's field whitelist hides some
fields: `fields: ['title']`, `fields: ['*', '-salary']`, or the public role with a
narrow field list. The read path already strips hidden fields from the response
(`PermissionService.maskItem`). But filters, sorts and search expressions are
evaluated by the database or the search engine against the stored row. So
without a guard, the caller could still ask questions about hidden values:

- **Boolean oracle.** `?filter[salary][_gt]=100000` returns the row or not, and
  `meta.total` counts it. With `_starts_with`, the caller can recover a value one
  character at a time.
- **Ordering oracle.** `?sort=salary` puts rows in the order of the hidden value.
- **Presence oracle.** `?filter[secret][_null]=true` shows whether a value is set.
- **Wildcards.** `_contains: '%'` matches every row, and `_` matches any single
  character. They speed up the probing, and they also widen a permission rule
  whose value comes from the caller (for example a `$CURRENT_USER.email`
  containing `%`).
- **Relational.** Grouping children by a foreign key the caller cannot read shows
  which parent each child belongs to.
- **Search.** The engine matches `q` against `_title`. `_title` is a copy of an
  item field, and that field may be hidden. The engine total also counts rows
  the caller cannot see.

## The guard

`apps/cms/src/services/filter-guard.ts` decides **before any query runs**. Every
field that a filter (walked through `_and` / `_or`, top-level segment of a dotted
JSON path) or a sort token names must be readable under the caller's `read`
permission. Structural columns (`id`, `status`, `sort`, timestamps, `user_*`) are
never masked, so they are always allowed. The decision uses only the permission
and the query, never the data, so the refusal itself cannot leak anything:

- Same response for every dataset: HTTP **403**, code `FIELD_FORBIDDEN`. The
  message names the field the caller sent.
- No database round-trip, so nothing about the data can show up in timing.
- A field that does not exist is refused exactly like a hidden one, so a
  restricted caller cannot use the refusal to probe the schema.
- A caller with `fields: ['*']` (or no permission context: internal and admin
  paths) is not restricted.

`ItemService.list` runs the guard. REST `GET /items/:collection`, the export
endpoint, GraphQL list queries, MCP / AI item reads and extension data access all
go through it. The search route applies the same rule to Meili `filter` / `sort`
strings.

## Vectors

| # | Vector | Status | Test |
|---|---|---|---|
| 1 | `_eq` / `_neq` / `_in` / `_gt`… on a hidden field | Fixed: `FIELD_FORBIDDEN` before any query | `filter-sanitisation.property.test.ts` (oracle property) |
| 2 | `_contains` / `_starts_with` / `_ends_with` on a hidden field | Fixed (same guard) | same, regression list |
| 3 | `_null` / `_nnull` on a hidden field (presence) | Fixed (same guard) | same |
| 4 | Hidden clause nested in `_or` / `_and` | Fixed: the guard walks the same tree as the SQL builder; nesting is capped at 16 levels (`INVALID_FILTER`) | same, `MAX_FILTER_DEPTH` |
| 5 | JSON path into a hidden field (`secret.x`) | Fixed: checked on the top-level segment; `author.name` is allowed when `author` is readable | same |
| 6 | `_json_contains` / `_has_key` on a hidden field | Fixed (same guard) | same |
| 7 | `sort=secret` (ordering oracle) | Fixed (same guard) | same |
| 8 | Telling "hidden" apart from "does not exist" | Not possible: both are refused the same way | pure guard test |
| 9 | `%` / `_` / `\` in `_contains`-family item filters | Fixed: escaped, matched literally | LIKE-semantics property |
| 10 | Wildcards in permission rules (magic values such as `$CURRENT_USER.email`) | Fixed: SQL now agrees with the in-memory evaluator | SQL ↔ `evaluate` parity property |
| 11 | SCIM `filter` substring match on e-mail | Fixed: escaped (admin-only surface) | n/a (one-line change) |
| 12 | SQL injection through field names, JSON paths, operators, values, sort | Already safe: segments allow-listed `^[A-Za-z0-9_]+$`, values and keys bound as parameters, unknown operators rejected | injection property (no marker ever reaches SQL text) |
| 13 | Relational filter `author.secret_field` | Not a join: a dotted key is a JSON path within the same row and never reaches another collection | guard + #5 |
| 14 | o2m expansion (`fields=comments.*`) when the child FK is hidden | Fixed: expands to `[]` without loading children | `o2m expansion yields nothing…` |
| 15 | m2m expansion through a junction the caller cannot read | Fixed: needs junction `read`, its row rule, and both link fields readable; otherwise `[]` | `m2m expansion yields nothing…` |
| 16 | m2o expansion | Already safe: reads the FK from the masked row | existing relation tests |
| 17 | GraphQL `filter` / `sort` arguments | Fixed: same `ItemService.list` path | covered by #1–#7 |
| 18 | GraphQL o2m field when the FK is hidden | Fixed: resolves to `[]` for every parent, no error | `schema-builder.test.ts` |
| 19 | Keyset cursor encoding a hidden sort value | N/A: items use offset paging. Export pages by keyset on `id` (structural), and the audit-log cursor (admin-only) encodes `(timestamp, id)` | — |
| 20 | `meta.total` count oracle | Safe: counts with the same WHERE (row rule included); a hidden-field filter never runs | oracle property |
| 21 | Aggregate / groupBy | N/A: there is no aggregate endpoint on items | — |
| 22 | Search `q` matching a `_title` copied from a hidden field | Fixed: a hit whose stored `_title` differs from the title derived from readable fields is dropped | `search-hidden-fields.test.ts` |
| 23 | Search `totalHits` counting rows the caller cannot see | Fixed: restricted callers get the number of visible hits | same |
| 24 | Search `filter` / `sort` on a hidden attribute (or `_title`) | Fixed: `FIELD_FORBIDDEN` before the engine is called. Unquoted values count as attributes, so quote values | same + attribute property |
| 25 | Search mask with `['*', '-x']` stripped every field | Fixed (correctness): exclusions now applied properly | same |
| 26 | `/deliver` page sections | N/A: no caller-supplied filter or sort; `orderBy` and `status` come from the admin-authored page layout | — |
| 27 | Timing of the refusal | Safe: decided before any I/O | oracle property (zero selects) |

Tests live in `apps/cms/src/services/__tests__/filter-sanitisation.property.test.ts`,
`apps/cms/src/routes/__tests__/search-hidden-fields.test.ts` and
`apps/cms/src/graphql/__tests__/schema-builder.test.ts`.

## Residual risk

- **Search title derivation (1 bit).** `_title` comes from the first non-blank
  of `title` / `name` / `label` / `heading` / `slug`, otherwise the first string
  field. If one of those fields is hidden, whether a hit is dropped depends on
  whether that hidden field is blank. The hidden *content* never leaks, but
  "blank or not" does. Closing this fully needs index-side work: a configured
  display field, per-field searchable attributes and a role-scoped
  `attributesToSearchOn`. This is tracked in the out-of-scope backlog.
- **Row rules on hidden fields.** A policy whose row rule tests a hidden field
  (`{ salary: { _lt: 1000 } }`) shows which rows pass. The policy author chose
  that; it is not caller input.

## Rules for new code

- Any new caller-supplied filter, sort, cursor or aggregate goes through
  `ItemService.list` or calls `findUnreadableQueryField` itself, before the query.
- `_contains`-family values go through `apps/cms/src/services/like-pattern.ts`,
  never raw `'%' + value + '%'`.
- A cursor must encode only structural columns, or fields the caller can read,
  and must be validated against the guard when it is decoded.
