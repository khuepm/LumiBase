---
version: 2
lastUpdated: 2026-11-15T11:50:26.954Z
sourceLang: en
contentHash: c22413ed3db6af98
codeVerified: 2026-11-15T17:12:03.654Z
codeVerifiedHash: c22413ed3db6af98
codeVerifiedClaims: 8
---

# Field Value Options

Three small field options close common parity gaps with other headless CMSs:
a non-clearable single choice, a configurable text length, and a slug charset
policy. All three live in the field's `options` object, next to the
interface's own keys (`choices`, `placeholder`, `rows`, …), and are:

- **validated on schema write** — every field create, update, rename and schema
  apply runs the shared Zod schema in `packages/contracts/src/schemas/field-options.ts`
  (REST, config-as-code and MCP all go through `apps/cms/src/services/schema-service.ts`).
  An invalid option returns `422 INVALID_FIELD_OPTIONS` naming the field and key.
- **enforced on item write** — the validation pipeline in
  `apps/cms/src/services/validation.ts` runs inside `ItemService` for create,
  update, replace, bulk, revision revert, GraphQL mutations and MCP/agent tools.
  A violation returns `400 VALIDATION` with a message naming the field and limit.
- **opt-in** — a field without these keys behaves exactly as before.

In the Studio, open a field, go to **Interface → Value options**. The same
validation runs there, and **Save** stays disabled while an option is invalid.

## `allowClear` — non-clearable single choice

Applies to single-choice interfaces: `select-radio` and `select-dropdown`.

```json
{ "choices": [{ "value": "draft" }, { "value": "final" }], "allowClear": false }
```

| `allowClear` | Studio | API |
| --- | --- | --- |
| omitted / `true` (default) | radio shows **Clear selection** while a value is set; dropdown keeps its empty option | `null` / `""` accepted |
| `false` | no clear affordance once a value is set | an update that sets `null` or `""` on an item whose stored value is non-empty is rejected (`not_clearable`) |

Interplay with `required`:

- `required: true` already rejects an empty value on **every** write, so
  `allowClear` adds nothing there (the Studio hides the clear control for
  required fields either way).
- `required: false` + `allowClear: false` means "may start empty, but once
  chosen it can only be changed, never cleared". Creating an item without a
  value, and updating an item that is still empty, are both allowed.

Setting `allowClear` on any other interface is rejected on schema write.

## `minLength` / `maxLength` — text length

Applies to `string` and `text` fields (inputs, textareas, slugs, …).

```json
{ "maxLength": 2000, "minLength": 20 }
```

- Lengths are counted in **Unicode code points**, not UTF-16 units: an emoji
  such as `😀` or a precomposed Vietnamese letter such as `ệ` counts as **one**.
  The Studio counter uses the same count and no longer sets the browser's
  native `maxLength` attribute (which counts UTF-16 units and would block
  valid input).
- An empty string counts as "no value" for `minLength`; use `required` to
  forbid empty values.
- Bounds: integers, `minLength` ≥ 0, `maxLength` ≥ 1, both ≤ 1,000,000, and
  `minLength` ≤ `maxLength`.
- If the field declares a storage `length`, `maxLength` may not exceed it.
- On non-text field types the keys are accepted (they predate this feature as
  loose Studio hints) but not enforced.

Error example: `excerpt: Field "excerpt" must be at most 2000 characters (Unicode code points); received 2001.`

## `slug` — slug charset policy

Applies to `string` / `text` fields, typically with the `slug` interface.

```json
{ "slug": { "charset": "ascii", "lowercase": true, "separator": "-" } }
```

| Key | Values | Default |
| --- | --- | --- |
| `charset` | `ascii`, `unicode`, `custom` | — (required) |
| `pattern` | restricted pattern, only with `custom` | — |
| `lowercase` | `true` / `false` | `true` |
| `separator` | `-`, `_`, `.` | `-` |

- **`ascii`** — transliterates Latin diacritics, then keeps `[a-z0-9]` runs
  joined by the separator. Vietnamese folds correctly: `Tiếng Việt` →
  `tieng-viet`, `Đà Nẵng` → `da-nang`, `Straße` → `strasse`.
- **`unicode`** — keeps letters, numbers and combining marks of every script
  (Unicode classes `\p{L}`, `\p{N}`, `\p{M}`), NFC-normalised: `Tiếng Việt` →
  `tiếng-việt`, `東京 タワー` → `東京-タワー`.
- **`custom`** — generated like `unicode`, then must match `pattern`.

The Studio formats the slug on blur with the shared `slugify` from
`packages/contracts/src/field/slug.ts` and shows a hint when the value breaks
the policy. The API **validates, it does not rewrite**: a non-conforming slug
is rejected (`invalid_slug`) so the stored value is always what the client
sent. `slugify` is idempotent — running it on its own output changes nothing.

### Custom patterns are ReDoS-safe

A custom `pattern` is never run by the backtracking regular-expression engine
against the whole value. It must use a restricted subset:

- allowed: literal characters, escaped punctuation, `.`, `\d \w \s` and their
  negations, `\p{…}` / `\P{…}`, bracket classes such as `[a-z0-9-]`, each
  optionally followed by one quantifier `* + ? {n} {n,} {n,m}` (bounds ≤ 100);
  a leading `^` and trailing `$` are accepted (the whole value must match
  anyway);
- rejected: groups `( )`, alternation `|`, backreferences, lookaround,
  `\b`, stacked quantifiers such as `a**`, patterns longer than 200 characters
  or expanding beyond 512 matcher positions.

Each atom is compiled as a single-character test and the sequence is matched by
a Thompson-NFA simulation, so matching time is linear in the value length
(`O(length × positions)`) whatever the pattern. Patterns like `(a+)+$` are
rejected on schema write with a message saying why.

```json
{ "slug": { "charset": "custom", "pattern": "^[a-z]{2}/[a-z0-9-]+$" } }
```

### Default behaviour

Without `options.slug`, the API does not check slugs (unchanged), and the
Studio formats on blur as `ascii` / lowercase / `-` with an 80 code-point cap
(or `options.maxLength`). The Studio now also folds `đ`/`Đ` to `d` instead of
dropping it.
