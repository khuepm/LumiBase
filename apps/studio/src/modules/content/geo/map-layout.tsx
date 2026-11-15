import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Marker } from 'maplibre-gl';
import type { FieldResource, ItemFilter } from '@lumibase/sdk';
import { isGeoPoint, type GeoBBox, type GeoPoint } from '@lumibase/contracts/field';
import { getApiClient } from '@/lib/api';
import { formatPoint, resolveMapStyleUrl, wrapLongitude } from './map-config';
import { useMaplibre } from './use-maplibre';

/** Most markers one Map view loads; narrow with "Only this area" or filters. */
export const MAP_LAYOUT_LIMIT = 200;

export function geopointFields(fields: readonly FieldResource[]): FieldResource[] {
  return fields.filter((f) => f.type === 'geopoint');
}

/**
 * Filter the Map layout sends: the list's own filter, rows that have a point,
 * and — when "Only this area" is on — the visible map bounds as
 * `_within_bbox` (computed in SQL on the server, see #746).
 */
export function buildMapFilter(base: ItemFilter | undefined, field: string, bbox: GeoBBox | null): ItemFilter {
  const clauses: ItemFilter[] = [];
  if (base && Object.keys(base).length > 0) clauses.push(base);
  clauses.push({ [field]: { _nnull: true } });
  if (bbox) clauses.push({ [field]: { _within_bbox: bbox } });
  return clauses.length === 1 ? clauses[0]! : { _and: clauses };
}

/** Map bounds → bbox operand, clamped; a view wider than the world is "everything". */
export function boundsToBBox(west: number, south: number, east: number, north: number): GeoBBox {
  const minLat = Math.max(-90, south);
  const maxLat = Math.min(90, north);
  if (east - west >= 360) return [-180, minLat, 180, maxLat];
  return [wrapLongitude(west), minLat, wrapLongitude(east), maxLat];
}

interface MapRow {
  id: string;
  label: string;
  point: GeoPoint;
}

interface MapLayoutProps {
  collection: string;
  fields: FieldResource[];
  filter: ItemFilter | undefined;
  enabled: boolean;
}

/**
 * "Map" list layout (#746): one marker per item with a geopoint; clicking a
 * marker (or a row in the list beside it) opens the item. Shown by the items
 * list only for collections that have a geopoint field.
 */
export function MapLayout({ collection, fields, filter, enabled }: MapLayoutProps) {
  const client = getApiClient();
  const navigate = useNavigate();
  const geoFields = useMemo(() => geopointFields(fields), [fields]);
  const [geoField, setGeoField] = useState(geoFields[0]?.name ?? '');
  const [onlyArea, setOnlyArea] = useState(false);
  const [bbox, setBbox] = useState<GeoBBox | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const fittedRef = useRef(false);
  const field = geoFields.find((f) => f.name === geoField) ?? geoFields[0];
  const { status, map, lib } = useMaplibre(containerRef, resolveMapStyleUrl(field));

  // A label field: the first visible string field, else the id.
  const labelField = useMemo(
    () => fields.find((f) => !f.hidden && (f.type === 'string' || f.type === 'text'))?.name,
    [fields],
  );

  const mapFilter = useMemo(
    () => (field ? buildMapFilter(filter, field.name, onlyArea ? bbox : null) : undefined),
    [filter, field, onlyArea, bbox],
  );

  const query = useQuery({
    queryKey: ['items', collection, 'map', mapFilter],
    queryFn: () =>
      client.items(collection as never).list({ filter: mapFilter, limit: MAP_LAYOUT_LIMIT, sort: ['-updated_at'] }),
    enabled: enabled && Boolean(field),
  });

  const rows: MapRow[] = useMemo(() => {
    if (!field) return [];
    const out: MapRow[] = [];
    for (const row of query.data?.data ?? []) {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const point = data[field.name];
      if (!isGeoPoint(point)) continue;
      const label = labelField && typeof data[labelField] === 'string' ? (data[labelField] as string) : row.id;
      out.push({ id: row.id, label, point });
    }
    return out;
  }, [query.data, field, labelField]);

  // Track the visible area for "Only this area".
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      setBbox(boundsToBBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()));
    };
    map.on('moveend', update);
    update();
    return () => {
      map.off('moveend', update);
    };
  }, [map]);

  // Markers.
  useEffect(() => {
    if (!map || !lib) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = rows.map((row) => {
      const marker = new lib.Marker().setLngLat([row.point.lng, row.point.lat]).addTo(map);
      const el = marker.getElement();
      el.style.cursor = 'pointer';
      el.setAttribute('role', 'link');
      el.setAttribute('aria-label', row.label);
      el.title = row.label;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        void navigate({ to: '/content/$collection/$id', params: { collection, id: row.id } });
      });
      return marker;
    });
    // Frame the markers once, on the first load.
    if (!fittedRef.current && rows.length > 0) {
      fittedRef.current = true;
      const bounds = new lib.LngLatBounds();
      for (const row of rows) bounds.extend([row.point.lng, row.point.lat]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
    }
  }, [map, lib, rows, collection, navigate]);

  useEffect(
    () => () => {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
    },
    [],
  );

  if (!field) return null;
  const total = query.data?.meta?.total;

  return (
    <div className="space-y-2" data-testid="map-layout">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {geoFields.length > 1 && (
          <label className="flex items-center gap-1">
            Field
            <select
              aria-label="Geopoint field"
              value={field.name}
              onChange={(e) => {
                setGeoField(e.target.value);
                fittedRef.current = false;
              }}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {geoFields.map((f) => (
                <option key={f.id} value={f.name}>
                  {f.label ?? f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {status === 'ready' && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={onlyArea} onChange={(e) => setOnlyArea(e.target.checked)} className="accent-primary" />
            Only this area
          </label>
        )}
        <span>
          {rows.length} on map
          {total !== undefined && total > rows.length ? ` (first ${rows.length} of ${total} — narrow with filters or “Only this area”)` : ''}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
        <div
          ref={containerRef}
          data-testid="map-layout-canvas"
          className={status === 'unavailable' ? 'hidden' : 'h-[28rem] w-full overflow-hidden rounded-lg border'}
        />
        {status === 'unavailable' && (
          <p className="rounded-lg border p-3 text-sm text-muted-foreground" data-testid="map-layout-unavailable">
            The map cannot be shown here. Items with a location are listed instead.
          </p>
        )}
        <ul className="max-h-[28rem] space-y-1 overflow-auto rounded-lg border p-2 text-sm" aria-label="Items on the map">
          {query.isLoading && <li className="text-muted-foreground">Loading…</li>}
          {!query.isLoading && rows.length === 0 && <li className="text-muted-foreground">No items with a location match.</li>}
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <Link
                  to="/content/$collection/$id"
                  params={{ collection, id: row.id }}
                  className="block truncate text-primary hover:underline"
                >
                  {row.label}
                </Link>
                <button
                  type="button"
                  className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => map?.easeTo({ center: [row.point.lng, row.point.lat], zoom: Math.max(map.getZoom(), 12) })}
                  disabled={!map}
                >
                  {formatPoint(row.point)}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
