---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T12:01:39.030Z
contentHash: a20c90d7a1acdcc4
codeVerified: 2026-11-15T12:01:39.030Z
codeVerifiedHash: a20c90d7a1acdcc4
codeVerifiedClaims: 20
---

# Timezone-Aware Datetime Fields

A `datetime` or `timestamp` field can opt into storing **the instant plus the IANA time zone it was entered in**. Use it for anything that happens "at 9:00 in Tokyo": events, store openings, scheduled broadcasts. Fields without the option keep their bare ISO string exactly as before.

## 1. Enabling the option

Set `timezone: true` in the field's `options` (Studio: Data model → field → Interface → **Timezone-aware**).

```json
{
  "name": "starts_at",
  "type": "datetime",
  "interface": "datetime",
  "options": { "timezone": true, "defaultTimezone": "Europe/London", "disambiguation": "compatible" }
}
```

| Option | Default | Meaning |
|---|---|---|
| `timezone` | `false` | Opt-in. Allowed on `datetime`, `dateTime` and `timestamp` only. |
| `defaultTimezone` | `UTC` | Zone used when a write carries no `tz` (a bare ISO string). |
| `disambiguation` | `compatible` | DST rule for wall-time input (see §4). |

The schema service rejects a bad option set with `422 INVALID_FIELD_OPTIONS`: `timezone` on another type, an unknown `defaultTimezone`, or an unknown `disambiguation`.

## 2. Stored and delivered shape

```json
{ "instant": "2026-03-08T07:30:00.000Z", "tz": "America/New_York", "offset": "-04:00" }
```

- `instant` — ISO-8601 in UTC. Filters and sort use it.
- `tz` — the IANA zone the value was authored in. Aliases are canonicalized (`US/Eastern` → `America/New_York`).
- `offset` — the UTC offset of `tz` at `instant`, recomputed by the server on every write. Historic local-mean-time offsets keep their seconds (`-04:56:02`).

REST, delivery and realtime return the object as stored. GraphQL types the field as `ZonedDateTime { instant, tz, offset }`. Typegen emits `{ instant: string; tz: string; offset: string }`, and the SDK exports the `ZonedDateTime` type.

## 3. Writing values

Every write is normalized to the stored shape. Accepted inputs:

| Input | Example | Result |
|---|---|---|
| Instant + zone | `{ "instant": "2026-07-01T10:00:00+02:00", "tz": "Europe/London" }` | Any offset is accepted; the stored `offset` is recomputed. |
| Wall time + zone | `{ "local": "2026-07-04T09:00", "tz": "America/New_York" }` | Resolved with the field's `disambiguation`, or a per-value `"disambiguation"`. |
| ISO string with offset | `"2026-01-01T00:00:00Z"` | Zone = `defaultTimezone` (else `UTC`). |
| ISO string without offset | `"2026-01-01T09:00"` | Wall time in `defaultTimezone`; rejected when no default is configured. |

Sending both `instant` and `local` is rejected. Zones are validated against `Intl.supportedValuesOf('timeZone')`; on a runtime without it, a built-in list of common zones is used. Fixed offsets such as `+05:00` are not zones and are rejected.

## 4. DST gaps and overlaps

A wall time can fall in a spring-forward gap (it never happens) or a fall-back overlap (it happens twice). The rule follows Temporal's `disambiguation`:

| Rule | Gap | Overlap |
|---|---|---|
| `compatible` (default) | shift forward by the gap length | earlier instant |
| `earlier` | shift backward by the gap length | earlier instant |
| `later` | shift forward by the gap length | later instant |
| `reject` | `NONEXISTENT_LOCAL_TIME` error | `AMBIGUOUS_LOCAL_TIME` error |

Examples with `compatible`:

| Input | Result |
|---|---|
| `2026-03-08T02:30` `America/New_York` (gap 02:00–03:00) | `03:30-04:00` = `07:30Z` |
| `2026-11-01T01:30` `America/New_York` (overlap) | `01:30-04:00` = `05:30Z` |
| `2026-10-04T02:15` `Australia/Lord_Howe` (30-minute gap) | `02:45+11:00` = `15:45Z` the day before |
| `2026-10-25T01:30` `Europe/London` (overlap) | `01:30+01:00` = `00:30Z` |

An instant input is never ambiguous, so the rule applies to wall-time input only.

## 5. Filtering and sorting

Comparison operators (`_eq`, `_neq`, `_in`, `_nin`, `_gt`, `_gte`, `_lt`, `_lte`) and sort on a timezone-aware field compare `instant` as `timestamptz`, never the wall time. A filter value may be an ISO string or a zoned object:

```json
{ "starts_at": { "_gte": { "local": "2026-03-08T00:00", "tz": "America/New_York" } } }
```

Values written before the option was enabled (bare strings) still filter and sort correctly: the filter expression falls back to the string when there is no `instant`. They switch to the new shape the next time they are saved.

## 6. Studio

- **Settings → Date & time** sets the per-user display zone (`users.preferences.timezone`, `PATCH /api/v1/me/preferences`). Empty means "follow the browser". Unknown zones are rejected.
- The date editor of a timezone-aware field has a zone picker. The wall time is edited in the value's own zone; a new value starts in the user's display zone. A hint shows the same instant in the user's zone, and a note explains when a DST gap moved the time.
- Lists (`formatted-date` display) show the instant in the user's display zone, with the original time and zone as a hint, e.g. `(Jul 4, 2026, 9:00 AM America/New_York (-04:00))`.

## 7. Implementation

| Concern | Location |
|---|---|
| Conversion, validation, DST rules | `packages/contracts/src/field/zoned-datetime.ts` |
| Write normalization | `apps/cms/src/services/validation.ts` |
| Option validation | `apps/cms/src/services/schema-service.ts` |
| Filter / sort on the instant | `apps/cms/src/services/item-service.ts`, `apps/cms/src/services/json-filter-cast.ts` |
| GraphQL type | `apps/cms/src/graphql/type-mapping.ts` |
| Studio editor / display / settings | `apps/studio/src/modules/content/interfaces/datetime.tsx`, `apps/studio/src/modules/content/displays/formatted-date.tsx`, `apps/studio/src/modules/settings/date-time-page.tsx` |

Only `Intl` is used, so the same code runs on Cloudflare Workers, Node and browsers. No migration is needed: values live in item JSON and the preference lives in `users.preferences`.
