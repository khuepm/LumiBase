import { Crosshair, MapPin, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Marker } from 'maplibre-gl';
import { isGeoPoint, type GeoPoint } from '@lumibase/contracts/field';
import { parseCoordinate, resolveMapStyleUrl, roundPoint } from '../geo/map-config';
import { useMaplibre } from '../geo/use-maplibre';
import type { InterfaceComponent } from './types';

const PICK_ZOOM = 13;

/**
 * `geopoint` — `{ lat, lng }` editor (#746): a MapLibre map (click or drag the
 * marker), manual latitude/longitude entry, and "Use my location". The map is
 * lazy-loaded; without WebGL or when the chunk/tiles fail, the manual inputs
 * keep working on their own.
 */
export const GeopointInterface: InterfaceComponent<GeoPoint> = ({ value, field, disabled, onChange }) => {
  const point = isGeoPoint(value) ? value : null;
  const [latText, setLatText] = useState(point ? String(point.lat) : '');
  const [lngText, setLngText] = useState(point ? String(point.lng) : '');
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const styleUrl = resolveMapStyleUrl(field);
  const { status, map, lib } = useMaplibre(
    containerRef,
    styleUrl,
    point ? { center: [point.lng, point.lat], zoom: PICK_ZOOM } : undefined,
  );

  // Keep the text inputs in sync when the value changes from outside (map, reset).
  useEffect(() => {
    if (!point) return;
    setLatText((t) => (parseCoordinate(t, 90) === point.lat ? t : String(point.lat)));
    setLngText((t) => (parseCoordinate(t, 180) === point.lng ? t : String(point.lng)));
  }, [point?.lat, point?.lng]);

  const commit = (next: GeoPoint | null) => onChange(next ? roundPoint(next) : null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Map click → move the point.
  useEffect(() => {
    if (!map || disabled) return;
    const onClick = (e: { lngLat: { lat: number; lng: number } }) => commitRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, disabled]);

  // Marker mirrors the value.
  useEffect(() => {
    if (!map || !lib) return;
    if (!point) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const marker = new lib.Marker({ draggable: !disabled });
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        commitRef.current({ lat: ll.lat, lng: ll.lng });
      });
      markerRef.current = marker;
    }
    markerRef.current.setLngLat([point.lng, point.lat]).addTo(map);
    markerRef.current.setDraggable(!disabled);
  }, [map, lib, point?.lat, point?.lng, disabled]);

  const latValue = parseCoordinate(latText, 90);
  const lngValue = parseCoordinate(lngText, 180);
  const latInvalid = latText.trim() !== '' && latValue === null;
  const lngInvalid = lngText.trim() !== '' && lngValue === null;

  const onManual = (nextLat: string, nextLng: string) => {
    setLatText(nextLat);
    setLngText(nextLng);
    const lat = parseCoordinate(nextLat, 90);
    const lng = parseCoordinate(nextLng, 180);
    if (nextLat.trim() === '' && nextLng.trim() === '') {
      commit(null);
      return;
    }
    if (lat !== null && lng !== null) {
      commit({ lat, lng });
      map?.easeTo({ center: [lng, lat] });
    }
  };

  const geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
  const useMyLocation = () => {
    if (!geolocation) return;
    setLocating(true);
    setLocateError(null);
    geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        commit(next);
        map?.easeTo({ center: [next.lng, next.lat], zoom: Math.max(map.getZoom(), PICK_ZOOM) });
      },
      (err) => {
        setLocating(false);
        setLocateError(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const inputClass = 'w-32 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50';

  return (
    <div className="space-y-2" data-testid="geopoint-interface">
      <div
        ref={containerRef}
        data-testid="geopoint-map"
        aria-label="Map: click to place the point"
        className={status === 'unavailable' ? 'hidden' : 'h-64 w-full overflow-hidden rounded-md border'}
      />
      {status === 'unavailable' && (
        <p className="text-xs text-muted-foreground" data-testid="geopoint-map-unavailable">
          Map unavailable here — enter the coordinates below.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Lat
          <input
            inputMode="decimal"
            aria-label="Latitude"
            aria-invalid={latInvalid}
            disabled={disabled}
            value={latText}
            placeholder="-90 … 90"
            onChange={(e) => onManual(e.target.value, lngText)}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Lng
          <input
            inputMode="decimal"
            aria-label="Longitude"
            aria-invalid={lngInvalid}
            disabled={disabled}
            value={lngText}
            placeholder="-180 … 180"
            onChange={(e) => onManual(latText, e.target.value)}
            className={inputClass}
          />
        </label>
        {geolocation && (
          <button
            type="button"
            disabled={disabled || locating}
            onClick={useMyLocation}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
          >
            <Crosshair className="h-3.5 w-3.5" />
            {locating ? 'Locating…' : 'Use my location'}
          </button>
        )}
        {point && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setLatText('');
              setLngText('');
              commit(null);
            }}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>
      {(latInvalid || lngInvalid) && (
        <p className="text-xs text-destructive">Latitude must be between -90 and 90, longitude between -180 and 180.</p>
      )}
      {locateError && <p className="text-xs text-destructive">{locateError}</p>}
    </div>
  );
};
