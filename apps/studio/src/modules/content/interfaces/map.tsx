import { MapPin } from 'lucide-react';
import { useState } from 'react';
import type { InterfaceComponent } from './types';

interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

type GeoValue = GeoPoint | Record<string, unknown>;

function isPoint(value: unknown): value is GeoPoint {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as GeoPoint).type === 'Point' &&
    Array.isArray((value as GeoPoint).coordinates)
  );
}

/**
 * `map` — lightweight GeoJSON editor for `geometry` fields. Dependency-free:
 * exposes longitude/latitude inputs for the common Point case plus a raw
 * GeoJSON textarea for arbitrary geometries. (No tile/map library is bundled;
 * swap in a richer map by replacing this component without touching callers.)
 */
export const MapInterface: InterfaceComponent<GeoValue> = ({ value, disabled, onChange }) => {
  const point = isPoint(value) ? value : null;
  const [raw, setRaw] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [rawError, setRawError] = useState(false);

  const setPoint = (lng: number, lat: number) => {
    const next: GeoPoint = { type: 'Point', coordinates: [lng, lat] };
    onChange(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawError(false);
  };

  const lng = point ? point.coordinates[0] : 0;
  const lat = point ? point.coordinates[1] : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Lng
          <input
            type="number"
            step="any"
            disabled={disabled}
            value={point ? lng : ''}
            onChange={(e) => setPoint(Number(e.target.value), lat)}
            className="w-28 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Lat
          <input
            type="number"
            step="any"
            disabled={disabled}
            value={point ? lat : ''}
            onChange={(e) => setPoint(lng, Number(e.target.value))}
            className="w-28 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
          />
        </label>
      </div>

      <details className="group">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          Raw GeoJSON
        </summary>
        <textarea
          rows={5}
          disabled={disabled}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            if (e.target.value.trim() === '') {
              onChange(null);
              setRawError(false);
              return;
            }
            try {
              onChange(JSON.parse(e.target.value) as GeoValue);
              setRawError(false);
            } catch {
              setRawError(true);
            }
          }}
          placeholder='{ "type": "Point", "coordinates": [105.8, 21.0] }'
          className="mt-2 w-full rounded-md border bg-background px-2 py-1 font-mono text-xs disabled:opacity-50"
        />
        {rawError && <p className="text-xs text-destructive">Invalid GeoJSON.</p>}
      </details>
    </div>
  );
};
