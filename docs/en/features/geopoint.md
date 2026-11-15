---
version: 3
sourceLang: en
lastUpdated: 2026-11-15T11:57:28.932Z
contentHash: 9863d4c9c17ad1fa
codeVerified: 2026-11-15T11:57:28.932Z
codeVerifiedHash: 9863d4c9c17ad1fa
codeVerifiedClaims: 8
---

# Geopoint fields and the Map layout

A `geopoint` field stores one location per item: a latitude and a longitude in
WGS 84 degrees. Studio edits it on a map, the API filters on it by radius or by
bounding box, and collections with a geopoint field get a **Map** layout in the
items list. It works on plain Postgres — Cloudflare Workers (Hyperdrive) and
Docker alike — and uses PostGIS automatically when the extension is installed.

## Value

```json
{ "loc": { "lat": 21.0285, "lng": 105.8542 } }
```

| Rule | Detail |
|------|--------|
| Shape | Exactly `{ lat, lng }`. Extra keys, arrays, strings and GeoJSON are refused on write. |
| Range | `lat` in [-90, 90], `lng` in [-180, 180], both finite numbers. |
| Arrays | Every array form is longitude-first, as in GeoJSON and PostGIS (see `_within_bbox`). |
| Missing | A non-required geopoint may be `null`. |

Create the field with `type: "geopoint"` and `interface: "geopoint"` (Studio:
**Data model → field → Special → Geopoint**). The shared definitions — the
`GeoPoint` type, the zod schemas and the haversine helper — live in
`packages/contracts/src/field/geopoint.ts` and
`packages/contracts/src/schemas/geopoint.ts`, so the API, Studio and the SDK
validate the same way.

## Filtering

Two operators, used under the field key like every other filter operator:

| Operator | Operand | Matches |
|----------|---------|---------|
| `_near` | `{ "lat": n, "lng": n, "radius": metres }` | Items within `radius` metres (great-circle distance). `0 < radius <=` half the Earth's circumference. |
| `_within_bbox` | `[minLng, minLat, maxLng, maxLat]` | Items inside the box, edges included. `minLng > maxLng` is a box that crosses the antimeridian (±180°). |

```bash
# Within 2 km of Hoan Kiem lake
curl -G "$CMS/api/v1/items/places" \
  --data-urlencode 'filter={"loc":{"_near":{"lat":21.0288,"lng":105.8525,"radius":2000}}}'

# Bracket form
curl "$CMS/api/v1/items/places?filter[loc][_near][lat]=21.0288&filter[loc][_near][lng]=105.8525&filter[loc][_near][radius]=2000"
curl "$CMS/api/v1/items/places?filter[loc][_within_bbox]=105.7,20.9,106,21.1"
```

Both combine with `_and` / `_or` and with any other filter, and work in
GraphQL through the `filter` argument. An invalid operand, or a geo operator on
a field that is not a geopoint (or `json`), is `400 INVALID_FILTER`, decided
from the schema alone. The operator sits under the field key, so the
readable-field guard that refuses filters on hidden fields applies to it the
same way.

### How it is computed

The point is read out of the item's JSON (`data #>> '{loc,lat}'`) through the
same guarded numeric cast as the typed filters, so a malformed stored value
simply does not match — it never fails the query. Each `_near` is:

1. **Prefilter** — a latitude/longitude window around the circle (split in two
   across the antimeridian, all longitudes when it covers a pole). This is a
   plain range test on the guarded cast, so an expression index from
   `GET /api/v1/collections/{name}/index-advice?path=loc.lat&cast=numeric`
   serves it.
2. **Exact test** — haversine on a sphere of radius 6 371 008.7714 m; or,
   when PostGIS is installed, `ST_DWithin(geography, geography, radius, false)`.
   PostGIS computes on the same sphere, so both paths return the same rows
   (proven by `apps/cms/src/services/__tests__/geo-filter.db.integration.test.ts`).

PostGIS is detected once per process/isolate (re-checked every five minutes,
so `CREATE EXTENSION postgis` is picked up without a restart), in whatever
schema it was installed into. No migration is needed for either path.
Coordinates are rounded to 10 decimals (about 11 µm) before the trigonometry:
Postgres raises an error when a float product underflows, and rounding keeps
one stored point such as `lat: 1e-200` from breaking every query.

## Studio

### Map input

The geopoint input shows a map: click to place the point or drag the marker.
Latitude and longitude can also be typed (out-of-range values are flagged and
not saved), and **Use my location** fills them from the device. The map
library (`maplibre-gl`) is loaded only when a map is first shown, as its own
chunk. Without WebGL, or if the map cannot load, the typed inputs keep working
alone.

### Map layout

A collection with at least one geopoint field gets a **Table / Map** switch in
the items list. The Map layout puts up to 200 items on the map (newest first,
with the list's filters), lists them beside it, and opens an item when its
marker or row is clicked. **Only this area** re-queries with the visible bounds
as `_within_bbox`. With several geopoint fields, pick which one to plot.

### Map tiles and attribution

The default style is OpenFreeMap "Liberty" (`https://tiles.openfreemap.org/styles/liberty`):
free OpenStreetMap vector tiles that need no API key or account. Its
attribution — OpenFreeMap, © OpenMapTiles, data from OpenStreetMap — is part
of the style and shown by the map's attribution control, which Studio always
keeps on. Keep it visible when you change styles: OpenStreetMap data is ODbL
licensed and requires attribution.

To use other tiles, set either:

| Where | Setting |
|-------|---------|
| Whole Studio build | `VITE_MAP_STYLE_URL` at build time |
| One field | `options.mapStyleUrl` on the field |

The value must be an `https://` URL, a same-origin path (`/tiles/style.json`)
or `http://localhost`; anything else falls back to the default.

### Browser policies

- **CSP.** The CMS serves the Studio in Docker with `script-src 'self'` and
  `connect-src 'self' https:`. Tiles, glyphs and sprites are fetched over https,
  and MapLibre's worker is a same-origin file (Studio sets it with
  `setWorkerUrl`), so the policy needs no change. A style served over plain
  http from another host is blocked — serve it over https.
- **Geolocation.** The CMS `Permissions-Policy` allows `geolocation=(self)` so
  **Use my location** works when the Studio is served from the CMS; other
  origins and frames still get nothing, and the browser asks the person first.
- **Desktop / mobile shell.** The Tauri webview has no CSP, and the worker URL
  does not depend on an `http(s)` origin, so the map works under
  `tauri://localhost`. Geolocation depends on the platform webview's
  permissions; when it is refused, the input shows the error and typed
  coordinates still work.

## Multi-tenancy

Nothing new is shared between sites. Geopoint values live in each site's items
(`lumibase_items.data`), and the geo clauses are added to the same `WHERE` as
the `site_id` and collection scope, so a radius query never reaches another
site's rows. The only process-wide state is the PostGIS probe, which records
whether the database has the extension — a property of the database, not of a
tenant. Verified by the two-site case in
`apps/cms/src/services/__tests__/geo-filter.db.integration.test.ts`.

## Types

| Surface | Type |
|---------|------|
| SDK typegen | `{ lat: number; lng: number }` |
| SDK | `GeoPoint`; filter operators `_near`, `_within_bbox` |
| GraphQL | `GeoPoint { lat: Float!, lng: Float! }`; a malformed stored value reads as `null` |
| CSV export / import | The JSON text of the value |
